# vigil — design documentation

> **vigil** (working name) is a TypeScript library that answers one question minutes after every deployment:
> **"Is the app actually alive, responding, and rendering correctly — on every page?"**
>
> It does this with an AI agent that writes its own Playwright tests the first time it sees a page,
> caches them, and re-runs them deterministically (fast, cheap, no LLM) on every run after that.
> When the UI drifts, it heals the tests instead of failing them.

## The one-paragraph pitch

Today, post-deployment sanity is either a human clicking around, a stale smoke-test suite nobody
maintains, or an expensive AI agent that re-explores the whole app on every run. vigil takes a
third path: **LLM as compiler, Playwright as runtime.** The agent's intelligence is spent only on
*cache misses* — new pages, changed pages, broken tests. Everything else runs as plain, versioned,
human-readable Playwright specs at native speed. The result converges toward a fully deterministic
suite that maintains itself.

## How to read these documents

Read in order the first time. Each document is self-contained enough to revisit independently.

| # | Document | What it answers |
|---|----------|-----------------|
| 01 | [overview.md](01-overview.md) | Why does this exist? What is in scope, what is not? Core principles and vocabulary. |
| 02 | [architecture.md](02-architecture.md) | What are the components and how does a single run flow through them, end to end? |
| 03 | [discovery.md](03-discovery.md) | How does vigil find every page of the app, and how does it get past login? |
| 04 | [cache.md](04-cache.md) | The heart of the system. How are test assets stored, keyed, fingerprinted, hit, missed, and invalidated? |
| 05 | [execution.md](05-execution.md) | How do the two test lanes (API + UI) run on a single browser traversal? What do the deterministic runner and the agentic explorer each do? |
| 06 | [judgment-and-healing.md](06-judgment-and-healing.md) | When something fails, how does vigil decide "app is broken" vs "test is stale"? How does healing work? How are flakes and false positives controlled? |
| 07 | [reporting.md](07-reporting.md) | What does the user see? Verdicts, artifacts, exit codes, and integrations (Slack, Jira, CI). |
| 08 | [library-api.md](08-library-api.md) | The public surface: programmatic API, config file, CLI wrapper, extension points, and future wrappers (GitHub Action, MCP server). |
| 09 | [data-models.md](09-data-models.md) | Precise schemas for every entity in the system, as TypeScript types. |
| 10 | [roadmap.md](10-roadmap.md) | Build phases, milestones, known risks, and open questions. |

## The system in one diagram

```
 deploy webhook / CLI invocation
            │
            ▼
 ┌─────────────────────┐
 │  1. DISCOVERY        │  routes from code / sitemap / crawl → Route Manifest
 └─────────┬───────────┘
           ▼
 ┌─────────────────────┐
 │  2. CACHE LOOKUP     │  per route: fingerprint page → hit or miss?
 └───┬───────────┬─────┘
     │ HIT       │ MISS
     ▼           ▼
 ┌─────────┐ ┌──────────────┐
 │ 3a. RUN  │ │ 3b. EXPLORE   │  agent generates spec,
 │ saved    │ │ (LLM + browser│  saves it → cache
 │ spec     │ │  via Playwright│
 └────┬────┘ └──────┬───────┘
      └──────┬──────┘
             ▼
 ┌─────────────────────┐      both lanes observed on the SAME page visit:
 │  4. JUDGMENT         │      • API lane: every network call captured & checked
 │                      │      • UI lane: console, DOM, visual, (VLM last resort)
 └───┬───────────┬─────┘
     │ test stale│ app broken
     ▼           ▼
 ┌─────────┐ ┌──────────┐
 │ 5a. HEAL │ │ 5b. REPORT│ → verdict, traces, screenshots, Slack/Jira/CI exit code
 └─────────┘ └──────────┘
```

## Design principles (the short version)

1. **Deterministic first, AI last.** Every check that *can* be a plain assertion *is* a plain
   assertion. LLMs are reserved for generation, triage, and genuinely fuzzy judgment.
2. **Cache hit is the happy path.** A mature installation should be >95% cache hits, meaning
   near-zero LLM cost and second-scale runs.
3. **Everything the agent produces is human-readable and lives in the user's repo.** Specs,
   baselines, and manifests are reviewable files, not opaque state in someone's cloud.
4. **Zero-config to start, fully configurable to grow.** `vigil run --url https://prod.app` must
   work with nothing else.
5. **A false alarm is worse than a missed bug.** Triage and healing exist to protect trust in
   the red light.
6. **Library first.** The CLI, the GitHub Action, the MCP server, and any IDE surface are all
   thin wrappers over one programmatic core.
