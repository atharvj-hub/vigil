import { describe, it, expect } from "vitest";
import { JUDGE_SYSTEM_INSTRUCTION, buildJudgePrompt } from "../../src/judge/prompt.js";

const evidence = {
  screenshot: new Uint8Array([137, 80, 78, 71]),
  digestJson: '{"document":{"status":200}}',
  url: "https://app.example.com/checkout",
  origin: "https://app.example.com",
};

describe("judge prompt", () => {
  it("the fixed instruction covers the doc 05 essentials (drift guard)", () => {
    for (const essential of [
      "broken for a real user",
      "not whether it is well-designed",
      "Third-party analytics or ad failures",
      "an empty cart is not a broken cart",
      "concrete evidence",
      'prefer "warn"',
    ]) {
      expect(JUDGE_SYSTEM_INSTRUCTION.toLowerCase()).toContain(essential.toLowerCase());
    }
  });

  it("builds the fixed instructions + one multimodal user message, screenshot first", () => {
    const { instructions, messages } = buildJudgePrompt(evidence);
    expect(instructions).toBe(JUDGE_SYSTEM_INSTRUCTION);
    expect(messages).toHaveLength(1);
    const user = messages[0]!;
    expect(user.role).toBe("user");
    const parts = user.content as Array<{ type: string }>;
    expect(parts[0]!.type).toBe("file");
    expect((parts[0] as { mediaType: string }).mediaType).toBe("image/png");
    expect((parts[0] as { data: Uint8Array }).data).toBe(evidence.screenshot);
  });

  it("the scaffold is identical across pages — only the evidence varies", () => {
    const a = buildJudgePrompt(evidence);
    const b = buildJudgePrompt({ ...evidence, url: "https://app.example.com/other", digestJson: "{}" });
    expect(a.instructions).toBe(b.instructions);
    const shapeOf = (p: typeof a) => (p.messages[0]!.content as Array<{ type: string }>).map((x) => x.type);
    expect(shapeOf(a)).toEqual(shapeOf(b));
  });

  it("embeds the digest and page context verbatim in the text parts", () => {
    const { messages } = buildJudgePrompt(evidence);
    const texts = (messages[0]!.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text!);
    expect(texts.some((t) => t.includes(evidence.digestJson))).toBe(true);
    expect(texts.some((t) => t.includes(evidence.url) && t.includes(evidence.origin))).toBe(true);
  });
});
