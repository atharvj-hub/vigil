// Judge — one page's judgment: read the already-captured screenshot, compress
// the already-captured Signals, one gateway call, return the verdict + cost.
//
// Deliberately budget-blind: `judgePage(signals, ctx)` takes evidence, not
// money. The Orchestrator reserves against the CostMeter before calling this
// and commits/refunds after — so this module can never overspend, and its API
// stays exactly what the architecture promised (evidence in, verdict out).

import { readFile } from "node:fs/promises";
import type { Signals } from "../types.js";
import type { ResolvedModel } from "./providers.js";
import { buildDigest, serializeDigest } from "./digest.js";
import { buildJudgePrompt } from "./prompt.js";
import { callJudgeModel, type JudgeCallResult } from "./modelGateway.js";

/** The screenshot could not be read — the judge never fabricates missing evidence. */
export class ScreenshotUnreadableError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Screenshot unreadable at "${path}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ScreenshotUnreadableError";
    this.cause = cause;
  }
}

export interface JudgeContext {
  resolved: ResolvedModel;
  origin: string;
  /** Deterministic data-fidelity warn reasons, passed through into the digest. */
  fidelityWarnings?: string[];
  /** Gateway transient-retry backoff override. */
  backoffMs?: number;
}

/**
 * Judge one non-hard-failed page. Throws only typed errors
 * (ScreenshotUnreadableError | MalformedVerdictError | ModelUnavailableError);
 * the caller maps any of them to an `unjudged` page with decidedBy "error".
 */
export async function judgePage(signals: Signals, ctx: JudgeContext): Promise<JudgeCallResult> {
  let screenshot: Uint8Array;
  try {
    screenshot = await readFile(signals.screenshotPath);
  } catch (err) {
    throw new ScreenshotUnreadableError(signals.screenshotPath, err);
  }

  const digestJson = serializeDigest(buildDigest(signals, { fidelityWarnings: ctx.fidelityWarnings }));
  const prompt = buildJudgePrompt({
    screenshot,
    digestJson,
    url: signals.url,
    origin: ctx.origin,
  });

  return callJudgeModel(prompt, ctx.resolved, { backoffMs: ctx.backoffMs });
}
