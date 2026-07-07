# vigil

> A TypeScript library that answers one question minutes after every deployment:
> **"Is the app actually alive, responding, and rendering correctly — on every page?"**

Every run is the same simple pipeline: **discover** the app's pages (sitemap + shallow crawl +
config), **load** each one in a real browser and capture objective signals (network failures,
console errors, render state, a screenshot), and let a **multimodal AI judge** deliver the
verdict. Hard failures (5xx, crashes, blank screens) are decided deterministically; everything
else is judged by a vision model that cites its evidence.

**Deterministic capture, AI judgment — and completely stateless.** No generated tests, no
baselines, no cache, no self-healing: nothing is stored between runs, so nothing can go stale
and there is nothing to maintain. Ever.

**Completely agnostic.** Any LLM provider (via the Vercel AI SDK), any web framework (discovery
works from the outside — no adapters), any CI (exit codes + JSON), any browser Playwright runs.

```bash
npm i -D vigil
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY

npx vigil run --url https://app.example.com
# exit 0 = healthy · 1 = broken · 2 = degraded · 3 = inconclusive
```

A 100-page app checks out in ~2–4 minutes for well under a dollar.

## Status

Design phase. The full design lives in [`documentation/`](documentation/README.md) — read it in
order, starting with the [overview](documentation/01-overview.md).

## Documentation

| # | Document | What it answers |
|---|----------|-----------------|
| 01 | [overview](documentation/01-overview.md) | Why this exists; scope; principles; vocabulary. |
| 02 | [architecture](documentation/02-architecture.md) | Components and the life of a run, end to end. |
| 03 | [discovery](documentation/03-discovery.md) | Finding every page; getting past login; safety. |
| 04 | [checks](documentation/04-checks.md) | What one page visit captures; optional natural-language flows. |
| 05 | [judgment](documentation/05-judgment.md) | Hard rules, the AI judge, retries, false-alarm control, cost. |
| 06 | [reporting](documentation/06-reporting.md) | Verdicts, artifacts, exit codes, integrations. |
| 07 | [library API](documentation/07-library-api.md) | Programmatic API, config, CLI, extension points. |
| 08 | [data models](documentation/08-data-models.md) | Schemas for every entity, as TypeScript types. |
| 09 | [prior art](documentation/09-prior-art.md) | The landscape survey and the exact open-source stack vigil builds on. |
| 10 | [roadmap](documentation/10-roadmap.md) | Build phases, milestones, risks, open questions. |

## The stack (one best-in-class tool per job)

| Job | Tool | License |
|---|---|---|
| Browser runtime | [Playwright](https://playwright.dev) | Apache-2.0 |
| Natural-language browser actions (flows, agent login) | [Stagehand](https://github.com/browserbase/stagehand) | MIT |
| Model-agnostic LLM access | [Vercel AI SDK](https://ai-sdk.dev) | Apache-2.0 |
| Schemas & validation | [zod](https://zod.dev) | MIT |
| Sitemap parsing | [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | MIT |

## License

TBD
