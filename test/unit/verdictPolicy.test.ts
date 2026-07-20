import { describe, it, expect } from "vitest";
import { applyPolicy, CONFIDENCE_GATE } from "../../src/judge/verdictPolicy.js";
import type { JudgeVerdict } from "../../src/types.js";

const reason = { kind: "network" as const, summary: "Payment API returned 500", evidence: "POST /api/payment -> 500" };

const verdict = (status: JudgeVerdict["status"], confidence: number, reasons = [reason]): JudgeVerdict => ({
  status,
  confidence,
  reasons,
});

describe("applyPolicy — the firewall table", () => {
  it("pass → pass, regardless of confidence", () => {
    expect(applyPolicy(verdict("pass", 0.99, []))).toEqual({ kind: "pass" });
    expect(applyPolicy(verdict("pass", 0.1, []))).toEqual({ kind: "pass" });
  });

  it("warn → warn at any confidence, never gating", () => {
    for (const conf of [0.1, 0.5, 0.99]) {
      const out = applyPolicy(verdict("warn", conf));
      expect(out.kind).toBe("warn");
      expect((out as { lowConfidence: boolean }).lowConfidence).toBe(false);
    }
  });

  it("fail at the gate (0.80) → candidate fail", () => {
    const out = applyPolicy(verdict("fail", CONFIDENCE_GATE));
    expect(out.kind).toBe("candidate-fail");
    expect((out as { headline: string }).headline).toContain("Payment API returned 500");
  });

  it("fail just under the gate (0.79) → warn, annotated low-confidence", () => {
    const out = applyPolicy(verdict("fail", 0.79));
    expect(out.kind).toBe("warn");
    expect((out as { lowConfidence: boolean }).lowConfidence).toBe(true);
    expect((out as { headline: string }).headline).toContain("low confidence");
  });

  it("high-confidence fail → candidate fail with the cited reason as headline", () => {
    const out = applyPolicy(verdict("fail", 0.97));
    expect(out).toEqual({ kind: "candidate-fail", headline: "judge: Payment API returned 500" });
  });
});
