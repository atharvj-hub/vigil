// Provider resolution — the one seam where vigil touches a specific AI vendor
// (documentation/05-judgment.md "Model choice (agnostic, with sane
// defaults)"). Provider packages are optional dependencies and imported only
// when their env var is present, so a user who only has an ANTHROPIC_API_KEY
// never needs @ai-sdk/openai or @ai-sdk/google installed at all.
//
// Resolution order:
//   1. an explicit LanguageModel passed via config.model.judge — full escape
//      hatch, vigil never second-guesses it.
//   2. ANTHROPIC_API_KEY → OPENAI_API_KEY → GOOGLE_GENERATIVE_AI_API_KEY, first match.
//   3. OPENAI_BASE_URL (+ an API key) → OpenAI-compatible endpoint (vLLM, Ollama, etc).
//   4. nothing resolvable → NoModelConfiguredError (operational failure, CLI exit 4).

import type { LanguageModel } from "ai";

export class NoModelConfiguredError extends Error {
  constructor() {
    super(
      "No judge model configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or " +
        "GOOGLE_GENERATIVE_AI_API_KEY, pass model.judge explicitly, or run with --no-judge."
    );
    this.name = "NoModelConfiguredError";
  }
}

export type ProviderName = "explicit" | "anthropic" | "openai" | "google" | "openai-compatible";

export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  provider: ProviderName;
}

// Default-tier judge models per provider (doc 05: cheap, fast, vision-capable,
// structured output). Single named constants — the roadmap's open question #1
// ("tune the default") is then a one-line change, not a search-and-replace.
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
// A dated model id ("gemini-2.5-flash") can be retired for new accounts out
// from under vigil with no warning — confirmed live: a fresh Google AI Studio
// key got "this model is no longer available to new users" while the model
// list endpoint still listed it. The "-latest" alias is Google's own answer
// to exactly this — it always resolves to whatever's current, so vigil's
// default doesn't go stale as the Gemini lineup moves forward. Has its own
// price entry in pricing.ts (carried over from gemini-2.5-flash) so the cost
// reservation stays accurate rather than falling back to the conservative
// unknown-model estimate.
export const DEFAULT_GOOGLE_MODEL = "gemini-flash-latest";

/** Resolve the judge model: explicit config wins, then env auto-detection. */
export async function resolveJudgeModel(explicit?: LanguageModel): Promise<ResolvedModel> {
  if (explicit !== undefined) {
    return { model: explicit, modelId: modelIdOf(explicit), provider: "explicit" };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return { model: anthropic(DEFAULT_ANTHROPIC_MODEL), modelId: DEFAULT_ANTHROPIC_MODEL, provider: "anthropic" };
  }

  if (process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return { model: openai(DEFAULT_OPENAI_MODEL), modelId: DEFAULT_OPENAI_MODEL, provider: "openai" };
  }

  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
    return { model: google(DEFAULT_GOOGLE_MODEL), modelId: DEFAULT_GOOGLE_MODEL, provider: "google" };
  }

  // OpenAI-compatible endpoint (vLLM, Ollama, any /v1/chat/completions server).
  // A base URL with no key is common for local servers, so the key is optional here.
  if (process.env.OPENAI_BASE_URL) {
    const modelId = process.env.OPENAI_COMPATIBLE_MODEL ?? "gpt-4o-mini";
    const { createOpenAI } = await import("@ai-sdk/openai");
    const compatible = createOpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY ?? "unused",
    });
    return { model: compatible(modelId), modelId, provider: "openai-compatible" };
  }

  throw new NoModelConfiguredError();
}

function modelIdOf(model: LanguageModel): string {
  if (typeof model === "string") return model;
  return model.modelId;
}
