import { describe, it, expect } from "vitest";
import { buildSummary, fmtDuration, pathOf, hostOf } from "../../src/reporter/index.js";
import type { RunResult } from "../../src/types.js";

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    runId: "2026-07-09T06-00-00_abcd",
    verdict: "BROKEN",
    target: { url: "https://app.example.com", deployRef: "4f9c21b" },
    startedAt: "2026-07-09T06:00:00.000Z",
    durationMs: 161_000,
    counts: { pass: 39, warn: 2, fail: 1, skipped: 0 },
    cost: { modelCalls: 0, modelUsd: 0 },
    budgetsExhausted: [],
    pages: [
      { url: "https://app.example.com/checkout", source: "sitemap", status: "fail", headline: "POST /api/payment → 500", decidedBy: "hard-rule", hardRule: "H2", retried: true, flaky: false, signals: {} as any, timings: { visitMs: 1 }, cost: { judgeUsd: 0, flowsUsd: 0 } },
      { url: "https://app.example.com/account", source: "crawl", status: "warn", headline: "console error from a widget", decidedBy: "hard-rule", retried: false, flaky: false, signals: {} as any, timings: { visitMs: 1 }, cost: { judgeUsd: 0, flowsUsd: 0 } },
      { url: "https://app.example.com/", source: "config", status: "pass", headline: "clean", decidedBy: "hard-rule", retried: false, flaky: false, signals: {} as any, timings: { visitMs: 1 }, cost: { judgeUsd: 0, flowsUsd: 0 } },
    ],
    artifactsDir: "vigil-report/2026-07-09T06-00-00_abcd",
    ...over,
  };
}

describe("buildSummary", () => {
  it("headlines the verdict, host, deploy, and counts", () => {
    const s = buildSummary(result());
    expect(s).toContain("vigil · BROKEN · app.example.com · deploy 4f9c21b");
    expect(s).toContain("1 failed · 39 passed · 2 warned");
  });
  it("lists fails before warns, each with its path and headline", () => {
    const s = buildSummary(result());
    const failIdx = s.indexOf("/checkout");
    const warnIdx = s.indexOf("/account");
    expect(failIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(failIdx);
    expect(s).toMatch(/❌ \*\*\/checkout\*\*/);
    expect(s).toMatch(/⚠️ \*\*\/account\*\*/);
  });
  it("notes exhausted budgets when present", () => {
    expect(buildSummary(result({ budgetsExhausted: ["maxModelCostUsd"] }))).toContain("budgets exhausted: maxModelCostUsd");
  });
});

describe("formatting helpers", () => {
  it("fmtDuration renders seconds and minutes", () => {
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(161_000)).toBe("2m 41s");
  });
  it("pathOf returns path + query, hostOf returns the host", () => {
    expect(pathOf("https://a.com/x/y?z=1")).toBe("/x/y?z=1");
    expect(hostOf("https://a.com:8080/x")).toBe("a.com:8080");
  });
});
