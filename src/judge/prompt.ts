// Prompt assembly — one fixed scaffold, the evidence is the only variable
// (documentation/05-judgment.md "determinism discipline"). Pure: the caller
// supplies the screenshot bytes; this module never touches the filesystem.

import type { ModelMessage } from "ai";

// The doc 05 instruction, verbatim in essence. A single constant so prompt
// drift shows up as a one-line diff in review, never scattered edits.
export const JUDGE_SYSTEM_INSTRUCTION = `You are checking whether this web page is broken for a real user right now — not whether it is well-designed.

Broken means: error states visible on the page, content that clearly failed to load, layout catastrophically damaged, or the captured signals show the page's own functionality failing.

NOT broken: third-party analytics or ad failures, cosmetic imperfections, and intentional-looking emptiness (an empty cart is not a broken cart).

You are given the page's viewport screenshot (what the user sees) and a JSON digest of signals captured during the visit (document status, console errors, failed/slow requests labeled first-party vs third-party, render heuristics, flow outcomes). The screenshot is the primary evidence; the digest explains what happened underneath.

Respond with a verdict: status (pass | warn | fail), confidence (0-1), and reasons. Cite concrete evidence for every reason — a specific signal from the digest or a specific visible element in the screenshot. Never invent facts not present in the evidence. If the evidence is ambiguous, prefer "warn" and say why.`;

export interface JudgeEvidence {
  /** PNG bytes of the viewport screenshot. */
  screenshot: Uint8Array;
  /** Serialized SignalsDigest JSON. */
  digestJson: string;
  url: string;
  origin: string;
}

export interface JudgePrompt {
  /** The fixed system instruction (ai v7 wants this via the `instructions` option, not a system message). */
  instructions: string;
  messages: ModelMessage[];
}

/** Assemble the fixed multimodal prompt scaffold around one page's evidence. */
export function buildJudgePrompt(evidence: JudgeEvidence): JudgePrompt {
  return {
    instructions: JUDGE_SYSTEM_INSTRUCTION,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", mediaType: "image/png", data: evidence.screenshot },
          { type: "text", text: `Page: ${evidence.url}\nApp origin: ${evidence.origin}` },
          { type: "text", text: `Captured signals digest:\n${evidence.digestJson}` },
        ],
      },
    ],
  };
}
