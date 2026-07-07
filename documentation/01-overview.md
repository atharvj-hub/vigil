# 01 — Overview

## The problem

Every deployment ends with the same unanswered question: *did we just break production?*

Teams answer it today in one of four unsatisfying ways:

1. **A human clicks around.** Slow, incomplete, doesn't scale past a handful of pages, and it
   stops happening at 2 a.m.
2. **A hand-written smoke suite.** Covers whatever someone wrote a year ago. Every UI change
   breaks a locator; every broken locator erodes trust; eventually the suite is skipped.
3. **Uptime/synthetic monitors.** They ping URLs and check status codes. They cannot tell you
   that the page returned 200 but rendered a blank white screen because a JS bundle failed.
4. **Fully agentic AI testing on every run.** Impressive, but every run costs real money, takes
   minutes per page, and is non-deterministic — the same app can pass today and fail tomorrow
   because the model felt differently.

The gap: **a check that is as thorough as an agent, as cheap and repeatable as a script, and
requires zero authoring or maintenance from the team.**

## What vigil does

Immediately after a deployment (triggered by webhook, CI step, or manual invocation), vigil:

1. **Discovers every page** of the web application (from code, sitemap, or crawling).
2. **Visits each page in a real browser** (Playwright), performing two kinds of verification on
   the same visit:
   - **API sanity** — every network request the page fires is captured and checked: no new
     4xx/5xx, latency within budget, response shapes match the recorded contract.
   - **UI sanity** — the page actually rendered: no console errors, no failed asset loads, the
     structural skeleton of the page is intact, key interactive elements exist and respond, and
     the page is visually consistent with its baseline.
3. **Writes its own tests.** The first time vigil sees a page, an AI agent explores it and emits
   a plain Playwright spec plus baselines (API contract, visual snapshot, DOM fingerprint). These
   are saved to the repo. Every subsequent run executes the saved spec deterministically —
   no LLM involved. This is the **cache hit/miss model**.
4. **Heals instead of crying wolf.** When a saved test fails because the UI legitimately changed
   (not because the app broke), vigil repairs the test, updates the cache, and reports green with
   an annotation.
5. **Reports a verdict** a human can act on in ten seconds: `HEALTHY`, `DEGRADED`, or `BROKEN`,
   with per-page detail, traces, screenshots, and video for anything red.

## What vigil is NOT (non-goals)

Being explicit about non-goals keeps the library small and the promise crisp.

- **Not a regression testing platform.** vigil verifies *sanity* — "the app is alive and
  rendering" — not deep business-logic correctness ("the tax calculation is right for a customer
  in Quebec buying 3 items with a coupon"). Teams should keep their functional test suites.
- **Not a load/performance testing tool.** It records latency as a sanity signal (a 30-second
  API call is a sanity failure), but it does not generate load.
- **Not a monitoring/observability platform.** It runs at moments (post-deploy, on schedule if
  the user wants), not continuously. It complements Datadog/Sentry, it doesn't replace them.
- **Not a test recorder or authoring IDE.** Users never write or record tests. If a user wants
  to hand-author complex flows, they should use Playwright directly (and vigil will happily run
  hand-written specs placed into its asset directory — see 04-cache.md).
- **Not destructive.** By default vigil operates in read-mostly mode against production: it
  navigates, opens menus, fills and *abandons* forms, but does not submit state-changing actions
  unless the user explicitly allowlists a flow (see "Safety model" in 05-execution.md).

## Who uses it, and how it should feel

**Primary persona:** a small-to-mid engineering team with no dedicated QA, deploying a web app
several times a day. They will never write a test for vigil. Their entire interaction is:

```bash
# once, ever:
npm i -D vigil
npx vigil init            # creates vigil.config.ts with sane defaults

# in the deploy pipeline:
npx vigil run --url https://app.example.com
# exit code 0 = healthy, 1 = broken → pipeline gates on it
```

Plus a Slack message after each run: *"✅ 42 pages healthy · 2 specs auto-healed · 11s"* or
*"❌ /checkout broken — payment API returning 500 (trace attached)"*.

**Secondary persona:** a developer using an AI coding agent (Claude Code, Cursor). The agent
deploys a change and calls vigil through its MCP wrapper to self-verify before declaring done.

## Core principles (the long version)

