# 02 — Architecture

This document names every component, shows how they connect, and walks the life of a single run.
Deep dives live in documents 03–06; this is the map.

## Component inventory

```
vigil (library core)
├── Orchestrator      — owns a Run; sequences everything below; enforces budgets
├── Discovery         — produces the Page Set                                (doc 03)
│   ├── ConfigRoutes        (routes/samples listed in config)
│   ├── SitemapSource       (sitemap.xml + robots.txt, incl. sitemap indexes)
│   └── Crawler             (bounded same-origin BFS, Playwright-driven)
├── Auth              — establishes a logged-in browser state, once per run  (doc 03)
├── Collector         — visits one page, captures Signals + screenshot       (doc 04)
├── FlowRunner        — executes user-authored natural-language flows        (doc 04)
│                       (thin wrapper over Stagehand's act/agent)
├── Judge             — hard-failure rules + multimodal LLM verdict          (doc 05)
├── Reporter          — run verdict, artifacts, integrations                 (doc 06)
└── ModelGateway      — the ONLY component that talks to an LLM
                        (thin wrapper over the Vercel AI SDK)
```

Three hard architectural rules:

- **Only `ModelGateway` talks to a model.** Judge, FlowRunner, and agent-assisted login go
  through it. This makes cost accounting and provider swapping trivial, and keeps the system
  model-agnostic by construction: the gateway accepts any AI SDK `LanguageModel`.
- **`Collector` is pure observation.** It navigates and records; it never clicks, types, or
  submits. All interaction lives in `FlowRunner` behind explicit user config.
- **No component reads artifacts from a previous run.** Runs are independent by construction.
  (Artifacts are written for humans and CI, not consumed by vigil.)

## The life of a run

The exact sequence for `vigil run --url https://app.example.com`. Numbers match the phases the
Orchestrator logs.

### Phase 0 — Setup
1. Load `vigil.config.ts` (or defaults). Resolve budgets: max pages, max run time, max model
   spend, concurrency. Resolve the judge model (config → env → error with a clear message).
2. Launch the browser. If auth is configured, establish a logged-in `storageState` once
   (reuse → scripted login → AI-agent login; see doc 03). All page contexts start from it.

### Phase 1 — Discovery
3. Gather candidate URLs from the three sources (config ∪ sitemap ∪ crawl), normalize
   (same-origin only, strip fragments/tracking params, dedupe), apply include/exclude globs,
   collapse obvious parametric families (`/products/1..9999` → a few samples), and cap at
   `maxPages`. Output: the **Page Set**. (Algorithm in doc 03.)

### Phase 2 — Visit & capture (parallel)
4. A worker pool of `concurrency` isolated browser contexts (default 5) drains the Page Set.
   For each page the `Collector`:
   - attaches network/console listeners **before** navigation,
   - navigates with a bounded wait (load event + network-quiet window, hard cap),
   - records the **Signals**: document status & redirect chain, every request's outcome,
     console errors, uncaught exceptions, render heuristics (text length, error-boundary
     markers, loading-spinner-stuck), timings,
   - takes a viewport screenshot,
   - closes the context.
5. If the page has user-defined **flows**, `FlowRunner` executes them in the same context
   before it closes (doc 04), appending flow outcomes to the Signals.

### Phase 3 — Judgment
6. `Judge` applies the **hard-failure rules** first (document status ≥ 500, page crashed,
   navigation failed, rendered body effectively empty). A hard failure is a `fail` with the rule
   as evidence — no model call, no ambiguity.
7. Every other page gets **one judge call**: screenshot + compact signals digest → structured
   verdict `{status, reasons[], confidence}` (schema-enforced via zod; doc 05).
8. A hard `fail` triggers **one retry**: fresh context, revisit, recapture, fresh hard-rule
   evaluation. Pass on retry → recorded as `warn` with reason `flaky`. Fail twice → the failure
   stands, and both captures are kept as evidence. A judged `fail` at confidence ≥ 0.8 is *not*
   retried — a re-judge would double model spend per flagged page (doc 05) — and ships as a
   confirmed fail on the first judgment.

### Phase 4 — Report
9. Page verdicts roll up into the run verdict: any confirmed `fail` → `BROKEN`; else any
   `warn` → `DEGRADED`; else `HEALTHY`. Environmental override: if ≥ 50% of pages hard-failed
   with network-type errors (DNS, connection refused, timeouts), the run is `INCONCLUSIVE`
   instead — the target or network is the suspect, not the app.
10. `Reporter` writes `vigil-report/<run-id>/` (JSON + self-contained HTML + screenshots),
    prints the summary, fires integrations (Slack webhook, exit code). Formats in doc 06.

## Concurrency model

- Pages are independent → a simple worker pool of isolated browser contexts (default 5, config
  `concurrency`). Contexts share only the auth `storageState`.
- Judge calls run concurrently with visiting (a page is judged as soon as it's captured), capped
  at `concurrency` in-flight model calls. With a fast small model, judging is never the
  bottleneck; the browser is.
- Expected wall-clock: a 100-page app ≈ 2–4 minutes at concurrency 5.

## Budget enforcement (Orchestrator-owned)

| Budget | Default | On exhaustion |
|---|---|---|
| `maxPages` | 150 | remaining pages reported `skipped` |
| `maxRunMinutes` | 10 | in-flight pages finish, rest `skipped` |
| `maxModelCostUsd` | 2.00 | remaining pages judged by hard rules only, reported `unjudged` (yellow) |
| per-page visit cap | 30s | page reported with whatever was captured; judge sees the timeout as a signal |

`maxModelCostUsd` is enforced *pre-call* by a reserve → commit/refund cost meter internal to the
Orchestrator: a conservative per-call estimate (derived from the resolved model's price table) is
reserved before any model call, the actual cost is committed after, and a denied reservation means
the call never happens. The Judge itself never sees budgets — its API takes evidence, not money.

A `skipped`/`unjudged` page can never let a run be `HEALTHY` — the verdict is `DEGRADED` at
best, so budget exhaustion is always visible, never silent.

## Failure containment

- A crash in one page's context never affects another (context isolation).
- A judge-call error (provider outage, rate limit) after retries marks the page `unjudged`
  (yellow) — hard rules still apply to it; the run continues.
- A crash in the Orchestrator still writes a partial report (report writing wrapped in `finally`).
- The library never throws for *check failures* — those are data in the `RunResult`. It throws
  only for *operational* failures (target unreachable at setup, invalid config, no model key).

## Directory layout at rest

```
user-repo/
├── vigil.config.ts            # optional — zero-config works
└── vigil-report/              # gitignored; artifacts for humans & CI, never read by vigil
    └── 2026-07-07T18-22-09_a3f2/
        ├── report.json        # complete machine-readable RunResult (schema in doc 08)
        ├── report.html        # single-file human report
        └── pages/<slug>.png   # screenshot per page (fail/warn pages keep retry captures too)
```

That's the whole system. No store, no index, no asset lifecycle — the absence of doc "04-cache"
in this design is the design.

Next: [03-discovery.md](03-discovery.md) — building the Page Set and getting past login.
