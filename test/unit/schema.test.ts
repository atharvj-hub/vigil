import { describe, it, expect } from "vitest";
import { JudgeVerdictSchema, isWellFormed } from "../../src/judge/schema.js";

describe("JudgeVerdictSchema", () => {
  it("accepts a well-formed pass with no reasons", () => {
    const parsed = JudgeVerdictSchema.safeParse({ status: "pass", confidence: 0.95, reasons: [] });
    expect(parsed.success).toBe(true);
  });

  it("accepts a well-formed fail with a grounded reason", () => {
    const parsed = JudgeVerdictSchema.safeParse({
      status: "fail",
      confidence: 0.97,
      reasons: [{ kind: "network", summary: "Payment API returned 500", evidence: "POST /api/payment/intent -> 500" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const parsed = JudgeVerdictSchema.safeParse({ status: "broken", confidence: 0.5, reasons: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects confidence outside [0,1]", () => {
    expect(JudgeVerdictSchema.safeParse({ status: "pass", confidence: 1.5, reasons: [] }).success).toBe(false);
    expect(JudgeVerdictSchema.safeParse({ status: "pass", confidence: -0.1, reasons: [] }).success).toBe(false);
  });

  it("rejects a reason with an unknown kind", () => {
    const parsed = JudgeVerdictSchema.safeParse({
      status: "warn",
      confidence: 0.6,
      reasons: [{ kind: "vibes", summary: "looks off", evidence: "the screenshot" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a reason with an empty summary or evidence", () => {
    expect(
      JudgeVerdictSchema.safeParse({
        status: "warn",
        confidence: 0.6,
        reasons: [{ kind: "visual", summary: "", evidence: "something" }],
      }).success
    ).toBe(false);
    expect(
      JudgeVerdictSchema.safeParse({
        status: "warn",
        confidence: 0.6,
        reasons: [{ kind: "visual", summary: "something", evidence: "" }],
      }).success
    ).toBe(false);
  });
});

describe("isWellFormed", () => {
  it("a pass is always well-formed, even with zero reasons", () => {
    expect(isWellFormed({ status: "pass", confidence: 0.9, reasons: [] })).toBe(true);
  });

  it("a warn or fail with zero reasons is NOT well-formed (doc 08 invariant 2)", () => {
    expect(isWellFormed({ status: "warn", confidence: 0.5, reasons: [] })).toBe(false);
    expect(isWellFormed({ status: "fail", confidence: 0.9, reasons: [] })).toBe(false);
  });

  it("a warn or fail with at least one reason is well-formed", () => {
    const reasons = [{ kind: "console" as const, summary: "x", evidence: "y" }];
    expect(isWellFormed({ status: "warn", confidence: 0.5, reasons })).toBe(true);
    expect(isWellFormed({ status: "fail", confidence: 0.9, reasons })).toBe(true);
  });
});
