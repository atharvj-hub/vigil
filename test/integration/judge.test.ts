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

const pass = (confidence = 0.95): JudgeVerdictShape => ({ status: "pass", confidence, reasons: [] });
const fail = (confidence: number): JudgeVerdictShape => ({
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

  it("a confident judged fail is confirmed by re-judge → BROKEN with both verdict runs", async () => {
    const model = mockJudge(forPath(() => fail(0.9)));
    const r = await run(["/about"], model);
    const p = byPath(r, "/about")!;
    expect(r.verdict).toBe("BROKEN");
    expect(p.status).toBe("fail");
    expect(p.decidedBy).toBe("judge");
    expect(p.retried).toBe(true);
    expect(p.retrySignals).toBeDefined();
    expect(p.judge?.status).toBe("fail");
    expect(r.cost.modelCalls).toBe(3); // "/" + first judgment + confirming re-judge
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

  it("fail on first judgment, pass on re-judge → warn (flaky)", async () => {
    const model = mockJudge(forPath((call) => (call === 1 ? fail(0.9) : pass())));
    const r = await run(["/about"], model);
    const p = byPath(r, "/about")!;
    expect(p.status).toBe("warn");
    expect(p.flaky).toBe(true);
    expect(p.retried).toBe(true);
    expect(p.headline).toContain("flaky");
    expect(r.verdict).toBe("DEGRADED");
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

  it("budget runs out between first judgment and re-judge → warn, not red (zero false reds)", async () => {
    // concurrency 1 → deterministic order: "/" (pass, ~$0.0075 committed),
    // then "/about" (fail 0.9, ~$0.0075 committed). The confirming re-judge
    // needs spent ($0.015) + reserve (~$0.0173) ≤ cap — denied at $0.03.
    const model = mockJudge(forPath(() => fail(0.9)));
    const r = await run(["/about"], model, { budgets: { maxModelCostUsd: 0.03, concurrency: 1 } });
    const p = byPath(r, "/about")!;
    expect(p.status).toBe("warn");
    expect(p.retried).toBe(true);
    expect(p.headline).toContain("retry went unjudged");
    expect(r.budgetsExhausted).toContain("maxModelCostUsd");
    expect(r.verdict).toBe("DEGRADED");
    expect(r.cost.modelCalls).toBe(2); // "/" + the first /about judgment
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
