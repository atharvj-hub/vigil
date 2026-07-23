import { describe, it, expect } from "vitest";
import { JudgeVerdictSchema, isWellFormed } from "../../src/judge/schema.js";

const cleanAssessment = {
  loadingIndicatorVisible: false,
  meaningfulContentRendered: true,
  pageStillLoading: false,
  visualEvidence: "page rendered its normal content, no spinner",
};

describe("JudgeVerdictSchema", () => {
  it("accepts a well-formed pass with no reasons", () => {
    const parsed = JudgeVerdictSchema.safeParse({
      renderAssessment: cleanAssessment,
      status: "pass",
      confidence: 0.95,
      reasons: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a well-formed fail with a grounded reason", () => {
    const parsed = JudgeVerdictSchema.safeParse({
      renderAssessment: cleanAssessment,
      status: "fail",
      confidence: 0.97,
      reasons: [{ kind: "network", summary: "Payment API returned 500", evidence: "POST /api/payment/intent -> 500" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const parsed = JudgeVerdictSchema.safeParse({
      renderAssessment: cleanAssessment,
      status: "broken",
      confidence: 0.5,
      reasons: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects confidence outside [0,1]", () => {
    expect(
      JudgeVerdictSchema.safeParse({ renderAssessment: cleanAssessment, status: "pass", confidence: 1.5, reasons: [] })
        .success
    ).toBe(false);
    expect(
      JudgeVerdictSchema.safeParse({ renderAssessment: cleanAssessment, status: "pass", confidence: -0.1, reasons: [] })
        .success
    ).toBe(false);
  });

  it("rejects a reason with an unknown kind", () => {
    const parsed = JudgeVerdictSchema.safeParse({
      renderAssessment: cleanAssessment,
      status: "warn",
      confidence: 0.6,
      reasons: [{ kind: "vibes", summary: "looks off", evidence: "the screenshot" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a reason with an empty summary or evidence", () => {
    expect(
      JudgeVerdictSchema.safeParse({
        renderAssessment: cleanAssessment,
        status: "warn",
        confidence: 0.6,
        reasons: [{ kind: "visual", summary: "", evidence: "something" }],
      }).success
    ).toBe(false);
    expect(
      JudgeVerdictSchema.safeParse({
        renderAssessment: cleanAssessment,
        status: "warn",
        confidence: 0.6,
        reasons: [{ kind: "visual", summary: "something", evidence: "" }],
      }).success
    ).toBe(false);
  });

  // doc 10 "Judge evidence interpretation contract": renderAssessment is the
  // forced pre-verdict step. It's required, not optional — a verdict that
  // skips it isn't schema-valid, so the model can't bypass the checklist.
  describe("renderAssessment (the forced pre-verdict checklist)", () => {
    it("rejects a verdict with no renderAssessment at all", () => {
      const parsed = JudgeVerdictSchema.safeParse({ status: "pass", confidence: 0.95, reasons: [] });
      expect(parsed.success).toBe(false);
    });

    it("rejects a renderAssessment missing any of the three booleans", () => {
      const { loadingIndicatorVisible, ...incomplete } = cleanAssessment;
      const parsed = JudgeVerdictSchema.safeParse({
        renderAssessment: incomplete,
        status: "pass",
        confidence: 0.95,
        reasons: [],
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects an empty visualEvidence string — a checklist answer with no cited evidence isn't grounded", () => {
      const parsed = JudgeVerdictSchema.safeParse({
        renderAssessment: { ...cleanAssessment, visualEvidence: "" },
        status: "pass",
        confidence: 0.95,
        reasons: [],
      });
      expect(parsed.success).toBe(false);
    });

    it("accepts any combination of the three booleans, as long as visualEvidence is present", () => {
      const parsed = JudgeVerdictSchema.safeParse({
        renderAssessment: {
          loadingIndicatorVisible: true,
          meaningfulContentRendered: false,
          pageStillLoading: true,
          visualEvidence: "black screen, spinner mid-animation",
        },
        status: "fail",
        confidence: 0.95,
        reasons: [{ kind: "visual", summary: "stuck loading", evidence: "spinner visible" }],
      });
      expect(parsed.success).toBe(true);
    });
  });
});

describe("isWellFormed", () => {
  it("a pass is always well-formed, even with zero reasons", () => {
    expect(isWellFormed({ renderAssessment: cleanAssessment, status: "pass", confidence: 0.9, reasons: [] })).toBe(true);
  });

  it("a warn or fail with zero reasons is NOT well-formed (doc 08 invariant 2)", () => {
    expect(isWellFormed({ renderAssessment: cleanAssessment, status: "warn", confidence: 0.5, reasons: [] })).toBe(false);
    expect(isWellFormed({ renderAssessment: cleanAssessment, status: "fail", confidence: 0.9, reasons: [] })).toBe(false);
  });

  it("a warn or fail with at least one reason is well-formed", () => {
    const reasons = [{ kind: "console" as const, summary: "x", evidence: "y" }];
    expect(isWellFormed({ renderAssessment: cleanAssessment, status: "warn", confidence: 0.5, reasons })).toBe(true);
    expect(isWellFormed({ renderAssessment: cleanAssessment, status: "fail", confidence: 0.9, reasons })).toBe(true);
  });
});
