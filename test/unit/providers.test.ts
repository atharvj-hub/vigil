import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveJudgeModel, NoModelConfiguredError, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_GOOGLE_MODEL } from "../../src/judge/providers.js";

// vi.stubEnv sets an *empty string*, not "unset" — and the openai provider's
// own baseURL fallback treats "" as "explicitly set but invalid" rather than
// "absent", which throws on plain-OpenAI resolution. Manage env vars by
// deleting the keys directly so each test starts from a genuinely unset state.
const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_BASE_URL", "OPENAI_COMPATIBLE_MODEL"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("resolveJudgeModel", () => {
  it("throws NoModelConfiguredError when no explicit model and no env key is set", async () => {
    await expect(resolveJudgeModel()).rejects.toBeInstanceOf(NoModelConfiguredError);
  });

  it("an explicit model passed via config always wins, regardless of env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-fake-anthropic-key";
    const explicit = { modelId: "my-custom-model", specificationVersion: "v2" } as any;
    const resolved = await resolveJudgeModel(explicit);
    expect(resolved.provider).toBe("explicit");
    expect(resolved.modelId).toBe("my-custom-model");
    expect(resolved.model).toBe(explicit);
  });

  it("an explicit model as a bare string id is accepted as-is", async () => {
    const resolved = await resolveJudgeModel("anthropic/claude-haiku-4-5");
    expect(resolved.provider).toBe("explicit");
    expect(resolved.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("resolves Anthropic when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-fake-anthropic-key";
    const resolved = await resolveJudgeModel();
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.modelId).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("Anthropic wins over OpenAI and Google when multiple keys are set (first match)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-fake-anthropic-key";
    process.env.OPENAI_API_KEY = "sk-fake-openai-key";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "fake-google-key";
    const resolved = await resolveJudgeModel();
    expect(resolved.provider).toBe("anthropic");
  });

  it("falls back to OpenAI when only OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-fake-openai-key";
    const resolved = await resolveJudgeModel();
    expect(resolved.provider).toBe("openai");
    expect(resolved.modelId).toBe(DEFAULT_OPENAI_MODEL);
  });

  it("falls back to Google when only GOOGLE_GENERATIVE_AI_API_KEY is set", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "fake-google-key";
    const resolved = await resolveJudgeModel();
    expect(resolved.provider).toBe("google");
    expect(resolved.modelId).toBe(DEFAULT_GOOGLE_MODEL);
  });

  it("uses an OpenAI-compatible endpoint when OPENAI_BASE_URL is set without a plain OPENAI key path", async () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    const resolved = await resolveJudgeModel();
    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.modelId).toBe("gpt-4o-mini");
  });

  it("OPENAI_COMPATIBLE_MODEL overrides the default model id for compatible endpoints", async () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    process.env.OPENAI_COMPATIBLE_MODEL = "llava:latest";
    const resolved = await resolveJudgeModel();
    expect(resolved.modelId).toBe("llava:latest");
  });
});
