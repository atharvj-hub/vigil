# 03 — Discovery & Auth

Discovery answers: **what pages does this application have?** Its output is the Page Set — a
deduplicated, bounded list of concrete URLs to visit. Everything downstream is only as good as
this list.

A deliberate simplification versus framework-integrated tools: vigil discovers **from the
outside only**. No source-code adapters, no AST parsing, no per-framework plugins. This is what
makes vigil work identically for Next.js, Rails, Django, WordPress, or a hand-rolled SPA — and
it removes an entire category of code to build and maintain. The trade-off (routes that are
unlinked *and* unlisted stay invisible) is covered honestly below.

## The three sources, merged

### Source 1 — Config routes (authoritative)
Users can list routes explicitly — the only way to guarantee coverage of critical pages:

```ts
discovery: {
  routes: ["/", "/pricing", "/checkout", "/products/42", "/products/7"],
}
```

Config routes are always visited, first, regardless of caps.

### Source 2 — Sitemap (cheap, usually present)
Fetch `{origin}/sitemap.xml` and any `Sitemap:` lines in `robots.txt`; follow sitemap indexes
one level deep. Parsing via `fast-xml-parser` (MIT, tiny). Every `<loc>` that is same-origin
joins the candidate list.

### Source 3 — Bounded crawl (fallback and gap-filler)
A Playwright-driven BFS from the start URL:

1. Visit page (bounded wait), collect `a[href]` same-origin links **and** client-side
   navigations (intercept `history.pushState`/`replaceState`) — this makes SPA discovery work.
2. Depth limit (default 2), page limit during discovery (default 100), politeness delay
   configurable. The crawl is **read-only**: it never clicks, submits, or executes interactions
   — it only reads hrefs from rendered HTML.

The crawl always runs (even when a sitemap exists) at shallow depth, because it finds what the
sitemap forgot and validates that listed pages are actually *linked*.

## Normalization & sampling

All candidates pass through one pipeline:

1. **Same-origin filter** (subdomains excluded unless `allowSubdomains: true`).
2. **Normalize:** strip fragments, strip tracking params (`utm_*`, `fbclid`, …), sort query keys.
3. **Include/exclude globs** from config (e.g. exclude `/admin/**`, `/api/**`, `/logout`).
4. **Parametric collapsing:** URLs whose paths differ only in one high-cardinality segment
   (numeric, UUID, long slug) are grouped; each group contributes `samplesPerPattern` URLs
   (default 2) instead of thousands. `/products/1 … /products/9999` → 2 samples. This is a
   simple segment-shape heuristic, not a framework guess — misgrouping costs at most a few
   extra or fewer visits, never correctness.
5. **Priority & cap:** config routes → shallow crawl depth → sitemap order, capped at `maxPages`.
   Pages beyond the cap are reported `skipped`.

### Honest limitation
A page that is behind a runtime condition (feature flag, role), unlinked, and absent from the
sitemap will not be discovered. The fix is one line in `discovery.routes`. vigil's report lists
the source of every page it visited, so coverage is inspectable, and the crawl+sitemap union in
practice covers the overwhelming majority of real apps.

## Authentication

Most real apps hide everything interesting behind login, so auth is first-class.

### The mechanism: storage state, established once per run
Playwright serializes cookies + localStorage (`storageState`). vigil logs in **at most once per
run**, keeps the state in memory (optionally persisted to `.vigil-auth.json`, gitignored, `0600`
perms, for reuse across runs), and starts every browser context from it.

### Three ways to establish it, tried in order

1. **Reuse:** if a persisted state exists, probe one `requiresAuth` route; no bounce to login →
   done. Zero cost, the common case between closely-spaced deploys.
2. **Scripted login:** the user supplies a function — the only code a vigil user can ever write,
   and it's optional:
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
3. **AI-agent login (zero-config):** if `VIGIL_USER`/`VIGIL_PASS` are set but no script is given,
   vigil hands the login page to a Stagehand agent with the single goal "log in with these
   credentials" (credentials injected as variables, never into the prompt/LLM — Stagehand
   supports variable substitution precisely for this). The resulting storageState is used for
   the run. True to the stateless philosophy, nothing is generated or saved — at most the
   storageState itself is cached as in (1).

Out of scope for v1, acknowledged: SSO with MFA (use a test account with MFA disabled; TOTP
support is a cheap follow-up), multiple roles (v2: run once per role's storageState).

### Credential safety rules
- Credentials come only from environment variables; plaintext secrets in config are rejected.
- Credentials are never sent to the model. Agent login uses variable substitution; the judge
  never sees auth headers.
- Screenshots and reports redact `Authorization`/`Cookie` headers and any response field
  matching a configurable denylist (`password`, `token`, `secret`, …).

## Safety model (running against production)

The rules are short because the default behavior is inherently safe:

1. **Sanity visits perform zero interactions.** GET navigation, observation, screenshot. Nothing
   is clicked, typed, or submitted — there is nothing to allowlist.
2. **The crawler follows links via fresh navigations** (never clicks), same-origin only, and
   respects `exclude` globs at the request level (e.g. `/logout`, `/admin/**` are never fetched).
3. **Interactions exist only in user-authored flows and agent login.** Those agent actions obey a
   non-disableable destructive denylist — elements whose accessible name matches
   `/delete|remove|cancel subscription|pay|purchase|confirm order|transfer/i` are never clicked
   unless the flow's own text explicitly names them **and** config sets `allowDestructive: true`
   (intended for staging).
4. Everything an agent did is recorded step-by-step in the report — full auditability.

Next: [04-checks.md](04-checks.md) — what gets captured on every visit.
