import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { judgePage, ScreenshotUnreadableError } from "../../src/judge/judge.js";
import type { ResolvedModel } from "../../src/judge/providers.js";
import type { Signals } from "../../src/types.js";

const goodVerdict = {
  status: "pass",
  confidence: 0.9,
  reasons: [],
};

function generateResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    finishReason: "stop" as const,
    usage: {
      inputTokens: { total: 2000, noCache: 2000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
    warnings: [],
  };
}

function signals(screenshotPath: string, over: Partial<Signals> = {}): Signals {
  return {
    url: "https://app.example.com/checkout",
    finalUrl: "https://app.example.com/checkout",
    document: { status: 200, redirects: [], loadMs: 400, settledMs: 900 },
    requests: [],
    captureTimeline: [],
    console: [],
    pageErrors: [],
    crashed: false,
    render: {
      textLength: 800,
      title: "Checkout",
      h1: "Checkout",
      textSample: "Your order",
      errorMarkersFound: [],
      spinnerStuck: false,
      screenshotLooksBlank: false,
      missingSelectors: [],
      notFoundMarkersFound: [],
    },
    contentFields: {},
    apiMatchedCount: 0,
    flows: [],
    screenshotPath,
    timedOut: false,
    ...over,
  };
}

async function withScreenshot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vigil-judge-"));
  const path = join(dir, "shot.png");
  await writeFile(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return path;
}

describe("judgePage", () => {
  it("reads the screenshot, sends digest + image, returns the gateway result", async () => {
    const path = await withScreenshot();
    const model = new MockLanguageModelV3({ modelId: "claude-haiku-4-5", doGenerate: generateResult(goodVerdict) });
    const resolved: ResolvedModel = { model, modelId: "claude-haiku-4-5", provider: "anthropic" };

    const result = await judgePage(signals(path), { resolved, origin: "https://app.example.com", backoffMs: 0 });
    expect(result.verdict).toEqual(goodVerdict);
    expect(result.usd).toBeGreaterThan(0);

    // The model actually received the screenshot bytes and the digest text.
    const call = model.doGenerateCalls[0]!;
    const userMsg = call.prompt.find((m) => m.role === "user")!;
    const parts = userMsg.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === "file")).toBe(true);
    expect(parts.some((p) => p.type === "text" && p.text!.includes('"status":200'))).toBe(true);
    expect(parts.some((p) => p.type === "text" && p.text!.includes("https://app.example.com/checkout"))).toBe(true);
  });

  it("passes fidelity warnings through into the digest the model sees", async () => {
    const path = await withScreenshot();
    const model = new MockLanguageModelV3({ modelId: "claude-haiku-4-5", doGenerate: generateResult(goodVerdict) });
    const resolved: ResolvedModel = { model, modelId: "claude-haiku-4-5", provider: "anthropic" };

    await judgePage(signals(path, { apiMatchedCount: 1 }), {
      resolved,
      origin: "https://app.example.com",
      fidelityWarnings: ['API field "title" missing from rendered page'],
      backoffMs: 0,
    });
    const parts = model.doGenerateCalls[0]!.prompt.find((m) => m.role === "user")!.content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === "text" && p.text!.includes("missing from rendered page"))).toBe(true);
  });

  it("throws ScreenshotUnreadableError when the screenshot cannot be read — never judges blind", async () => {
    const model = new MockLanguageModelV3({ modelId: "claude-haiku-4-5", doGenerate: generateResult(goodVerdict) });
    const resolved: ResolvedModel = { model, modelId: "claude-haiku-4-5", provider: "anthropic" };

    await expect(
      judgePage(signals("Z:\\does\\not\\exist\\shot.png"), { resolved, origin: "https://app.example.com", backoffMs: 0 })
    ).rejects.toBeInstanceOf(ScreenshotUnreadableError);
    expect(model.doGenerateCalls).toHaveLength(0); // the model was never called
  });
});
