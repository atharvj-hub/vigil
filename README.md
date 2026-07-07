# vigil

> A TypeScript library that answers one question minutes after every deployment:
> **"Is the app actually alive, responding, and rendering correctly — on every page?"**

vigil uses an AI agent that writes its own Playwright tests the first time it sees a page,
caches them, and re-runs them deterministically (fast, cheap, no LLM) on every run after that.
When the UI drifts, it heals the tests instead of failing them.

**LLM as compiler, Playwright as runtime.** The agent's intelligence is spent only on
*cache misses* — new pages, changed pages, broken tests. Everything else runs as plain,
versioned, human-readable Playwright specs at native speed.

## Status

Design phase. The full design lives in [`documentation/`](documentation/README.md) — read it
in order, starting with the [overview](documentation/01-overview.md).

## Documentation

| # | Document | What it answers |
|---|----------|-----------------|
| 01 | [overview](documentation/01-overview.md) | Why this exists; scope; core principles and vocabulary. |
| 02 | [architecture](documentation/02-architecture.md) | Components and end-to-end run flow. |
| 03 | [discovery](documentation/03-discovery.md) | Finding every page; getting past login. |
| 04 | [cache](documentation/04-cache.md) | How test assets are stored, keyed, fingerprinted, and invalidated. |
| 05 | [execution](documentation/05-execution.md) | The two test lanes on a single browser traversal. |
| 06 | [judgment & healing](documentation/06-judgment-and-healing.md) | "App broken" vs "test stale"; healing; flake control. |
| 07 | [reporting](documentation/07-reporting.md) | Verdicts, artifacts, exit codes, integrations. |
| 08 | [library API](documentation/08-library-api.md) | Programmatic API, config, CLI, extension points. |
| 09 | [data models](documentation/09-data-models.md) | Schemas for every entity, as TypeScript types. |
| 10 | [roadmap](documentation/10-roadmap.md) | Build phases, milestones, risks, open questions. |

## License

TBD
