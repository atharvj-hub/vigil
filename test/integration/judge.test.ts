// End-to-end for the judge stage: the REAL pipeline (real Chromium, real
// captures, real CostMeter) with a mock LanguageModel injected via
// config.model.judge. The mock decides verdicts by page path, so every policy
// branch is exercised deterministically — no provider, no network, no spend.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
// @ts-expect-error — plain .mjs fixture, no type declarations needed
import { startFixture } from "../fixtures/app.mjs";
import { runSanity } from "../../src/index.js";
import type { PageResult, RunResult } from "../../src/types.js";
import type { JudgeVerdictShape } from "../../src/judge/schema.js";

let server: { close: (cb?: () => void) => void };
let base: string;
let reportDir: string;

beforeAll(async () => {
  const fx = await startFixture(0);
  server = fx.server;
  base = fx.url;
  reportDir = mkdtempSync(join(tmpdir(), "vigil-judge-e2e-"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(reportDir, { recursive: true, force: true });
});

const byPath = (r: RunResult, path: string): PageResult | undefined =>
  r.pages.find((p) => new URL(p.url).pathname === path);

// Tokens the mock reports per call — the meter's actual-cost inputs.
const IN_TOK = 2000;
const OUT_TOK = 100;

/** A mock judge that picks its verdict from the page path in the prompt. */
function mockJudge(decide: (path: string, call: number) => JudgeVerdictShape | Error) {
  const counts = new Map<string, number>();
  return new MockLanguageModelV3({
    modelId: "mock-judge",
    doGenerate: async (options) => {
      const texts = options.prompt
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text);
      const pageLine = texts.find((t) => t.startsWith("Page: "));
      if (!pageLine) throw new Error("mock judge: no 'Page:' line in prompt");
      const path = new URL(pageLine.split("\n")[0]!.slice("Page: ".length)).pathname;
      const call = (counts.get(path) ?? 0) + 1;
      counts.set(path, call);
      const verdict = decide(path, call);
      if (verdict instanceof Error) throw verdict;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(verdict) }],
        finishReason: "stop" as const,
        usage: {
          inputTokens: { total: IN_TOK, noCache: IN_TOK, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: OUT_TOK, text: OUT_TOK, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

const cleanAssessment = {
  loadingIndicatorVisible: false,
  meaningfulContentRendered: true,
  pageStillLoading: false,
  visualEvidence: "page rendered its normal content, no spinner",
};

const pass = (confidence = 0.95): JudgeVerdictShape => ({
  renderAssessment: cleanAssessment,
  status: "pass",
  confidence,
  reasons: [],
});
const fail = (confidence: number): JudgeVerdictShape => ({
  renderAssessment: {
    loadingIndicatorVisible: false,
    meaningfulContentRendered: false,
    pageStillLoading: false,
    visualEvidence: "the widget's mount point is empty",
  },
  status: "fail",
  confidence,
  reasons: [{ kind: "visual", summary: "widget failed to render", evidence: "empty region where the widget mounts" }],
});

// NOTE: discovery always includes the target URL "/" as an implicit config
// route, so every run judges one page more than `routes` lists. The mocks are
// path-keyed with "/" → pass so that extra page stays predictable.
function run(routes: string[], model: MockLanguageModelV3, over: Record<string, unknown> = {}) {
  return runSanity({
    url: base,
    discovery: { routes, sitemap: false, crawl: { enabled: false }, api: { enabled: false } },
    model: { judge: model },
    report: { dir: reportDir },
    ...over,
  });
}

/** Path-keyed decide with "/" (the implicit route) always passing. */
const forPath =
  (decide: (call: number) => JudgeVerdictShape | Error, path = "/about") =>
  (p: string, call: number): JudgeVerdictShape | Error =>
    p === path ? decide(call) : pass();

describe("judge stage — full pipeline with a mock model", () => {
  it("clean pages judged pass → HEALTHY, decidedBy judge, real cost accounting", async () => {
    const model = mockJudge(() => pass());
    const r = await run(["/about", "/pricing"], model);
    expect(r.verdict).toBe("HEALTHY");
    for (const path of ["/about", "/pricing"]) {
      const p = byPath(r, path)!;
      expect(p.status).toBe("pass");
      expect(p.decidedBy).toBe("judge");
      expect(p.judge?.status).toBe("pass");
      expect(p.cost.judgeUsd).toBeGreaterThan(0);
      expect(p.timings.judgeMs).toBeDefined();
    }
    expect(r.cost.modelCalls).toBe(3); // "/", "/about", "/pricing"
    expect(r.cost.modelUsd).toBeGreaterThan(0);
    expect(r.cost.modelUsd).toBeLessThanOrEqual(2.0); // the default cap, invariant 5
  }, 60_000);

  it("a confident judged fail gets one free recapture; a clean retry downgrades it to flaky warn — no re-judge call", async () => {
    // /about is a genuinely clean fixture page, so the free retry capture
    // comes back fully clean by hard rules — the judge's complaint doesn't
    // reproduce, so it's flaky, not confirmed.
    const model = mockJudge(forPath(() => fail(0.9)));
    const r = await run(["/about"], model);
    const p = byPath(r, "/about")!;
    expect(r.verdict).toBe("DEGRADED");
    expect(p.status).toBe("warn");
    expect(p.decidedBy).toBe("judge");
    expect(p.retried).toBe(true);
    expect(p.retrySignals).toBeDefined();
    expect(p.headline).toContain("passed on retry (flaky)");
    expect(p.judge?.status).toBe("fail");
    expect(r.cost.modelCalls).toBe(2); // "/" + the one /about judgment — no confirming re-judge
  }, 60_000);

  it("a confident judged fail stays a confirmed fail when the retry capture isn't clean — still no re-judge call", async () => {
    // /apifail deterministically reproduces a first-party API failure on
    // every visit, so the free retry capture comes back warn, not pass —
    // whatever the judge flagged is still there, so it's not flaky.
    const model = mockJudge(forPath(() => fail(0.9), "/apifail"));
    const r = await run(["/apifail"], model);
    const p = byPath(r, "/apifail")!;
    expect(r.verdict).toBe("BROKEN");
    expect(p.status).toBe("fail");
    expect(p.decidedBy).toBe("judge");
    expect(p.retried).toBe(true);
    expect(p.retrySignals).toBeDefined();
    expect(p.judge?.status).toBe("fail");
    expect(r.cost.modelCalls).toBe(2); // "/" + the one /apifail judgment — no confirming re-judge
  }, 60_000);

  it("a low-confidence fail is a warn, never retried, never red", async () => {
    const model = mockJudge(forPath(() => fail(0.6)));
    const r = await run(["/about"], model);
    const p = byPath(r, "/about")!;
    expect(r.verdict).toBe("DEGRADED");
    expect(p.status).toBe("warn");
    expect(p.retried).toBe(false);
    expect(p.headline).toContain("low confidence");
    expect(r.cost.modelCalls).toBe(2); // "/" + one judgment, no retry
  }, 60_000);

  it("budget cap 0 → every page unjudged (decidedBy budget), run DEGRADED, zero model calls", async () => {
    const model = mockJudge(() => pass());
    const r = await run(["/about", "/pricing"], model, { budgets: { maxModelCostUsd: 0 } });
    expect(r.verdict).toBe("DEGRADED");
    for (const path of ["/about", "/pricing"]) {
      const p = byPath(r, path)!;
      expect(p.status).toBe("warn"); // unjudged is yellow, never green
      expect(p.decidedBy).toBe("budget");
      expect(p.unjudged).toBe(true);
    }
    expect(r.budgetsExhausted).toContain("maxModelCostUsd");
    expect(r.cost.modelCalls).toBe(0);
    expect(r.cost.modelUsd).toBe(0);
  }, 60_000);

  it("provider outage → decidedBy error with the reason, run completes DEGRADED", async () => {
    const model = mockJudge(() => new Error("simulated provider outage")); // every page, incl "/"
    const r = await run(["/about"], model);
    const p = byPath(r, "/about")!;
    expect(r.verdict).toBe("DEGRADED");
    expect(p.status).toBe("warn");
    expect(p.decidedBy).toBe("error");
    expect(p.unjudged).toBe(true);
    expect(p.judgeError).toContain("unavailable");
  }, 60_000);

  it("hard rules keep absolute first say — a hard-failed page never reaches the judge", async () => {
    const model = mockJudge(() => pass());
    const r = await run(["/boom"], model);
    const p = byPath(r, "/boom")!;
    expect(r.verdict).toBe("BROKEN");
    expect(p.status).toBe("fail");
    expect(p.decidedBy).toBe("hard-rule");
    expect(p.hardRule).toBe("H2");
    expect(p.judge).toBeUndefined();
    expect(p.cost.judgeUsd).toBe(0);
    expect(r.cost.modelCalls).toBe(1); // only the implicit "/" was judged — never /boom
  }, 60_000);
});
