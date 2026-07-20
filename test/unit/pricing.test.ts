import { describe, it, expect } from "vitest";
import {
  MODEL_PRICES,
  FALLBACK_PRICE,
  EST_INPUT_TOKENS,
  EST_OUTPUT_TOKENS,
  RESERVE_SAFETY_FACTOR,
  priceFor,
  estimateJudgeCostUsd,
  actualCostUsd,
} from "../../src/judge/pricing.js";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_GOOGLE_MODEL } from "../../src/judge/providers.js";

describe("pricing", () => {
  it("every default judge model has a price entry (no default falls back)", () => {
    for (const id of [DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_GOOGLE_MODEL]) {
      expect(priceFor(id).known, `missing price for default model ${id}`).toBe(true);
    }
  });

  it("unknown model ids fall back to the conservative price", () => {
    const { price, known } = priceFor("some-future-model");
    expect(known).toBe(false);
    expect(price).toEqual(FALLBACK_PRICE);
  });

  it("estimate for the anthropic default matches the doc 05 worked math × safety factor", () => {
    const p = MODEL_PRICES["claude-haiku-4-5"]!;
    const expected =
      ((EST_INPUT_TOKENS * p.inUsdPerMTok + EST_OUTPUT_TOKENS * p.outUsdPerMTok) / 1e6) *
      RESERVE_SAFETY_FACTOR;
    expect(estimateJudgeCostUsd("claude-haiku-4-5")).toBeCloseTo(expected, 10);
    // Sanity: near the exit-criterion ceiling ($0.006), never wildly off it.
    expect(estimateJudgeCostUsd("claude-haiku-4-5")).toBeGreaterThan(0.003);
    expect(estimateJudgeCostUsd("claude-haiku-4-5")).toBeLessThan(0.01);
  });

  it("an unknown model reserves MORE than a known cheap one (conservative direction)", () => {
    expect(estimateJudgeCostUsd("mystery-model")).toBeGreaterThan(estimateJudgeCostUsd("gpt-5-mini"));
  });

  it("actual cost uses reported usage exactly for a known model", () => {
    const { usd, estimated } = actualCostUsd("claude-haiku-4-5", { inputTokens: 2000, outputTokens: 100 });
    expect(usd).toBeCloseTo((2000 * 1 + 100 * 5) / 1e6, 10);
    expect(estimated).toBe(false);
  });

  it("actual cost is flagged estimated when usage is missing or the model is unknown", () => {
    expect(actualCostUsd("claude-haiku-4-5", { inputTokens: undefined, outputTokens: 100 }).estimated).toBe(true);
    expect(actualCostUsd("who-knows", { inputTokens: 2000, outputTokens: 100 }).estimated).toBe(true);
  });

  it("actual cost never comes out below zero or NaN on missing usage", () => {
    const { usd } = actualCostUsd("who-knows", { inputTokens: undefined, outputTokens: undefined });
    expect(Number.isFinite(usd)).toBe(true);
    expect(usd).toBeGreaterThan(0);
  });
});
