import { describe, it, expect } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { callJudgeModel, ModelUnavailableError, MalformedVerdictError } from "../../src/judge/modelGateway.js";
import { buildJudgePrompt } from "../../src/judge/prompt.js";
import type { ResolvedModel } from "../../src/judge/providers.js";
import { actualCostUsd } from "../../src/judge/pricing.js";

const MODEL_ID = "claude-haiku-4-5";
const IN_TOK = 2000;
const OUT_TOK = 100;

const cleanAssessment = {
  loadingIndicatorVisible: false,
  meaningfulContentRendered: true,
  pageStillLoading: false,
  visualEvidence: "page rendered, error toast overlays otherwise-normal content",
};

const goodVerdict = {
  renderAssessment: cleanAssessment,
  status: "fail",
  confidence: 0.95,
  reasons: [{ kind: "network", summary: "Payment API returned 500", evidence: "POST /api/payment/intent -> 500" }],
};

function generateResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    finishReason: "stop" as const,
    usage: {
      inputTokens: { total: IN_TOK, noCache: IN_TOK, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: OUT_TOK, text: OUT_TOK, reasoning: 0 },
    },
    warnings: [],
  };
}

function resolved(model: MockLanguageModelV3): ResolvedModel {
  return { model, modelId: MODEL_ID, provider: "anthropic" };
}

const prompt = buildJudgePrompt({
  screenshot: new Uint8Array([1, 2, 3]),
  digestJson: "{}",
  url: "https://app.example.com/x",
  origin: "https://app.example.com",
});

const perCallUsd = actualCostUsd(MODEL_ID, { inputTokens: IN_TOK, outputTokens: OUT_TOK }).usd;

describe("callJudgeModel", () => {
  it("returns the parsed verdict with exact cost from reported usage", async () => {
    const model = new MockLanguageModelV3({ modelId: MODEL_ID, doGenerate: generateResult(goodVerdict) });
    const result = await callJudgeModel(prompt, resolved(model), { backoffMs: 0 });
    expect(result.verdict).toEqual(goodVerdict);
    expect(result.usd).toBeCloseTo(perCallUsd, 10);
    expect(result.estimated).toBe(false);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("retries once on a transport failure and succeeds", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      modelId: MODEL_ID,
      doGenerate: async () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        return generateResult(goodVerdict);
      },
    });
    const result = await callJudgeModel(prompt, resolved(model), { backoffMs: 0 });
    expect(calls).toBe(2);
    expect(result.verdict).toEqual(goodVerdict);
    expect(result.usd).toBeCloseTo(perCallUsd, 10); // only the successful attempt billed
  });

  it("throws ModelUnavailableError after two transport failures", async () => {
    const model = new MockLanguageModelV3({
      modelId: MODEL_ID,
      doGenerate: async () => {
        throw new Error("provider is down");
      },
    });
    const err = await callJudgeModel(prompt, resolved(model), { backoffMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err.usdSoFar).toBe(0); // nothing was ever billed
  });

  it("throws MalformedVerdictError when the verdict is non-pass with zero reasons, carrying billed cost", async () => {
    const malformed = { renderAssessment: cleanAssessment, status: "fail", confidence: 0.9, reasons: [] };
    const model = new MockLanguageModelV3({ modelId: MODEL_ID, doGenerate: generateResult(malformed) });
    const err = await callJudgeModel(prompt, resolved(model), { backoffMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedVerdictError);
    // Both attempts reached the provider and billed tokens.
    expect(err.usdSoFar).toBeCloseTo(2 * perCallUsd, 10);
  });

  it("throws MalformedVerdictError on schema-invalid output (confidence out of range)", async () => {
    const invalid = { renderAssessment: cleanAssessment, status: "pass", confidence: 2.3, reasons: [] };
    const model = new MockLanguageModelV3({ modelId: MODEL_ID, doGenerate: generateResult(invalid) });
    const err = await callJudgeModel(prompt, resolved(model), { backoffMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedVerdictError);
    // The SDK reports usage on NoObjectGeneratedError — billed attempts are still counted.
    expect(err.usdSoFar).toBeCloseTo(2 * perCallUsd, 10);
  });

  it("a malformed first attempt can be rescued by a clean retry", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      modelId: MODEL_ID,
      doGenerate: async () => {
        calls++;
        return generateResult(
          calls === 1 ? { renderAssessment: cleanAssessment, status: "warn", confidence: 0.5, reasons: [] } : goodVerdict
        );
      },
    });
    const result = await callJudgeModel(prompt, resolved(model), { backoffMs: 0 });
    expect(result.verdict).toEqual(goodVerdict);
    expect(result.usd).toBeCloseTo(2 * perCallUsd, 10); // both attempts billed
  });
});
