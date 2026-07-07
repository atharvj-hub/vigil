# 02 — Architecture

This document names every component, shows how they connect, and walks the life of a single run
step by step. Deep dives live in documents 03–07; this is the map.

## Component inventory

```
vigil (library core)
├── Orchestrator          — owns a Run; sequences everything below; enforces budgets
├── Discovery             — produces the Route Manifest                    (doc 03)
│   ├── CodeRouteExtractor      (framework-aware static analysis)
│   ├── SitemapExtractor
│   └── CrawlExtractor          (browser-based, bounded)
├── AuthManager           — logs in once, persists Playwright storageState (doc 03)
├── AssetStore            — reads/writes .vigil/ in the user's repo        (doc 04)
│   └── Fingerprinter           (accessibility-tree structural hashing)
├── Execution             —                                                (doc 05)
│   ├── Runner                  (deterministic; executes saved specs)
│   ├── Explorer                (agentic; LLM + Playwright; generates specs)
│   └── NetworkRecorder         (per-page capture powering the API lane)
├── Judgment              — turns observations into check results          (doc 06)
│   ├── ApiJudge                (status/latency/schema vs. contract)
│   ├── UiJudge                 (console/DOM/visual, VLM escalation)
│   └── Triage                  (APP_BROKEN vs TEST_STALE vs FLAKY)
├── Healer                — repairs stale specs, updates AssetStore        (doc 06)
├── Reporter              — verdicts, artifacts, integrations              (doc 07)
└── ModelClient           — single abstraction over LLM/VLM providers
```

Two hard architectural rules:

- **Only `ModelClient` talks to an LLM.** Explorer, Triage, Healer, and UiJudge (VLM escalation)
  go through it. This makes cost accounting, provider swapping, and "run with no AI at all"
  (`--no-ai`, pure cache mode) trivial.
- **Only `AssetStore` touches `.vigil/` on disk.** Every other component asks it for assets or
  hands it new ones. This makes the storage layout swappable (local dir today, shared remote
  store for teams later) without touching any other component.

## The life of a run

What follows is the exact sequence for `vigil run --url https://app.example.com`. Numbers match
the phases the Orchestrator logs.

### Phase 0 — Setup
1. Load `vigil.config.ts` (or defaults). Resolve budgets: max pages, max run time, max LLM spend,
   parallelism.
2. Open the Asset Store; load the **route index** (a small JSON listing every known route and the
   metadata of its asset — see 04).
3. `AuthManager` checks for a saved `storageState.json`. If absent and auth is configured, it
   performs the login flow once (scripted or agent-assisted, see 03) and saves the state. All
   subsequent browser contexts start pre-authenticated.

### Phase 1 — Discovery
4. Run extractors in priority order (code → sitemap → crawl) and merge results into the
   **Route Manifest**: a deduplicated list of route patterns, each with 1–N concrete sample URLs.
5. Diff the manifest against the route index:
   - routes in both → candidates for cache hits
   - routes only in manifest → **new** (guaranteed misses)
   - routes only in index → **vanished** (reported; asset marked stale, not deleted)

### Phase 2 — Cache resolution (per route, parallelized)
6. Open the page in a fresh browser context. **From the first byte, `NetworkRecorder` is
   attached** — every request/response on this visit is captured regardless of hit or miss.
7. Wait for network-idle (bounded). Capture the accessibility snapshot. `Fingerprinter` computes
   the structural hash.
8. Compare with the stored fingerprint:
   - **exact / near match** (similarity ≥ threshold, default 0.90) → **HIT** → Phase 3a
   - **no asset, or similarity < threshold** → **MISS** → Phase 3b
   - The comparison is *structural similarity*, not equality — content changes (new product names,
     different dates) must not cause misses. Algorithm in 04.

### Phase 3a — Deterministic execution (HIT)
9. `Runner` executes the route's saved spec in the already-open context (Playwright test runner,
   programmatically driven). The spec asserts the UI lane's structural checks: key elements
   exist, primary interactions respond, no error boundary is showing.
10. Simultaneously the visit's recorded network traffic is checked by `ApiJudge` against the
    stored **contract**, and `UiJudge` runs its deterministic checks (console, failed resources,
    visual diff vs. baseline).
11. All green → route passes, costing zero tokens. Any failure → Phase 4.

### Phase 3b — Agentic exploration (MISS)
12. `Explorer` takes over the context. Loop: read accessibility snapshot → decide next semantic
    action (click by role, fill by label, navigate) → act → re-read. It identifies what the page
    *is for*, which elements are load-bearing, and which interactions are safe (see safety model
    in 05).
