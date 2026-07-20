// ModelGateway — the ONLY code path that calls a model (documentation/
// 02-architecture.md hard rule). One structured call per page via
// generateObject, with a single transient retry and typed failure classes so
// the orchestrator can record WHY the judge didn't decide a page:
//
//   MalformedVerdictError   — the model responded but the verdict is unusable
//                             (schema mismatch, or a non-pass with zero cited reasons)
//   ModelUnavailableError   — transport-level failure (outage, timeout, 5xx)
//
// Both degrade the page to `unjudged` upstream; neither ever fails a run.
// Both carry `usdSoFar`: a malformed response still billed tokens, and the cost
// meter must commit real spend even when no verdict came back — refunding it
// would under-count against `maxModelCostUsd` (doc 08 invariant 5).
// Knows nothing about budgets — reservation/commit is the Orchestrator's job.

import { generateObject, NoObjectGeneratedError } from "ai";
import type { JudgeVerdict } from "../types.js";
import type { ResolvedModel } from "./providers.js";
import type { JudgePrompt } from "./prompt.js";
import { JudgeVerdictSchema, isWellFormed } from "./schema.js";
import { actualCostUsd } from "./pricing.js";

export class ModelUnavailableError extends Error {
  constructor(
    cause: unknown,
    readonly usdSoFar: number,
    readonly estimated: boolean
  ) {
    super(`Judge model unavailable: ${messageOf(cause)}`);
    this.name = "ModelUnavailableError";
    this.cause = cause;
  }
}

export class MalformedVerdictError extends Error {
  constructor(
    detail: string,
    readonly usdSoFar: number,
    readonly estimated: boolean
  ) {
    super(`Judge returned an unusable verdict: ${detail}`);
    this.name = "MalformedVerdictError";
  }
}

export interface JudgeCallResult {
  verdict: JudgeVerdict;
  usd: number;
  /** true when the cost figure is a conservative estimate (unknown model price or missing usage). */
  estimated: boolean;
  ms: number;
}

const TRANSIENT_RETRY_BACKOFF_MS = 250;

class MalformedAttempt extends Error {}

/** One structured judge call, with one transient retry. Throws typed errors only. */
export async function callJudgeModel(
  prompt: JudgePrompt,
  resolved: ResolvedModel,
  opts: { backoffMs?: number } = {}
): Promise<JudgeCallResult> {
  const t0 = Date.now();
  let usd = 0;
  let estimated = false;

  const attempt = async (): Promise<JudgeVerdict> => {
    const result = await generateObject({
      model: resolved.model,
      schema: JudgeVerdictSchema,
      instructions: prompt.instructions,
      messages: prompt.messages,
      // vigil's own transient retry below is the only retry loop.
      maxRetries: 0,
    });
    const cost = actualCostUsd(resolved.modelId, {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    usd += cost.usd;
    estimated = estimated || cost.estimated;
    const verdict = result.object;
    if (!isWellFormed(verdict)) {
      throw new MalformedAttempt(`status "${verdict.status}" with zero cited reasons`);
    }
    return verdict;
  };

  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, opts.backoffMs ?? TRANSIENT_RETRY_BACKOFF_MS));
    try {
      const verdict = await attempt();
      return { verdict, usd, estimated, ms: Date.now() - t0 };
    } catch (err) {
      lastErr = err;
      // A schema-invalid generation still consumed tokens; the SDK reports its
      // usage on the error. Account for it so the meter can commit real spend.
      if (NoObjectGeneratedError.isInstance(err) && err.usage) {
        const cost = actualCostUsd(resolved.modelId, {
          inputTokens: err.usage.inputTokens,
          outputTokens: err.usage.outputTokens,
        });
        usd += cost.usd;
        estimated = estimated || cost.estimated;
      }
    }
  }

  if (NoObjectGeneratedError.isInstance(lastErr) || lastErr instanceof MalformedAttempt) {
    throw new MalformedVerdictError(messageOf(lastErr), usd, estimated);
  }
  throw new ModelUnavailableError(lastErr, usd, estimated);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
