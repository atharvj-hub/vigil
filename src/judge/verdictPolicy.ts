// Verdict policy — the false-alarm firewall (documentation/05-judgment.md):
//
//   | judge says              | vigil records                     |
//   |-------------------------|-----------------------------------|
//   | pass                    | pass                              |
//   | warn (any confidence)   | warn — yellow, non-gating         |
//   | fail, conf ≥ 0.8        | candidate fail → retry protocol   |
//   | fail, conf < 0.8        | warn, annotated low-confidence    |
//
// Pure: verdict in, outcome out. The orchestrator owns what happens next
// (retry, re-judge, rollup).

import type { JudgeVerdict } from "../types.js";

// Roadmap open question #1: tune against seeded-breakage runs. One constant,
// one place to tune.
export const CONFIDENCE_GATE = 0.8;

export type PolicyOutcome =
  /** Record pass — the caller keeps its own (deterministic) headline. */
  | { kind: "pass" }
  | { kind: "warn"; headline: string; lowConfidence: boolean }
  | { kind: "candidate-fail"; headline: string };

/** Map one judge verdict through the firewall table. */
export function applyPolicy(verdict: JudgeVerdict): PolicyOutcome {
  // isWellFormed (schema.ts) guarantees non-pass verdicts cite ≥1 reason; the
  // fallback text is defense in depth, not an expected path.
  const cited = verdict.reasons[0]?.summary ?? "judge flagged this page";

  if (verdict.status === "pass") return { kind: "pass" };
  if (verdict.status === "warn") {
    return { kind: "warn", headline: `judge: ${cited}`, lowConfidence: false };
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