13. Explorer emits the route's new **asset**: a Playwright spec using resilient locators, an API
    contract distilled from the recorded traffic, a visual baseline (with masks over regions it
    identified as dynamic), and the fingerprint. `AssetStore` persists it.
14. The freshly generated spec is executed once immediately (self-check). Only a passing spec is
    marked `active`; a failing one is marked `draft` and the failure is reported as
    "could not establish baseline" rather than "app broken."

### Phase 4 — Judgment & triage (only on failure)
15. Every failing check is bundled with its evidence: the Playwright trace, the console log, the
    offending network exchange, screenshots current vs. baseline.
16. `Triage` classifies (deterministic rules first, LLM only for ambiguity — full decision table
    in 06):
    - **APP_BROKEN** → route turns red, evidence attached → Reporter.
    - **TEST_STALE** → Phase 5.
    - **FLAKY** → retry once in a fresh context; if it passes, record a flake strike (three
      strikes quarantines the spec — see 06).

### Phase 5 — Healing (TEST_STALE only)
17. `Healer` receives the failed spec + old fingerprint + new snapshot + failure trace. It patches
    the spec (usually re-anchoring locators), re-runs it, and on success updates the asset
    (spec, fingerprint, visual baseline) with a `healed` annotation in its history.
18. If healing fails twice, the asset is demoted to `draft` and the route is scheduled for full
    re-exploration on the next run. The current run reports the route as `UNVERIFIED` (yellow),
    never silently green.

### Phase 6 — Reporting
19. Reporter aggregates route results into the run **Verdict**: `HEALTHY` (all green),
    `DEGRADED` (yellows: healed/unverified/vanished, no reds), `BROKEN` (any red).
20. Artifacts are written to `.vigil/runs/<run-id>/`; integrations fire (exit code for CI, Slack
    summary, Jira ticket per red route with trace attached). Formats in 07.

## Concurrency model

- Routes are independent → processed in a worker pool (default: 4 concurrent browser contexts;
  configurable). Each context is fully isolated (fresh cookies except the shared auth
  storageState).
- Misses are far more expensive than hits, so the pool schedules **hits first** (fast global
  signal — "did the deploy break anything we already know about?" answers in seconds), then
  drains misses within the LLM budget.
- The Explorer serializes its LLM calls per route but multiple routes may explore in parallel up
  to `maxConcurrentExplorations` (default 2) to cap token burn rate.

## Budget enforcement (Orchestrator-owned)

Every run carries hard budgets, because an autonomous agent without budgets is a bill:

| Budget | Default | On exhaustion |
|---|---|---|
| `maxPages` | 100 | remaining routes reported `SKIPPED` |
| `maxRunMinutes` | 15 | in-flight finishes, rest `SKIPPED` |
| `maxLlmCostUsd` | 2.00 per run | misses reported `UNVERIFIED`, hits still run |
| `maxActionsPerExploration` | 25 | explorer finalizes with what it has |

A `SKIPPED`/`UNVERIFIED` route can never turn the verdict `HEALTHY` on its own — the verdict is
`DEGRADED` at best, so budget exhaustion is always visible.

## Failure containment

- A crash in one route's context never affects another (context isolation).
- A crash in the Explorer marks the route `UNVERIFIED`; the run continues.
- A crash in the Orchestrator itself still writes a partial report (report writing is wrapped in
  a `finally`).
- The library never throws to the caller for *test failures* — those are data in the RunResult.
  It throws only for *operational* failures (target unreachable, config invalid, store corrupt).

## Directory layout at rest (summary; full spec in 04)

```
user-repo/
├── vigil.config.ts
└── .vigil/
    ├── index.json               # route index: the cache's table of contents
    ├── auth/storageState.json   # gitignored
    ├── assets/
    │   └── products-_id/        # one dir per route (slugified pattern)
    │       ├── spec.ts          # plain Playwright — human readable/editable
    │       ├── contract.json    # API lane baseline
    │       ├── fingerprint.json # structural hash + tree summary
    │       ├── baseline.png     # visual baseline
    │       ├── masks.json       # dynamic regions excluded from visual diff
    │       └── meta.json        # status, history, flake strikes
    └── runs/                    # gitignored; last N run artifact bundles
```

Next: [03-discovery.md](03-discovery.md) — how the Route Manifest gets built and how auth works.
