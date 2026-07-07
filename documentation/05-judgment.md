# 05 — Judgment: evidence → verdict

Detection is easy; **deciding what the evidence means** is what determines whether anyone trusts
the tool. vigil's judgment layer is two stages: deterministic hard rules for the unambiguous,
one multimodal model call for everything else. No triage taxonomy, no healing — because with no
stored tests, "app broken vs. test stale" is a question that cannot arise. The only questions
left are "is this page broken?" and "are we sure?".

## Stage 1 — Hard-failure rules (no model, absolute authority)

Evaluated in order; first match fails the page with the rule as evidence:

| # | Rule | Why it's unambiguous |
|---|---|---|
| H1 | Navigation failed (DNS, refused, TLS, timeout with zero bytes) | nothing was served |
| H2 | Document status ≥ 500 | the server said so |
| H3 | Page crashed | the browser said so |
| H4 | Rendered text length < 40 chars AND no meaningful visual content (screenshot ≈ uniform) | blank screen with a 200 — the classic bundle-404 symptom |

Document status 404 on a *discovered* page is also a hard failure (H5) — a page the app itself
links to or lists in its sitemap should exist. (Config routes obviously too.)

These rules alone catch a large share of real post-deploy breakage, cost nothing, and can never
be second-guessed by the model.

## Stage 2 — The judge (one model call per page)

Everything not hard-failed gets exactly one structured call through the ModelGateway.

**Input:**
- the viewport screenshot (the primary evidence — the judge sees what a user sees)
- a compact signals digest (JSON, ~500–1500 tokens): document status, counts and first
  instances of console errors / failed requests / slow requests (first-party vs third-party
  labeled), render heuristics, flow outcomes, page title/h1, settle timings
- the page URL and the app's origin (context)

**Output — schema-enforced** (AI SDK `generateObject` + zod; the model cannot ramble):

```ts
{
  status: "pass" | "warn" | "fail",
  confidence: number,          // 0–1
  reasons: [{
    kind: "console" | "network" | "render" | "visual" | "flow",
    summary: string,           // one plain-English sentence
    evidence: string,          // must cite a concrete signal or visible element
  }],
}
```

**The judge's fixed instruction** (essence): *"You are checking whether this page is broken for
a real user right now — not whether it is well-designed. Broken means: error states visible,
content clearly failed to load, layout catastrophically damaged, or the captured signals show
the page's own functionality failing. Third-party analytics failures, cosmetic imperfections,
and intentional-looking emptiness (an empty cart is not a broken cart) are not failures. Cite
concrete evidence for every reason; if the evidence is ambiguous, prefer `warn` and say why."*

**Verdict policy (the false-alarm firewall):**

| Judge says | vigil records |
|---|---|
| `pass` | pass |
| `warn` (any confidence) | warn — yellow, non-gating by default |
| `fail`, confidence ≥ 0.8 | candidate fail → retry protocol |
| `fail`, confidence < 0.8 | warn, annotated `low-confidence` — a human look is requested, the pipeline is not blocked |

## The retry protocol (replacing flake machinery)

Any candidate `fail` — hard or judged — is retried **once**: brand-new browser context, fresh
visit, fresh capture, fresh judgment.

- **Pass on retry** → recorded `warn` with reason `flaky` (yellow). One-off blips don't block
  deploys, but they're never silent either.
- **Fail twice** → the failure stands. Both captures ship in the report.

This is the entire flake system. No strikes, no quarantine, no signature lists — those exist to
manage *persistently stored* flaky tests, and vigil has none.

## The environmental override

If ≥ 50% of visited pages hard-fail with network-type errors (H1), the problem is almost
certainly the runner's network or the target's edge — not the app. The run verdict becomes
**INCONCLUSIVE** (its own exit code), the report says "check the target/network," and no page
failures are attributed. A sanity tool must recognize when it, not the app, is having a bad day.

## Model choice (agnostic, with sane defaults)

All calls go through the AI SDK, so the judge is any vision-capable `LanguageModel`:

```ts
model: {
  judge: anthropic("claude-haiku-4-5"),      // default-tier example: cheap, fast, vision
  flows: anthropic("claude-sonnet-4-6"),     // agent steps benefit from a stronger model
}
// or openai(...), google(...), or any OpenAI-compatible endpoint (vLLM, Ollama) — one line.
```

Requirements for a judge model: vision input, structured output, and ideally sub-2-second
latency. Small models clear this bar in 2026; the judging task is deliberately narrow
("interpret this evidence"), not open-ended reasoning.

**Cost math, worked (Claude Haiku 4.5, $1/M input, $5/M output):**

| Item | Tokens | Cost |
|---|---|---|
| screenshot (1280×720) | ~1,100 | $0.0011 |
| signals digest + instruction | ~1,500 | $0.0015 |
| structured verdict out | ~250 | $0.0013 |
| **per page** | | **≈ $0.004** |

100-page app ≈ **$0.40/run**; 10 deploys/day ≈ $4/day ≈ **$120/month** at the *most* deploy-happy
end — and typically far less. Flows add ~$0.01–0.05 each. `maxModelCostUsd` (default $2/run)
hard-caps spend; on exhaustion remaining pages fall back to hard rules only and report
`unjudged` (yellow).

## Determinism discipline

The judge is a model, so absolute determinism is impossible — vigil bounds the blast radius:

- structured output (zod schema) — no free-text parsing,
- the confidence gate + retry above — a single wobbly judgment cannot block a pipeline,
- evidence citation required — every red in a report points at a signal or a visible element a
  human can verify in seconds,
- identical prompt scaffold per page — the only variables are the evidence itself.

## Worked examples

**A. JS chunk 404 → white screen.** Document 200, but three first-party chunk requests 404 and
rendered text = 0. H4 fires. Hard fail, retried, fails again → `fail`, evidence: the 404'd URLs
+ blank screenshot. No model needed.

**B. Payment API degraded.** `/checkout` renders, but signals show `POST /api/payment/intent`
→ 500 (first-party) and the screenshot shows an error toast. Judge: `fail`, confidence 0.97,
reasons cite the 500 and the visible toast. Retry fails identically → BROKEN with both captures.

**C. Marketing reworded the homepage.** No stored baseline exists to disagree with. Signals
clean, screenshot looks like a normal homepage → `pass`. The entire class of "the app changed,
tool cries wolf" false alarms is structurally impossible.

**D. Noisy console.** A page logs `console.error` from a third-party widget; everything else
clean, screenshot fine. Judge: `warn`, citing the error's third-party source. Yellow, visible,
non-blocking. (Recurring noise → user adds one allowlist regex.)

**E. Transient blip.** One page times out at the edge; retry loads in 1.8s, judged pass →
`warn (flaky)`. Deploy proceeds; the blip is on record.

Next: [06-reporting.md](06-reporting.md) — verdicts, artifacts, integrations.
