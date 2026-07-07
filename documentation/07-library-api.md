# 07 — The Library API

Everything in vigil is reachable programmatically; the CLI and all wrappers are thin. This
document is the public contract: what we promise to keep stable.

## Package shape & dependencies

```
vigil                      # the core library
└── vigil/cli              # CLI entry (`npx vigil …`), ~150 lines
```

Runtime dependencies — few, boring, best-of-breed (rationale in [09-prior-art.md](09-prior-art.md)):

| Dependency | Purpose | License |
|---|---|---|
| `playwright` | browser runtime (peer dep) | Apache-2.0 |
| `ai` (Vercel AI SDK) + provider pkgs | model-agnostic LLM access, structured output | Apache-2.0 |
| `@browserbasehq/stagehand` | natural-language browser actions (flows, agent login) | MIT |
| `zod` | config validation + judge output schemas | MIT |
| `fast-xml-parser` | sitemap parsing | MIT |
| `commander` | CLI arg parsing | MIT |

No database, no store, no daemon.

## Programmatic API

### The 90% case

```ts
import { runSanity } from "vigil";

const result = await runSanity({ url: "https://app.example.com" });

if (result.verdict === "BROKEN") {
  for (const p of result.pages.filter(p => p.status === "fail")) {
    console.error(p.url, "→", p.headline);
  }
  process.exit(1);
}
```

### The composable core

```ts
import { Vigil } from "vigil";

const vigil = await Vigil.create(config);

const pageSet = await vigil.discover();              // Phase 1 only (dry run / inspection)
const result  = await vigil.run();                   // full pipeline
const onePage = await vigil.checkPage("/checkout");  // targeted single-page re-check

// event stream for live UIs / streaming reporters
vigil.events.on("page:complete", (p) => log(p.url, p.status));
vigil.events.on("run:complete",  (r) => notify(r));
```

`RunResult` and all types are exported and documented in [08-data-models.md](08-data-models.md).

## Configuration: `vigil.config.ts`

Typed, zod-validated, and **entirely optional** — `url` (CLI-suppliable) plus a model API key
env var is enough. Full surface:

```ts
import { defineConfig } from "vigil";
import { anthropic } from "@ai-sdk/anthropic";   // or @ai-sdk/openai, @ai-sdk/google, …

export default defineConfig({
  url: process.env.TARGET_URL,

  discovery: {
    routes: ["/", "/pricing", "/checkout"],      // always visited, first
    sitemap: true,                               // default true
    crawl: { depth: 2, maxPages: 100 },          // shallow BFS; read-only
    include: ["/**"],
    exclude: ["/admin/**", "/api/**", "/logout"],
    samplesPerPattern: 2,
    allowSubdomains: false,
  },

  auth: {
    login: async (page) => { /* …see 03… */ },   // or omit: AI-agent login via env creds
    probeRoute: "/dashboard",
    persistState: true,                          // reuse storageState across runs
  },

  flows: [
    { page: "/", name: "search works",
      steps: ["type 'shoes' into the search box and submit",
              "expect a list of product results to be visible"] },
  ],

  model: {
    judge: anthropic("claude-haiku-4-5"),        // any vision LanguageModel — the ONLY
    flows: anthropic("claude-sonnet-4-6"),       // provider coupling is this config line
  },

  budgets: {
    maxPages: 150,
    maxRunMinutes: 10,
    maxModelCostUsd: 2.0,
    concurrency: 5,
  },

  checks: {
    latencyBudgetMs: 5000,
    consoleErrorAllowlist: [/ResizeObserver loop/],
    errorMarkers: [/application error/i],        // additions to the built-ins
    viewport: { width: 1280, height: 720 },
    browser: "chromium",                         // | "firefox" | "webkit"
  },

  safety: {
    allowDestructive: false,                     // flows may never click destructive elements
    denylistExtra: [/unsubscribe/i],
  },

  report: {
    dir: "vigil-report",
    keepRuns: 10,
    reporters: ["cli", slack({ webhook: process.env.SLACK_WEBHOOK, policy: "on-problem" })],
    failOn: "broken",                            // | "degraded"
  },
});
```

**Model agnosticism, concretely:** the `model.*` fields accept any AI SDK `LanguageModel`
instance. Swapping Anthropic → OpenAI → Gemini → a self-hosted vLLM/Ollama endpoint is one
import + one line; nothing else in vigil knows or cares. With no config at all, vigil picks a
provider from whichever well-known env key is present (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`) and uses that provider's cheapest vision model.

## CLI (complete list)

```
vigil run [--url] [--fail-on broken|degraded] [--only <glob>] [--json]
          [--prev-verdict <verdict>]   # enables Slack recovery messages (see 06)
vigil discover [--url]        print the Page Set (dry run of Phase 1)
vigil check <url-or-path>     single-page check (fast feedback while configuring)
vigil init                    scaffold vigil.config.ts + .gitignore entries
vigil report [run-id]         open the HTML report
```

## Extension points (stable interfaces)

| Interface | Purpose |
|---|---|
| `Reporter` | `onRunComplete`, `onPageComplete?` — ship results anywhere |
| `Check` | custom deterministic signal collectors, e.g. "every page has our CSP header"; results join the Signals and are visible to the judge |
| `LanguageModel` (from the AI SDK) | the model seam — not a vigil-owned interface, deliberately |

Kept intentionally small. Discovery adapters, store backends, and healing hooks from the
earlier design are gone with the subsystems that needed them.

## The wrappers (built after the library, in this order)

1. **GitHub Action** — `uses: vigil/action@v1` with a `url` input; wraps the CLI, uploads
   artifacts, comments summaries. The primary distribution channel.
2. **MCP server** (`vigil/mcp`) — exposes exactly two tools: `run_sanity(url, only?)` and
   `check_page(url)`. Each is a direct call into the core. An AI coding agent deploys, then
   self-verifies.
3. **Scheduler recipe** (docs, not code): cron + `vigil run` = continuous sanity between deploys.

## Versioning & stability promises

- SemVer. The stable surface = this document + the types in 08.
- `report.json` carries a `schemaVersion`; additive changes only within a major.
- No stored formats exist to migrate — upgrades can never require regeneration of anything.

Next: [08-data-models.md](08-data-models.md) — the precise types.
