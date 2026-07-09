import { describe, it, expect } from "vitest";
import { rollup, countStatuses } from "../../src/orchestrator.js";
import { exitCode } from "../../src/reporter/index.js";
import type { PageResult, PageStatus, HardRule } from "../../src/types.js";

function pr(status: PageStatus, opts: { hardRule?: HardRule } = {}): PageResult {
  return {
    url: "https://a.com/x",
    source: "config",
    status,
    headline: "",
    decidedBy: status === "fail" ? "hard-rule" : "hard-rule",
    hardRule: opts.hardRule,
    retried: status === "fail",
    flaky: false,
    signals: {} as any,
    timings: { visitMs: 1 },
    cost: { judgeUsd: 0, flowsUsd: 0 },
  };
}

describe("rollup", () => {
  it("all pass → HEALTHY", () => {
    expect(rollup([pr("pass"), pr("pass")], false)).toBe("HEALTHY");
  });
  it("any fail → BROKEN", () => {
    expect(rollup([pr("pass"), pr("fail", { hardRule: "H2" })], false)).toBe("BROKEN");
  });
  it("a warn → DEGRADED", () => {
    expect(rollup([pr("pass"), pr("warn")], false)).toBe("DEGRADED");
  });
  it("a skipped page → DEGRADED (never silently HEALTHY)", () => {
    expect(rollup([pr("pass"), pr("skipped")], false)).toBe("DEGRADED");
  });
  it("budget exhaustion forces at least DEGRADED", () => {
    expect(rollup([pr("pass"), pr("pass")], true)).toBe("DEGRADED");
  });
  it("environmental override: ≥50% H1 network failures → INCONCLUSIVE, over BROKEN", () => {
    expect(rollup([pr("fail", { hardRule: "H1" }), pr("fail", { hardRule: "H1" }), pr("pass")], false)).toBe("INCONCLUSIVE");
  });
  it("a single H1 among healthy pages is just BROKEN, not INCONCLUSIVE", () => {
    expect(rollup([pr("fail", { hardRule: "H1" }), pr("pass"), pr("pass"), pr("pass")], false)).toBe("BROKEN");
  });
});

describe("countStatuses", () => {
  it("tallies every status", () => {
    expect(countStatuses([pr("pass"), pr("pass"), pr("warn"), pr("fail", { hardRule: "H2" }), pr("skipped")])).toEqual({
      pass: 2,
      warn: 1,
      fail: 1,
      skipped: 1,
    });
  });
});

describe("exitCode (CI contract)", () => {
  it("maps verdicts to codes", () => {
    expect(exitCode("HEALTHY", "broken")).toBe(0);
    expect(exitCode("BROKEN", "broken")).toBe(1);
    expect(exitCode("INCONCLUSIVE", "broken")).toBe(3);
  });
  it("DEGRADED gates only when failOn is degraded", () => {
    expect(exitCode("DEGRADED", "broken")).toBe(0);
    expect(exitCode("DEGRADED", "degraded")).toBe(2);
  });
});
