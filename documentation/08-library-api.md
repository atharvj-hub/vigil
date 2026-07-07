# 08 — The Library API

Everything in vigil is reachable programmatically; the CLI and all future wrappers are thin.
This document is the public contract: what we promise to keep stable.

## Package shape

```
vigil                      # the core library (this doc)
├── vigil/cli              # CLI entry (`npx vigil …`), ~thin
├── vigil/adapters         # discovery adapters (nextjs, react-router, …)
└── vigil/reporters        # built-in reporter plugins (slack, jira, github)
```

Peer dependency: `@playwright/test`. Model access: any provider through `ModelClient`
(Anthropic first-class; the interface is provider-agnostic and users can inject their own).

## Programmatic API

### The 90% case

```ts
import { runSanity } from "vigil";

const result = await runSanity({
  url: "https://app.example.com",
  configFile: "./vigil.config.ts",   // optional; defaults discovered automatically
});

if (result.verdict === "BROKEN") {
  for (const r of result.routes.filter(r => r.status === "FAILED")) {
    console.error(r.route, "→", r.headline, r.evidencePath);
  }
  process.exit(1);
}
```

### The composable core (what wrappers and power users build on)

```ts
import { Vigil } from "vigil";

const vigil = await Vigil.create(config);

// each phase separately drivable — this is what makes the MCP wrapper trivial
const manifest  = await vigil.discover();                    // Phase 1
const result    = await vigil.run({ manifest });             // Phases 2–6
const oneRoute  = await vigil.runRoute("/checkout");         // targeted re-check
await vigil.invalidate("/pricing");                          // force re-exploration
await vigil.explore("/new-page", { save: true });            // explicit compile
const health    = await vigil.health();                       // trends digest (07)

// event stream for live UIs / streaming reporters
vigil.events.on("route:complete", (r) => log(r.route, r.status));
vigil.events.on("run:budget", (b) => warn(b));
```

`RunResult` and all types are exported and documented in 09-data-models.md.

## Configuration: `vigil.config.ts`

Typed, discoverable, zero-required-fields beyond `url` (which the CLI can supply). Full surface:

```ts
import { defineConfig } from "vigil";

export default defineConfig({
  url: process.env.TARGET_URL,

  discovery: {
    adapters: "auto",                    // or ["nextjs"], or a custom adapter instance
    crawl: { depth: 3, maxPages: 200 },
    include: ["/**"],
    exclude: ["/admin/**", "/api/**"],
    criticalRoutes: ["/", "/login", "/checkout"],   // P0
    sampleParams: { "/products/:id": ["42", "7"] },
  },

  auth: {
    login: async (page) => { /* …see 03… */ },
    probeRoute: "/dashboard",
  },

  budgets: {
    maxPages: 100,
    maxRunMinutes: 15,
    maxLlmCostUsd: 2.0,
    concurrency: 4,
  },

  safety: {
    allowSubmit: [],                     // routes where form submission is permitted
    allowDestructive: false,
    blockedRoutes: ["/admin/**"],
    denylistExtra: [/unsubscribe/i],
  },

  judgment: {
    fingerprintHitThreshold: 0.90,
    consoleErrorAllowlist: [/ResizeObserver loop/],
    visualDiffThreshold: 0.02,
    latencyHeadroom: 2.0,
    healHumanSpecs: false,
  },

  model: {
    provider: "anthropic",               // or a ModelClient instance
    exploreModel: "claude-sonnet-4-6",   // workhorse
    triageModel:  "claude-haiku-4-5",    // cheap, structured output
  },

  reporters: ["cli", slack({ webhook: process.env.SLACK_WEBHOOK, policy: "on-problem" })],

  store: { dir: ".vigil", cacheVersion: 1 },
});
```

## CLI (thin wrapper, complete list)

```
vigil init                      scaffold config + .gitignore entries
vigil run [--url] [--fail-on broken|degraded] [--no-ai] [--only <pattern>]
vigil discover                  print the Route Manifest (dry run of Phase 1)
vigil explore <pattern>         force exploration of one route
vigil invalidate <pattern|--all>
vigil health                    trends digest
vigil report [run-id]           open the HTML report
```

`--no-ai` is worth highlighting: runs hits + T1/T2/T4 checks only, misses become `UNVERIFIED`.
This is the mode for air-gapped CI, cost-zero scheduled re-runs between deploys, and for users
who want to review every generated asset in a PR before it goes live.

## Extension points (all stable interfaces)

| Interface | Purpose | Built-ins |
|---|---|---|
| `DiscoveryAdapter` | `(ctx) => DiscoveredRoute[]` | nextjs, react-router, vue, angular, sveltekit, sitemap, crawl |
| `Reporter` | `onRunComplete`, `onRouteComplete?` | cli, html, json, slack, jira, github |
| `ModelClient` | `complete(structured)` / `vision(...)` | anthropic, openai-compatible |
| `Check` | custom deterministic checks added to a lane, e.g. "every page has our CSP header" | — |
| `StoreBackend` | asset persistence | local-dir (v1); remote/shared later |

## The wrappers (built after the library, in this order)

1. **GitHub Action** — `uses: vigil/action@v1` with `url` input; wraps the CLI, uploads
   artifacts, comments summaries. The primary distribution channel — post-deploy sanity lives in
   pipelines.
2. **MCP server** (`vigil/mcp`) — exposes exactly: `run_sanity(url?, only?)`,
   `get_last_report()`, `explain_failure(route)`, `invalidate(route)`. Each is a direct call into
   the composable core. This makes vigil usable from Claude Code / any MCP client: an agent
   deploys, then self-verifies. A Claude Code skill file documenting when to call it ships in the
   same package.
3. **Scheduler recipe** (docs, not code): cron + `vigil run --no-ai` = free continuous sanity
   between deploys.
4. **VS Code extension** — last, and mostly UI over `report.json` + the Playwright trace viewer.

## Versioning & stability promises

- SemVer. The stable surface = everything in this document + the types in 09.
- The **asset format** carries its own `cacheVersion`; vigil always migrates old stores forward
  and never requires regeneration on library upgrades unless a major version says so loudly.
- Generated specs pin no vigil imports — they are plain `@playwright/test` files forever
  (the escape-hatch guarantee).

Next: [09-data-models.md](09-data-models.md) — the precise types.
