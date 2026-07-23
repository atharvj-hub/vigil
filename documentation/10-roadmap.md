# 10 — Roadmap, Risks, and Open Questions

## Build phases

Each phase ends with something a real project can run in its pipeline. The whole core is
~4–7 weeks because there is no cache/heal/store subsystem to build.

### Phase 1 — Capture & hard rules (no AI yet) · ~2 weeks
**Goal: `vigil run --url X` produces a genuinely useful verdict with zero model calls.**
- Orchestrator, budgets, worker pool, context isolation
- Discovery: config routes + sitemap + bounded crawl + normalization/sampling
- Collector: full Signals capture + settle protocol + screenshots
- Hard-failure rules H1–H5; retry protocol; environmental override
- Reporter: JSON, HTML, summary.md, exit codes; CLI (`run`, `discover`, `check`, `init`)
- **Exit criterion:** on 3 real apps, an injected chunk-404, an injected doc-500, and a blank
  render are each caught in < 90s with zero false reds across 50 clean runs.

Phase 1 is the trust foundation and already a shippable "smart smoke test".

### Phase 2 — The judge (DONE) · ~1–2 weeks
**Goal: the AI verdict layer, end to end.**
- ModelGateway (AI SDK), judge prompt + zod schema, confidence policy, cost metering,
  `maxModelCostUsd` enforcement, `unjudged` degradation, provider auto-detection from env
- Reporter surfaces judge confidence, reasons, decidedBy badges, and unjudged failure modes; CLI `--no-judge`
- **Exit criterion:** on dogfood apps with seeded breakages (error toast with 200s,
  half-rendered page, dead widget), judge catches ≥ 90% with zero false BROKENs across 100
  clean runs; per-page judge cost ≤ $0.006.

Phase 2 implements the full AI verdict layer behind a single orchestrator seam, keeping hard rules authoritative while bringing structured multimodal AI judgment to every clean-rendering page.

### Phase 3 — Auth & flows · ~1–2 weeks
**Goal: apps behind login, and NL interaction checks.**
- storageState reuse + scripted login + Stagehand agent login (credential injection, redaction)
- FlowRunner over Stagehand act/observe; safety denylist; flow outcomes into Signals/judgment
- **Exit criterion:** a real SaaS dogfood app behind auth runs green end to end; a seeded
  broken search is caught by a one-line flow.

### Phase 4 — Distribution · ~1–2 weeks
- GitHub Action; Slack reporter polish; MCP server (`run_sanity`, `check_page`) + agent skill
  docs; docs site; `npx vigil init` DX pass
- **Exit criterion:** a stranger goes zero→green in under 10 minutes from the README.

## Top risks and their mitigations

| Risk | Why it's real | Mitigation (designed in) |
|---|---|---|
| **False positives kill trust** | #1 reason such tools get abandoned | Hard evidence for hard fails (fresh-context retry, free); confidence gate (0.8) + the same free retry for judged fails, no re-judge (cost); `warn` tier absorbs ambiguity; INCONCLUSIVE for environmental failure; every red cites checkable evidence (doc 05) |
| **Judge misses subtle breakage** | A vision model can gloss over a dead-but-pretty page | The signals digest (console/network) travels with the screenshot — most "invisible" breakage is loud in signals; flows cover load-bearing interactions; non-goal honesty: deep correctness is regression testing's job |
| **Model cost/latency surprises** | per-run model spend is new to CI | Hard `maxModelCostUsd`; cheap-model default; costs printed on every run; hard rules keep working when budget exhausts (`unjudged`, yellow) |
| **Provider drift / lock-in** | any single-vendor coupling contradicts the agnostic promise | All model access through the AI SDK `LanguageModel` seam; Stagehand is itself model-agnostic; judge prompt uses no provider-specific features beyond structured output |
| **Discovery misses pages** | outside-in can't see unlinked, unlisted routes | Three merged sources + per-page source in the report (coverage is inspectable) + one-line `routes` fix; explicitly documented limitation (doc 03) |
| **Stagehand API churn** | it's a fast-moving young project | vigil touches it only inside FlowRunner/agent-login (~2 files); Midscene identified as drop-in-class alternative (doc 09) |
| **Auth complexity (SSO/MFA)** | blocks the "everything behind login" majority | storageState reuse + scripted login cover most; test-account pattern documented; TOTP as fast-follow |

## Open questions (decide during dogfooding, with data)

1. **Judge confidence threshold** — 0.8 is an educated guess; tune against seeded-breakage runs.
2. **Network-quiet parameters** — 2-in-flight/750ms/10s cap: validate against SPA-heavy apps.
3. **Screenshot economics** — viewport-only vs. viewport + compressed full-page thumb for the
   judge; measure catch-rate delta vs. token cost.
