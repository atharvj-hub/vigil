// The judge's output contract — a zod mirror of JudgeVerdict (types.ts,
// documentation/08-data-models.md). generateObject enforces this at the
// provider level: the model cannot ramble, and a response that doesn't fit
// this shape never reaches vigil as a verdict (documentation/05-judgment.md).

import { z } from "zod";

export const JudgeReasonSchema = z.object({
  kind: z.enum(["console", "network", "render", "visual", "flow"]),
  summary: z.string().min(1),
  evidence: z.string().min(1),
});

// Forced first step, before the model may produce a verdict (doc 10 "Judge
// evidence interpretation contract"). Declared BEFORE `status` in the object
// below deliberately — structured-output generation fills fields in
// declaration order, so the model has to commit to specific answers about
// what it's looking at before it commits to pass/warn/fail. This is the
// entire mechanism: no new model capability, just no way to skip the
// question. vigil's code never reads this to override the verdict (doc 10
// non-goals) — it exists for the model's own reasoning and for a human
// reading the report to cross-check by eye.
export const RenderAssessmentSchema = z.object({
  loadingIndicatorVisible: z.boolean(),
  meaningfulContentRendered: z.boolean(),
  pageStillLoading: z.boolean(),
  visualEvidence: z.string().min(1),
});

export const JudgeVerdictSchema = z.object({
  renderAssessment: RenderAssessmentSchema,
  status: z.enum(["pass", "warn", "fail"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(JudgeReasonSchema),
});

export type JudgeVerdictShape = z.infer<typeof JudgeVerdictSchema>;

/**
 * A non-pass verdict with no cited reasons violates doc 08 invariant 2
 * (every reason must ground a claim in checkable evidence) and is treated as
 * a malformed response — the caller falls back to `unjudged` rather than
 * recording an unexplained red or yellow.
 */
export function isWellFormed(v: JudgeVerdictShape): boolean {
  if (v.status === "pass") return true;
  return v.reasons.length > 0;
}
