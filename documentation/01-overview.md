# 01 — Overview

## The problem

Every deployment ends with the same unanswered question: *did we just break production?*

Teams answer it today in four unsatisfying ways:

1. **A human clicks around.** Slow, incomplete, doesn't scale past a handful of pages, and it
   stops happening at 2 a.m.
2. **A hand-written smoke suite.** Covers whatever someone wrote a year ago. Every UI change
   breaks a locator; every broken locator erodes trust; eventually the suite is skipped.
3. **Uptime/synthetic monitors.** They ping URLs and check status codes. They cannot tell you
   that the page returned 200 but rendered a blank white screen because a JS bundle failed.
4. **AI test platforms with generated suites + self-healing.** Powerful, but they carry a large
   machinery burden — generated specs, baselines, fingerprints, healing loops — and every piece
   of stored state is a thing that can go stale, misfire, or need human arbitration.

The gap: **a check that sees what a human sees, costs almost nothing, and requires zero
authoring or maintenance — ever.**

## What vigil does

Immediately after a deployment (webhook, CI step, or manual invocation), vigil:

1. **Discovers every page** of the web application from the outside — configured routes,
   `sitemap.xml`, and a shallow same-origin crawl. No framework integration required.
2. **Loads each page in a real browser** (Playwright) and **captures objective signals** on the
   same visit: document HTTP status, every network request the page fires (failures, 4xx/5xx,
   latency), console errors and uncaught exceptions, render heuristics, and a screenshot.
   The sanity visit is **strictly read-only** — vigil loads and observes; it clicks nothing.
3. **Judges each page with a multimodal AI.** Unambiguous hard failures (document 5xx, page
   crash, blank render) short-circuit deterministically. Everything else goes to a vision-capable
   LLM that sees the screenshot and the signals and returns a structured verdict:
   `pass`, `warn`, or `fail`, with the evidence it relied on. A failing page is retried once in a
   fresh browser context before the failure counts.