4. **Warn-noise budget** — if `warn` proves too chatty in practice, consider auto-suppressing
   repeat warns per URL within a run set — *without* introducing cross-run state (e.g. CI-side).
5. **Multi-viewport** — is a mobile-width second screenshot per page worth ~2× judge cost?
   (Config-gated if added; default off.)
6. **Name** — `vigil` is a working name; check npm availability before Phase 4.
7. **DOM-stability fingerprint richness** — the current 5-field fingerprint (doc 04) was chosen
   as the cheapest set that catches common same-length UI swaps (skeleton→cards, spinner→SVG).
   It still can't catch every same-length, same-element-count, spinner-free swap (e.g. an image
   gallery finishing its loads with no DOM structure change) or a single very-late change
   preceded by total silence (the heuristic's residual blind spot; doc 04). A fuller DOM
   diff/mutation-count signal or a framework-specific "app ready" hook would close more of this,
   at more implementation cost — revisit if dogfooding surfaces a real miss.
   *Update:* the highest-impact half of this — a stable but *empty* shell being read as settled —
   is closed by the not-yet-rendered guard (doc 04), added after it caused real false `BROKEN`
   verdicts on a live SPA. What remains is the non-empty single-late-change case.

## Open research issues

### Judge evidence interpretation contract

**Status:** Scoped — ready to implement, not started.

**In plain terms.** Right now the judge looks at all the evidence for a page — the screenshot,
the render signals, everything — and jumps straight to "pass, warn, or fail." Nothing forces it
to actually work through what it's looking at first. It's the difference between a doctor
glancing at an X-ray and saying "looks fine" versus a doctor who has to write down "is there a
fracture? yes/no. Is alignment normal? yes/no." *before* being allowed to give a diagnosis. The
second doctor is harder to fool with a rushed glance, because they've been forced to actually
look at the specific things that matter. This plan adds that forced first step to the judge —
without giving vigil's code itself any new power to overrule the judge, which stays the judge's
job alone (see Non-goals below).

**Problem.** The Collector now produces reliable render evidence (validated below by the
`/careers` improvement). The judge can still misinterpret that evidence. On qplus.tv `/`, the
model cited `render.title` (metadata) as evidence of successful rendering while ignoring
`render.spinnerStuck = true`, `render.textSample = "EXTERNAL_URL_IDENTIFIER"`, and a screenshot
showing only a loading spinner on a black background.

**Evidence** (captured 2026-07-22, after the DOM-stability collector fix — this is reproducible
against the same evidence, not a stale capture):

Digest fragment actually sent to the judge:
```json
"render": {
  "textLength": 23,
  "title": "Q plus - Watch Matches, Interviews, Replays & More",
  "h1": null,
  "textSample": "EXTERNAL_URL_IDENTIFIER",
  "errorMarkersFound": [],
  "spinnerStuck": true,
  "screenshotLooksBlank": false,
  "missingSelectors": [],
  "notFoundMarkersFound": []
}
```

Screenshot: solid black viewport, one visible loading spinner mid-animation, no other content —
unambiguous, not a borderline capture.

Judge rationale (verbatim, confidence 0.95, status `pass`):
> "Visible title indicates content loaded" — evidence: "render.textSample shows page has a
> title 'Q plus - Watch Matches, Interviews, Replays & More'"

That citation conflates two different fields: `render.title` is `document.title` (browser-tab
metadata, present on every page regardless of render state) with `render.textSample` (the
actual visible body text, which in this digest is literally `"EXTERNAL_URL_IDENTIFIER"`). The
model treated a metadata field's presence as evidence, instead of reading the value of the field
that actually reports what's on screen.

**Root cause hypothesis.**
- The prompt (`JUDGE_SYSTEM_INSTRUCTION` in `src/judge/prompt.ts`) never distinguishes metadata
  fields (`title`, always non-empty) from render-state fields (`textSample`, `spinnerStuck`,
  `screenshotLooksBlank`) — nothing marks which fields are load-bearing evidence.
- The judge is allowed to jump directly from raw evidence to a final verdict + reasons, with no
  forced intermediate step that requires it to explicitly assess render completeness before
  committing to a status.

**Non-goals** (deliberately, to keep this a judge-side fix, not a policy-side patch):
- Do not add a deterministic contradiction-guard override for this case.
- Do not promote `spinnerStuck` into a hard rule — it's correctly a heuristic today precisely
  because plenty of legitimate pages (a loading dashboard waiting on a websocket, an infinite
  feed, a live sports ticker, a progress/upload screen) show a persistent spinner while healthy.
  A deterministic override here would move interpretation that belongs to the judge back into
  hard-coded policy — architectural drift away from "Collector observes, Judge interprets."
- Do not modify `verdictPolicy.ts` as a workaround for this specific failure.

**The plan, in three parts.**

1. **A forced render-assessment step, before the verdict.** Add a required object to the judge's
   output schema (`src/judge/schema.ts`) that the model must fill in *before* `status`:
   ```ts
   renderAssessment: {
     loadingIndicatorVisible: boolean,
     meaningfulContentRendered: boolean,
     pageStillLoading: boolean,
     visualEvidence: string,   // what specifically, in the screenshot or digest, supports the three answers above
   }
   ```
   Field order in a schema-enforced object isn't cosmetic here — the model fills fields in the
   order the schema defines them, so putting `renderAssessment` ahead of `status` means the
   verdict is generated *after* the model has already committed, in writing, to specific answers
   about what it's looking at. That's the whole mechanism: not a smarter model, just one that
   can't skip the homework.

2. **Field semantics, explicit in the prompt.** `JUDGE_SYSTEM_INSTRUCTION`
   (`src/judge/prompt.ts`) gets a short, explicit line distinguishing the two kinds of field the
   digest carries: *metadata* (`render.title`, `document.status` — present on nearly every page,
   broken or not, and never evidence of successful rendering on their own) versus *render-state
   evidence* (`render.textSample`, `render.spinnerStuck`, `render.screenshotLooksBlank`, and the
   screenshot itself — the only things that actually describe what a user would see). This is
   the direct fix for the exact mistake in the Evidence section above: the model cited `title`'s
   *presence* as if that were proof of successful rendering.

3. **The render assessment becomes visible evidence, not a hidden scratchpad.** It gets its own
   block in the HTML report's judge card (`src/reporter/html.ts`), next to the existing reasons
   list. This does two things: it gives a human reading the report a second, independent way to
   catch a bad verdict (if the assessment says "still loading: true" next to a `pass`, that's
   immediately visible and suspicious to a reader, without vigil's code needing to police it),
   and it makes the judge's real behavior across many runs observable over time — is the
   assessment step actually engaging with the evidence, or is the model filling it in as
   rubber-stamp boilerplate that agrees with whatever `status` it was already going to pick?
   That question can only be answered by looking at real output, not decided in advance.

**Explicitly not part of this plan** (restating and sharpening the Non-goals above): vigil's code
never reads `renderAssessment` and cross-checks it against `status` to override, downgrade, or
flag anything automatically. Doing that would just be the contradiction guard again, wearing a
different field name — the exact architectural drift this issue was opened to avoid. The
assessment step is a prompting technique aimed at the model's own reasoning, not a new input to
vigil's deterministic policy layer. `verdictPolicy.ts` does not change as part of this work.

**Acceptance criterion.** Replay the exact qplus.tv `/` case from the Evidence section above —
same digest fragment, same screenshot — through the redesigned prompt/schema, using the same
model tier that got it wrong the first time (a free-tier model, not Gemini, which already
happened to reason through this correctly on the current prompt — see the note below). Success
means the new prompt prevents that specific model from repeating that specific mistake. This is a
concrete, reproducible bar — not "seems better" — and it should run through the existing mock-model
integration test harness (`test/integration/judge.test.ts`) before any real-model validation.

**One important caveat already known going in:** when this issue was first found, it was on a
free-tier open-source model. A later real-site validation run using Gemini reasoned through the
*same* evidence *correctly*, on the *unmodified* current prompt, with no changes. That doesn't
make this plan unnecessary — a judge that only reasons well on strong models isn't a judge vigil
can promise cost-conscious users will work reliably on a cheap default — but it does mean the
acceptance test above must specifically target a weaker model, since Gemini passing again would
prove nothing new.

**Scope note:** a fresh branch, not folded into collector work, so history stays answerable later
on whether a given behavior change came from better evidence (Collector) or better reasoning
(Judge).

## What success looks like (12 months out)

A team installs vigil in ten minutes and forgets it exists. Every deploy, ninety seconds later:
one green Slack line. The month something real breaks, the message reads *"❌ /checkout —
payment API returning 500; error toast visible — screenshot attached"* before the first customer
complaint — and when they click through, the evidence is exactly what it says. Nobody has ever
maintained a test, reviewed a generated spec, approved a healed locator, or curated a baseline.
There is nothing to maintain.
