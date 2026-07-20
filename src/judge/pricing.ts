// Model pricing — the single source of truth for both the CostMeter's
// pre-call reservation estimate and the gateway's actual-cost accounting.
//
// The reservation must never be a hardcoded dollar figure: if the judge model,
// prompt size, or provider changes, a fixed "$0.006" silently stops being an
// upper bound and the budget guarantee (doc 08 invariant 5) evaporates. Instead
// the estimate is derived from worked per-page token figures × the resolved
// model's price. Unknown model → conservative fallback prices, so vigil may
// over-reserve (leaving budget unused) but never under-reserves.

export interface ModelPrice {
  inUsdPerMTok: number;
  outUsdPerMTok: number;
}

// Prices for the default-tier judge models (doc 05 worked cost math). These are
// deliberately plain constants — a price change is a one-line edit here and
// nowhere else.
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { inUsdPerMTok: 1, outUsdPerMTok: 5 },
  "gpt-5-mini": { inUsdPerMTok: 0.25, outUsdPerMTok: 2 },
  "gemini-2.5-flash": { inUsdPerMTok: 0.3, outUsdPerMTok: 2.5 },
};

// Sonnet-tier prices: high enough to upper-bound any model someone would
// plausibly point the judge at without listing it above.
export const FALLBACK_PRICE: ModelPrice = { inUsdPerMTok: 3, outUsdPerMTok: 15 };

// Worked per-page token figures (doc 05): screenshot ~1,100 + digest and
// instruction ~1,500 in; structured verdict ~250 out.
export const EST_INPUT_TOKENS = 2_600;
export const EST_OUTPUT_TOKENS = 250;

// Headroom over the worked figures — absorbs a noisy page's larger digest and
// provider-side token-counting differences.
export const RESERVE_SAFETY_FACTOR = 1.5;

export function priceFor(modelId: string): { price: ModelPrice; known: boolean } {
  const price = MODEL_PRICES[modelId];
  return price ? { price, known: true } : { price: FALLBACK_PRICE, known: false };
}

/** Conservative pre-call reservation for one judge call against `modelId`. */
export function estimateJudgeCostUsd(modelId: string): number {
  const { price } = priceFor(modelId);
  const raw =
    (EST_INPUT_TOKENS * price.inUsdPerMTok + EST_OUTPUT_TOKENS * price.outUsdPerMTok) / 1_000_000;
  return raw * RESERVE_SAFETY_FACTOR;
}

export interface ActualCost {
  usd: number;
  /** true when the model id had no price entry or the provider omitted token counts — the figure is a conservative estimate, not an exact bill. */
  estimated: boolean;
}

/** Actual cost of a completed call from the provider-reported token usage. */
export function actualCostUsd(
  modelId: string,
  usage: { inputTokens: number | undefined; outputTokens: number | undefined }
): ActualCost {
  const { price, known } = priceFor(modelId);
  const inTok = usage.inputTokens ?? EST_INPUT_TOKENS;
  const outTok = usage.outputTokens ?? EST_OUTPUT_TOKENS;
  const usd = (inTok * price.inUsdPerMTok + outTok * price.outUsdPerMTok) / 1_000_000;
  return { usd, estimated: !known || usage.inputTokens === undefined || usage.outputTokens === undefined };
}
