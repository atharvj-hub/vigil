# vigil — design documentation

> **vigil** is a TypeScript library that answers one question minutes after every deployment:
> **"Is the app actually alive, responding, and rendering correctly — on every page?"**
>
> Every run is the same simple pipeline: discover the pages, load each one in a real browser,
> capture objective signals (network, console, rendering, a screenshot), and let a multimodal
> AI judge deliver the verdict. No test files, no baselines, no cache, no healing —
> **nothing is stored between runs, so nothing can go stale.**

## The one-paragraph pitch

Post-deployment sanity today is either a human clicking around, a brittle smoke suite nobody
maintains, or an AI testing platform with a mountain of generated-test/self-healing machinery.
vigil takes the simplest sound path: **deterministic capture, AI judgment.** Playwright collects
facts a machine can collect perfectly (HTTP statuses, failed requests, console errors, what the
page looks like), and a vision-capable LLM does the one thing only intelligence can do — look at
the evidence and say "this page is broken" or "this page is fine." Because sanity checks are
shallow (load + observe, not deep flows), a cheap vision model judges a page for ~$0.004 —
a 100-page app costs well under a dollar per deploy, with zero maintenance ever.

## How to read these documents

Read in order the first time. Each document is self-contained enough to revisit independently.

| # | Document | What it answers |
|---|----------|-----------------|
| 01 | [overview.md](01-overview.md) | Why does this exist? Scope, non-goals, principles, vocabulary. |
| 02 | [architecture.md](02-architecture.md) | The components and the life of a single run, end to end. |
| 03 | [discovery.md](03-discovery.md) | How vigil finds every page, and how it gets past login. |
| 04 | [checks.md](04-checks.md) | What is captured on each page visit, and how optional flows work. |
| 05 | [judgment.md](05-judgment.md) | How the AI judge turns evidence into a verdict, and how false alarms are controlled. |
| 06 | [reporting.md](06-reporting.md) | Verdicts, artifacts, exit codes, and integrations (Slack, CI). |
| 07 | [library-api.md](07-library-api.md) | The public surface: programmatic API, config, CLI. |
| 08 | [data-models.md](08-data-models.md) | Precise schemas for every entity, as TypeScript types. |
| 09 | [prior-art.md](09-prior-art.md) | How others attack this problem, and exactly which open-source tools vigil builds on. |
| 10 | [roadmap.md](10-roadmap.md) | Build phases, milestones, risks, open questions. |

## The system in one diagram

```
 deploy webhook / CI step / manual invocation
            │
            ▼
 ┌──────────────────────┐
 │ 1. DISCOVER          │  config routes ∪ sitemap.xml ∪ shallow same-origin crawl
 │                      │  (+ login once via storageState / script / AI agent)
 └──────────┬───────────┘
            ▼   N pages, parallel browser contexts
 ┌──────────────────────┐
 │ 2. VISIT & CAPTURE   │  per page, deterministically observed:
 │    (Playwright)      │  • document HTTP status, redirects
 │                      │  • every network request: failures, 4xx/5xx, latency
 │                      │  • console errors, uncaught exceptions
 │                      │  • render heuristics (blank screen, error markers)
 │                      │  • screenshot
 │                      │  optional: user-defined natural-language flows (Stagehand)
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │ 3. JUDGE (AI)        │  hard failures short-circuit (doc 5xx, crash, blank)
 │                      │  everything else: vision LLM sees screenshot + signals
 │                      │  → pass / warn / fail + cited evidence
 │                      │  fail → one retry in a fresh context before it counts
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │ 4. REPORT            │  verdict + per-page evidence → JSON, HTML, screenshots,
 │                      │  exit code, Slack webhook
 └──────────────────────┘
```

## Design principles (the short version)

1. **Deterministic capture, AI judgment.** Machines collect the facts; the model only interprets
   them. The AI never decides *what happened* — only *what it means*.
2. **Stateless by design.** No generated tests, no baselines, no fingerprints, no healing. Every
   run evaluates the app as it is today. Nothing can go stale, so nothing needs maintenance.
3. **Completely agnostic.** Any LLM provider (via the Vercel AI SDK), any web framework (no code
   adapters — discovery works from the outside), any CI (exit codes + JSON), any browser
   Playwright supports.
4. **A false alarm is worse than a missed bug.** Hard evidence can fail a page on its own; AI
   opinion alone fails a page only with confidence, after a clean retry, with evidence cited.
5. **Zero-config to start.** `vigil run --url https://prod.app` with one API key env var must work.
6. **Library first.** The CLI, GitHub Action, and MCP server are thin wrappers over one
   programmatic core.
7. **Lean on the best open source, precisely.** Playwright for the browser, Stagehand for AI
   actions, the Vercel AI SDK for model access, zod for schemas — and nothing speculative
   (see [09-prior-art.md](09-prior-art.md)).
