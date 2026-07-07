# 03 — Discovery

Discovery answers: **what pages does this application have?** Its output is the Route Manifest.
Everything downstream — caching, execution, reporting coverage — is only as good as this list, so
discovery uses three tiers and merges them, rather than betting on one technique.

## Output: the Route Manifest

```ts
interface RouteManifest {
  routes: DiscoveredRoute[];
  sources: ("code" | "sitemap" | "crawl" | "manual")[];
  generatedAt: string;
}

interface DiscoveredRoute {
  pattern: string;          // "/products/:id"  — normalized, the cache key's first half
  samples: string[];        // ["/products/42", "/products/7"] — concrete URLs to visit
  source: "code" | "sitemap" | "crawl" | "manual";
  requiresAuth: boolean;    // learned (redirect-to-login probe) or configured
  priority: number;         // 0 = critical … 3 = low; drives scheduling under budgets
}
```

Key idea: vigil tests **routes**, not URLs. `/products/1 … /products/9999` is one route with a
couple of sampled instances. This is what keeps a 50,000-URL store testable in one minute.

## Tier 1 — Code route extraction (best: complete and free)

If vigil runs inside the repo (the normal case for a library in the deploy pipeline), it can read
the routing source of truth directly. Framework adapters, each a small pure function
`(projectDir) => DiscoveredRoute[]`:

| Framework | Extraction strategy |
|---|---|
| Next.js (app router) | walk `app/**/page.{tsx,jsx}`; folder segments → pattern; `[id]` → `:id`; `[...slug]` → wildcard |
| Next.js (pages router) | walk `pages/**`, same mapping |
| React Router | parse `createBrowserRouter` / `<Route path>` via a light TS AST pass |
| Vue Router / Nuxt | routes array / `pages/` directory convention |
| Angular | `Routes` arrays in `*-routing.module.ts` |
| SvelteKit | `src/routes/**/+page.svelte` |
| Express/Fastify (SSR) | registered GET routes rendering HTML |

Adapters are a public extension point (see 08) so the community can add frameworks. Detection is
automatic: look at `package.json` dependencies, run every adapter that matches, merge.

Dynamic segments need concrete samples to visit. Sources, in order: examples given in config
(`sampleParams`), IDs harvested from links found during crawling (tier 3 feeds back into tier 1's
routes), and sitemap URLs that match the pattern.

## Tier 2 — Sitemap & well-known sources (cheap, often present)

Fetch and parse `sitemap.xml` (following index sitemaps), `robots.txt` `Sitemap:` lines. Every URL
is normalized (strip tracking params, sort query keys) and **clustered into patterns**: URLs whose
paths differ only in segments that look like IDs (numeric, uuid, slug-with-hash) collapse into one
route with those URLs as samples. Clustering algorithm: split path into segments; a segment column
across many URLs with high cardinality and consistent shape → parameter.

## Tier 3 — Bounded crawl (fallback and gap-filler, always runs shallowly)

A Playwright-driven BFS from the start URL:

1. Visit page (network-idle bounded at 10s), collect `a[href]` same-origin links **and**
   client-side navigations (intercept `history.pushState`) — this is what makes SPA discovery work.
2. Normalize + cluster into patterns exactly as tier 2.
3. Depth limit (default 3), page limit (default 200 visited during discovery), politeness delay
   configurable.

The crawl runs even when tiers 1–2 succeeded, at shallow depth, for two reasons: it validates that
statically-known routes are actually *linked and reachable* (an orphaned page is itself a finding),
and it discovers routes that exist only behind runtime conditions (feature flags, role-based nav).

### Special-case: pages that require interaction to reach
Some "pages" are modals/steps not addressable by URL (e.g. step 2 of a wizard). Discovery does not
chase these — they belong to the *spec* of their parent route: when the Explorer investigates
`/checkout`, its generated spec walks the reachable steps. Discovery finds URLs; exploration finds
depth within a URL.

## Merging and the vanished-route rule

`pattern` is the merge key; code-derived entries win on metadata conflicts (they know `requiresAuth`
and params best). Routes present in the Asset Store's index but absent from this run's manifest are
marked **vanished**: reported (a disappeared page is exactly the kind of thing a sanity check must
say out loud), asset kept for 10 runs (grace period for flaky discovery), then archived.

## Authentication

Most real apps hide everything interesting behind login, so auth is first-class, not an afterthought.

### The mechanism: storage state, established once
Playwright can serialize cookies + localStorage (`storageState`). vigil logs in **once per run at
most** (and reuses a previous state if it still works), saves the state to
`.vigil/auth/storageState.json` (gitignored), and starts every browser context from it.

### Three ways to establish the state, tried in order

1. **Reuse:** load saved state, probe a `requiresAuth` route; if it doesn't bounce to login, done.
   Zero cost, the common case.
2. **Scripted login (recommended):** the user supplies a tiny function in config — the only code a
   user ever writes for vigil, and it's optional:
   ```ts
   auth: {
     login: async (page) => {
       await page.goto("/login");
       await page.getByLabel("Email").fill(process.env.VIGIL_USER!);
       await page.getByLabel("Password").fill(process.env.VIGIL_PASS!);
       await page.getByRole("button", { name: "Sign in" }).click();
       await page.waitForURL("/dashboard");
     },
     probeRoute: "/dashboard",
   }
   ```
3. **Agent-assisted login (zero-config):** if credentials are provided (`VIGIL_USER`/`VIGIL_PASS`)
   but no script, the Explorer performs the login agentically once — and then **generates the
   scripted version** and saves it to `.vigil/auth/login.generated.ts`, so subsequent runs use
   path 2. The cache philosophy applied to auth itself.

Out of scope for v1, acknowledged: SSO with MFA (recommend a test account with MFA disabled or a
TOTP secret in config — TOTP generation is a cheap v1.1), multiple roles (v2: run matrix of
storage states, assets keyed per role).

### Credential safety rules
- Credentials only ever come from environment variables; vigil refuses plaintext secrets in config.
- Storage state and run artifacts are written with `0600` perms and auto-gitignored by `vigil init`.
- Traces/screenshots for *reporting* redact `Authorization`/`Cookie` headers and any response field
  matching a configurable denylist (`password`, `token`, `secret`, …) before leaving `.vigil/runs/`.

## Priorities

Under budget pressure, order matters. Default priority assignment:
- P0: routes listed in `criticalRoutes` config (e.g. `/`, `/login`, `/checkout`)
- P1: routes reachable ≤1 click from home; routes with a cached asset (cheap to verify)
- P2: everything else
- P3: pattern samples beyond the first per route

Scheduling: all P0/P1 hits, then P0/P1 misses, then P2 hits, … Budgets exhaust from the bottom.

Next: [04-cache.md](04-cache.md) — the asset store and the fingerprint algorithm.
