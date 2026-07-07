# 09 — Prior Art & Tooling Choices

This document records how others attack post-deploy verification (surveyed July 2026), what
vigil learns from each, and exactly which open-source components vigil builds on — one
best-in-class tool per job, nothing speculative.

## The landscape, in four families

### 1. Fully agentic browser AI (an agent drives every run)
**[browser-use](https://github.com/browser-use/browser-use)** (Python, MIT) — the default OSS
answer to "my agent needs a real browser"; **[Stagehand](https://github.com/browserbase/stagehand)**
(TypeScript, MIT, Browserbase) — act/extract/observe/agent primitives over its own CDP engine,
model-agnostic; **[Midscene.js](https://github.com/web-infra-dev/midscene)** (TypeScript, MIT,
ByteDance) — vision-driven automation from screenshots alone, supports self-hostable models
(UI-TARS, Qwen-VL); **[Magnitude](https://github.com/magnitudedev/magnitude)** (TypeScript,
vision-first planner/executor split); **[Skyvern](https://github.com/Skyvern-AI/skyvern)**
(Python, AGPL).

*Lesson:* natural-language browser action is now a solved, commoditized layer — **don't build
it, import it**. But a free-roaming agent per page is the wrong shape for sanity checking:
open-ended exploration is slow, non-deterministic in *behavior*, and unnecessary when the check
is "load and look."

### 2. AI-generated test suites with self-healing
**[Shortest](https://github.com/antiwork/shortest)** (TypeScript, natural-language tests
executed via Claude + Playwright); **[Octomind](https://octomind.dev)**, **[QA Wolf](https://www.qawolf.com)**,
mabl, testRigor (commercial) — generate Playwright (or equivalent) suites, run them per deploy,
auto-heal on drift.

*Lesson:* this is the strongest *regression* story, and the graveyard of complexity for a
*sanity* tool. Generated specs, baselines, and fingerprints are stored expectations; stored
expectations go stale; staleness demands triage and healing. An earlier draft of vigil lived
here — the machinery consumed the design. For "is it alive?", stored expectations add risk, not
signal.

### 3. Synthetic monitoring
**[Checkly](https://www.checklyhq.com)** (Playwright-based monitoring-as-code, AI root-cause
assist), Datadog Synthetics, Grafana. Hand-written checks on schedules from global locations.

*Lesson:* the *reporting* bar — screenshot + trace + one-line root cause within seconds — and
the exit-code/CI ergonomics. But authoring is still on the team, which is exactly the burden
vigil exists to remove.

### 4. Deterministic capture + LLM judgment (vigil's family)
The emerging pattern in 2026 tooling: agents plug in post-deploy, machines gather evidence,
multimodal models interpret screenshots ("screenshot-understanding agents", LLM-as-judge over
captured signals). No single dominant OSS tool owns "stateless AI smoke check" — that is the
gap vigil fills.

*Lesson:* judged-screenshot pipelines are robust to layout/content change by construction —
they evaluate *today's* page on its own merits. That property is what replaces healing.

## What vigil takes from each family

| From | vigil adopts | vigil rejects |
|---|---|---|
| Agentic browser AI | Stagehand for the two places language→action is genuinely needed (flows, agent login) | free-roaming exploration per page |
| Generated-suite platforms | "zero authoring" as the bar; evidence-rich failure reports | all stored artifacts: specs, baselines, fingerprints, healing |
| Synthetic monitoring | exit-code CI contract; ten-second Slack summary; screenshot-first debugging | hand-written checks; always-on infrastructure |
| Judge pipelines | deterministic capture + schema-forced multimodal verdicts + confidence gating | letting the model *collect* (it only interprets) |

## The chosen stack — one tool per job

| Job | Choice | License | Why this one, precisely |
|---|---|---|---|
| Browser runtime | **Playwright** | Apache-2.0 | The de-facto standard: pre-navigation network/console hooks (`page.on`), storageState auth, screenshots, three engines, first-class TS. Everything the Collector needs is native. |
| NL browser actions (flows + agent login only) | **Stagehand** (`@browserbasehq/stagehand`) | MIT | TypeScript-native, model-agnostic (drives models through the same AI SDK layer vigil already uses), act/extract/observe map 1:1 onto flow steps, v3 caches resolved actions to cut repeat-step model cost. Midscene is the noted alternative (vision-first, self-hostable UI models) if Stagehand's direction ever diverges — the FlowRunner wrapper is thin enough to swap. |
| Model access | **Vercel AI SDK** (`ai` + `@ai-sdk/*` providers) | Apache-2.0 | *The* agnosticism guarantee: one `LanguageModel` interface over Anthropic/OpenAI/Google/self-hosted endpoints; `generateObject` + zod gives schema-enforced judge verdicts on every provider's native structured-output mode; multimodal input support. |
| Schema & config validation | **zod** | MIT | Already the AI SDK's schema language — one schema system for config, judge output, and report types. |
| Sitemap parsing | **fast-xml-parser** | MIT | Tiny, fast, zero-dep XML→JS; sitemaps need nothing more. |
| Crawling | **in-house BFS (~100 lines on Playwright)** | — | Crawlee et al. solve scale-crawling (queues, proxies, retries at volume). A same-origin, depth-2, 100-page read-only BFS is a small function; importing a framework for it would be the overengineering this redesign removes. |
| CLI | **commander** | MIT | Boring and universal; the CLI is ~150 lines. |
| Reporting | **hand-rolled** (one HTML template, JSON, `fetch` to Slack webhook) | — | Zero dependencies; a single-file HTML report is a template literal away. |

### Explicitly considered and not used

- **browser-use** — Python; vigil is a TypeScript library.
- **Shortest / Magnitude** — full test-framework shells around the same idea; vigil needs the
  action layer, not the framework.
- **Crawlee** — see above; wrong weight class for a bounded BFS.
- **Lighthouse** — perf/a11y auditing is out of scope (non-goal).
- **pixelmatch/SSIM visual diffing** — requires stored baselines; the judge's fresh-eyes
  screenshot read replaces it (see [04-checks.md](04-checks.md)).

## Sources

- Stagehand — repo & docs: https://github.com/browserbase/stagehand · https://www.browserbase.com/blog/stagehand-v3 · https://stagehand.dev
- Midscene.js — https://github.com/web-infra-dev/midscene · https://midscenejs.com
- browser-use — https://github.com/browser-use/browser-use (via [Best 30+ Open Source Web Agents in 2026](https://aimultiple.com/open-source-web-agents), [Open Source Toolkit for Building AI Agents in 2026](https://dev.to/anmolbaranwal/open-source-toolkit-for-building-ai-agents-in-2026-55h1))
- Shortest — https://github.com/antiwork/shortest
- Magnitude / framework comparison — [A Review of Open-Source AI-Driven UI Test Automation Frameworks](https://medium.com/@ss-tech/a-review-of-open-source-ai-driven-ui-test-automation-frameworks-2025-4b957cdf822d) · [Midscene.js assessment (Nearform)](https://nearform.com/digital-community/midscene-js-assessing-a-natural-language-ai-testing-tool/)
- Octomind — https://octomind.dev · [feature overview](https://bug0.com/knowledge-base/octomind-ai-testing-platform-features)
- QA Wolf — https://www.qawolf.com
- Checkly — https://www.checklyhq.com · [synthetic monitoring](https://www.checklyhq.com/product/synthetic-monitoring/)
- Playwright AI-agents comparison — [Playwright's new AI agents vs AI-native platforms](https://medium.com/@valentijnvanwynsberghe/i-tested-playwrights-new-ai-agents-against-ai-native-testing-platforms-here-s-what-i-found-250e36ba89dd)
- Vercel AI SDK — https://github.com/vercel/ai · https://ai-sdk.dev/docs/introduction
- Post-deploy AI smoke-testing pattern — [Automate Post-Deployment Smoke Testing](https://www.shopclawmart.com/blog/automate-post-deployment-smoke-testing-build-ai-agent) · [Screenshot Understanding Agents](https://www.arunbaby.com/ai-agents/0022-screenshot-understanding-agents/)

Next: [10-roadmap.md](10-roadmap.md) — phases, risks, open questions.