### 1. Deterministic first, AI last
Checks are arranged in a strict cost/reliability hierarchy (detailed in 06):
free signals (HTTP status, console errors, failed requests) → cheap assertions (locator existence,
schema validation) → visual pixel diff → and only at the very end, model-based judgment. An LLM or
VLM opinion is *never* the reason a run turns red on its own; it can only corroborate or triage.

### 2. The cache is the product
The agentic exploration is table stakes — several tools do it. vigil's differentiation is the
economics: intelligence is amortized. Run #1 of a 50-page app might take 20 minutes and cost a few
dollars in tokens. Run #100 takes under a minute and costs $0, because it's 50 cached Playwright
specs running in parallel. The system's steady state is a self-maintaining deterministic suite.

### 3. Assets live in the user's repo, in plain text
Generated specs are idiomatic Playwright (`getByRole`, `getByLabel`) that a developer can read,
diff in a PR, edit, or delete. Baselines are JSON and PNG. Nothing is proprietary or opaque.
This is both a trust mechanism and an escape hatch: if vigil disappears tomorrow, the user keeps
a working Playwright suite.

### 4. Trust in the red light is the scarcest resource
The moment vigil produces a false "BROKEN," someone will start ignoring it, and the tool is dead.
Therefore: healing before failing, quarantine for flaky specs, retry-with-isolation before
reporting, and every red verdict ships with evidence (trace + screenshot + the exact failing
request) so it can be verified in seconds.

### 5. Library first, wrappers thin
The core is a programmatic TypeScript API (`08-library-api.md`). The CLI is ~200 lines over it.
The GitHub Action is a shell around the CLI. The MCP server exposes three tools over the same
API. No wrapper contains logic.

## Vocabulary (used consistently across all documents)

| Term | Meaning |
|------|---------|
| **Run** | One complete invocation of vigil against a target URL. |
| **Route** | A URL pattern of the app, e.g. `/products/:id`. The unit of discovery. |
| **Page instance** | A concrete URL matching a route, e.g. `/products/42`. The unit of visiting. |
| **Route Manifest** | The list of routes (+ sample instances) produced by discovery for a run. |
| **Asset** | Everything cached for one route: spec file, API contract, visual baseline, fingerprint, metadata. |
| **Asset Store** | The on-disk directory (in the user's repo) holding all assets: `.vigil/`. |
| **Fingerprint** | A structural hash of a page's accessibility tree, used as the cache key alongside the route. |
| **Cache hit** | Fingerprint matches the stored asset → run the saved spec deterministically. |
| **Cache miss** | New route, or fingerprint drifted beyond threshold → invoke the agentic explorer. |
| **Lane** | One of the two verification dimensions: the **API lane** and the **UI lane**. Both run on the same page visit. |
| **Explorer** | The LLM-driven component that investigates a page and generates its spec + baselines. |
| **Runner** | The deterministic component that executes saved specs via Playwright. |
| **Judgment** | The layer that turns raw observations into pass/fail per check. |
| **Triage** | The classification of a failure as `APP_BROKEN`, `TEST_STALE`, or `FLAKY`. |
| **Healer** | The LLM-driven component that repairs a `TEST_STALE` spec and updates the cache. |
| **Verdict** | The run-level outcome: `HEALTHY`, `DEGRADED`, or `BROKEN`. |
| **Contract** | The recorded baseline of a page's API behavior: endpoints called, status codes, latency budgets, response schemas. |

## Where vigil sits relative to existing tools

| | Uptime monitors | Hand-written E2E | Autospec / Octomind style | **vigil** |
|---|---|---|---|---|
| Detects blank page w/ 200 status | ✗ | ✓ (if authored) | ✓ | ✓ |
| Checks API responses per page | ✗ | rarely | partial | ✓ (automatic, contract-based) |
| Authoring effort | none | high | none | none |
| Maintenance effort | none | high | none | none (self-healing) |
| Cost per run | ~0 | ~0 | LLM cost every run | LLM cost only on misses → ~0 |
| Deterministic / repeatable | ✓ | ✓ | ✗ | ✓ on hits (steady state) |
| Post-deploy focus | partial | ✗ (pre-merge) | ✗ (pre-merge) | ✓ (designed for it) |

Next: [02-architecture.md](02-architecture.md) — the components and the life of a run.
