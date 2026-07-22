// Verdict policy — the false-alarm firewall (documentation/05-judgment.md):
//
//   | judge says                                    | vigil records                    |
//   |------------------------------------------------|-----------------------------------|
//   | pass                                           | pass                              |
//   | warn (any confidence)                          | warn — yellow, non-gating         |
//   | fail, claims blank/not-loaded but render disagrees | warn — contradiction guard    |
//   | fail, conf ≥ 0.8                               | candidate fail — orchestrator retries with one free recapture (hard-rule check only, no re-judge) |
//   | fail, conf < 0.8                                | warn, annotated low-confidence    |
//
// Pure: verdict in, outcome out. The orchestrator owns what happens next
// (rollup; a candidate-fail here is what triggers the free retry-for-
// flakiness capture — see orchestrator.ts's visitOne).

import type { JudgeVerdict } from "../types.js";

// Roadmap open question #1: tune against seeded-breakage runs. One constant,
// one place to tune.
export const CONFIDENCE_GATE = 0.8;

export type PolicyOutcome =
  /** Record pass — the caller keeps its own (deterministic) headline. */
  | { kind: "pass" }
  | { kind: "warn"; headline: string; lowConfidence: boolean }
  | { kind: "candidate-fail"; headline: string };

/** The render-lane facts a contradiction check needs — a thin slice of Signals. */
export interface RenderContext {
  textLength: number;
  screenshotLooksBlank: boolean;
}

// Observed in practice: a judge citing "content not visible / failed to
// load" on a page whose own render signals show substantial rendered text
// and a non-blank screenshot. The model is contradicting evidence sitting in
// its own digest, not disagreeing about ambiguous evidence — worth a narrow,
// literal guard rather than trusting confidence alone.
const BLANK_CLAIM_RE = /not (visible|loading|rendering|showing)|failed to load|didn't load|blank (page|screen)/i;

/** Map one judge verdict through the firewall table. */
export function applyPolicy(verdict: JudgeVerdict, render?: RenderContext): PolicyOutcome {
  // isWellFormed (schema.ts) guarantees non-pass verdicts cite ≥1 reason; the
  // fallback text is defense in depth, not an expected path.
  const cited = verdict.reasons[0]?.summary ?? "judge flagged this page";

  if (verdict.status === "pass") return { kind: "pass" };
  if (verdict.status === "warn") {
    return { kind: "warn", headline: `judge: ${cited}`, lowConfidence: false };
  }

  const claimsBlank = verdict.reasons.some(
    (r) => r.kind === "visual" && BLANK_CLAIM_RE.test(`${r.summary} ${r.evidence}`)
  );
  if (render && claimsBlank && render.textLength > 200 && !render.screenshotLooksBlank) {
    return {
      kind: "warn",
      headline: `judge (contradicted by render signals): ${cited}`,
      lowConfidence: true,
    };
  }

  if (verdict.confidence >= CONFIDENCE_GATE) {
    return { kind: "candidate-fail", headline: `judge: ${cited}` };
  }
  return {
    kind: "warn",
    headline: `judge (low confidence ${verdict.confidence.toFixed(2)}): ${cited}`,
    lowConfidence: true,
  };
}