4. **Optionally exercises user-defined flows** described in plain English ("search for 'shoes',
   expect a list of results") — executed by an AI browser agent (Stagehand), no test code ever
   written or stored.
5. **Reports a verdict** a human can act on in ten seconds: `HEALTHY`, `DEGRADED`, or `BROKEN`,
   with per-page detail, screenshots, and the exact failing evidence. Exit code for CI, webhook
   for Slack.

Then it throws everything away. The next run starts from zero, against the app as it is then.

## Why stateless is the design, not a limitation

The previous generation of tools (and an earlier draft of this design) cached generated tests and
healed them when the UI drifted. Every piece of that machinery exists to solve a problem the
machinery itself creates: *stored expectations go stale*. Cached specs need fingerprints to know
when to regenerate; fingerprints need thresholds; stale specs need triage ("app broken or test
stale?"); triage needs healing; healing needs guardrails. Each layer adds failure modes and
judgment calls.

vigil deletes the root cause. There are no stored expectations — only the app, observed fresh,
and a judge with common sense. What makes this affordable in 2026 is that small multimodal
models are now good enough and cheap enough (~$0.004/page, see [05-judgment.md](05-judgment.md))
that re-judging every page on every deploy costs less than a coffee per month for a typical app.
Determinism is preserved where it matters: the *evidence* is collected deterministically, hard
failures are decided deterministically, and the model only interprets — at temperature-free,
structured-output settings with a confidence gate.

## What vigil is NOT (non-goals)

- **Not a regression testing platform.** vigil verifies *sanity* — "the app is alive and
  rendering" — not deep business-logic correctness. Keep your functional test suites.
- **Not a test generator.** It never writes, stores, or maintains test files. (If you want a
  durable Playwright suite, use Playwright.)
- **Not a load/performance tool.** It records latency as a sanity signal (a 30-second API call
  is a sanity failure), but it does not generate load.
- **Not a monitoring platform.** It runs at moments (post-deploy; on a schedule if you like),
  not continuously. It complements Datadog/Sentry/Checkly, it doesn't replace them.
- **Not destructive.** Sanity visits never interact with the page at all. Flows are explicit,
  user-authored, and still governed by a destructive-action denylist
  (see [03-discovery.md](03-discovery.md) safety rules).

## Who uses it, and how it should feel

**Primary persona:** a small-to-mid engineering team with no dedicated QA, deploying several
times a day. Their entire interaction:

```bash
# once, ever:
npm i -D vigil
export VIGIL_MODEL_API_KEY=...        # any supported provider

# in the deploy pipeline:
npx vigil run --url https://app.example.com
# exit 0 = healthy, 1 = broken → the pipeline gates on it
```

Plus a Slack message after each run: *"✅ app.example.com — 42 pages healthy · 96s · $0.19"* or
*"❌ /checkout broken — payment API returning 500; page shows error banner (screenshot attached)."*

**Secondary persona:** an AI coding agent (Claude Code, Cursor) that deploys a change and calls
vigil through its MCP wrapper to self-verify before declaring done.

## Core principles (the long version)

### 1. Deterministic capture, AI judgment
Playwright records what happened — statuses, requests, console, pixels. That record is ground
truth and appears verbatim in reports. The model's only job is interpretation: "given this
evidence, is the page broken for a user?" The judge cannot invent evidence; every `fail` must
cite signals or visible defects, and those citations are checkable by a human in seconds.

### 2. Stateless: nothing stored, nothing stale
No artifact of run N is an input to run N+1 (artifacts are retained for humans, not for the
tool). This is what eliminates the cache/heal/triage complexity wholesale — see above.

### 3. Completely agnostic
- **Model-agnostic:** all AI calls go through the Vercel AI SDK's `LanguageModel` interface.
  Anthropic, OpenAI, Google, or a self-hosted vLLM endpoint — one config field.
- **Framework-agnostic:** discovery never reads the app's source. Sitemap + crawl + config work
  for Next.js, Rails, Django, WordPress, or a hand-rolled SPA identically.
- **CI-agnostic:** the contract is an exit code and a JSON file. GitHub Action is sugar.
- **Browser-agnostic:** chromium by default; firefox/webkit are a config field (Playwright).

### 4. Trust in the red light is the scarcest resource
A false "BROKEN" teaches people to ignore vigil, and then it's dead. Defenses, in order:
hard failures require hard evidence; AI-only failures require high confidence *and* a failed
retry in a fresh context; low confidence degrades to `warn` (yellow, non-gating by default);
and a run where most pages fail with network-style errors is declared `INCONCLUSIVE` — "check
the network/target, not the app."

### 5. Library first, wrappers thin
The core is a programmatic TypeScript API. The CLI is ~150 lines over it. The GitHub Action
wraps the CLI. The MCP server exposes two tools over the same API. No wrapper contains logic.

## Vocabulary (used consistently across all documents)

| Term | Meaning |
|------|---------|
| **Run** | One complete invocation of vigil against a target URL. |
| **Page** | A concrete URL that gets visited, e.g. `/products/42`. The unit of checking. |
| **Page set** | The deduplicated list of pages produced by discovery for a run. |
| **Signals** | The deterministic evidence captured during one page visit (network, console, render, screenshot). |
| **Hard failure** | A signal combination that fails a page without consulting the model (doc 5xx, crash, blank render). |
| **Judge** | The multimodal LLM call that interprets a page's signals + screenshot into a verdict. |
| **Flow** | An optional, user-authored natural-language interaction check, executed by an AI browser agent. |
| **Page verdict** | `pass` / `warn` / `fail` for one page, with cited evidence. |
| **Run verdict** | `HEALTHY` / `DEGRADED` / `BROKEN` / `INCONCLUSIVE` for the whole run. |

## Where vigil sits relative to existing tools

| | Uptime monitors | Hand-written E2E | Generated-suite AI platforms | **vigil** |
|---|---|---|---|---|
| Detects blank page w/ 200 status | ✗ | ✓ (if authored) | ✓ | ✓ |
| Checks the API calls pages actually make | ✗ | rarely | partial | ✓ (automatic) |
| Authoring effort | none | high | none | none |
| Maintenance effort | none | high | low (healing, review) | **none — no artifacts exist** |
| State that can go stale | none | tests | specs, baselines, fingerprints | **none** |
| Cost per run | ~0 | ~0 | ~0 after generation | small, bounded (~$0.004/page) |
| Provider/framework agnostic | ✓ | ✓ | varies | ✓ |

The full competitive survey, with sources, is in [09-prior-art.md](09-prior-art.md).

Next: [02-architecture.md](02-architecture.md) — the components and the life of a run.
