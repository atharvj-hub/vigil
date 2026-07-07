# 04 — The Test Asset Cache

This is the heart of vigil. The cache is what turns "an AI agent that tests your app" (slow,
costly, non-deterministic) into "a deterministic suite that writes and maintains itself."

## Mental model

Think of the LLM as a **compiler** and Playwright as the **runtime**. Source code = the live page.
Compiled artifact = the asset (spec + baselines). You don't recompile on every execution — only
when the source changed. The fingerprint is how we detect that the source changed.

```
                     page visited
                          │
                 compute fingerprint
                          │
            ┌─────────────┴──────────────┐
      asset exists?                 no asset
            │                            │
   similarity(new, stored)              MISS
      ┌─────┴─────┐                      │
   ≥ 0.90      < 0.90               Explorer compiles
      │             │                a new asset
     HIT          MISS (drift)           │
      │             │                    │
  run spec     re-explore,          save to store
  ($0, fast)   replace asset
```

## What exactly is cached: the Asset

One directory per route under `.vigil/assets/<route-slug>/`:

| File | Lane | Contents |
|---|---|---|
| `spec.ts` | UI | A plain Playwright spec. Structural assertions + safe interactions for this route. Human-readable, editable, deletable. |
| `contract.json` | API | The recorded API baseline: endpoints this page calls, expected status classes, latency budgets (p95 from recordings), response schemas. |
| `fingerprint.json` | — | The structural hash + a compact serialized tree (needed to compute *similarity*, not just equality, and to give the Healer a diffable "before"). |
| `baseline.png` | UI | Visual baseline screenshot (stable viewport, animations disabled, fonts loaded). |
| `masks.json` | UI | Bounding boxes of dynamic regions (timestamps, avatars, ads, live counters) excluded from visual diff. Identified by the Explorer + refined automatically (see below). |
| `meta.json` | — | Status (`active`/`draft`/`quarantined`/`archived`), createdBy (`explorer`/`healer`/`human`), history log, flake strikes, last N run outcomes. |

And one global file, `.vigil/index.json` — the route index: `pattern → { slug, status, fingerprintHash,
lastVerified }`. Small, loaded once per run, the cache's table of contents.

Everything except `.vigil/auth/` and `.vigil/runs/` is **committed to git**. Consequences, all
intentional:
- Asset changes show up in PRs → the team reviews what the agent decided to test.
- CI machines get the cache for free via checkout → no cold start per machine.
- `git log .vigil/assets/checkout/` is the audit history of how testing of that page evolved.
- Hand-written specs can be dropped into an asset dir (`createdBy: "human"` in meta) — the Runner
  treats them identically, and the Healer asks before modifying them (config: `healHumanSpecs: false`
  by default; it reports "stale human spec" instead).

## The Fingerprint

### Requirements
The cache key must be **stable across content changes** (new blog posts, different prices, other
users' data must NOT invalidate) and **sensitive to structural changes** (redesigned nav, removed
form, new error boundary MUST invalidate). Raw DOM hashing fails both ways; screenshots fail the
first. The right substrate is the **accessibility tree** — it's what the Explorer reasons over and
what the spec's locators (`getByRole`, `getByLabel`) bind to. If the a11y tree is stable, the spec
almost certainly still runs.

### Algorithm
1. Capture the accessibility snapshot after network-idle (Playwright provides this).
2. **Normalize** each node to `(role, structural-name?, landmark?)`:
   - keep roles (`navigation`, `button`, `textbox`, `main`, …)
   - keep names only for *interactive* elements (`button "Add to cart"`), because those names are
     what locators bind to; drop names of text/content nodes entirely
   - drop everything user-content-like: text values, image alts in content areas, counts
   - collapse **repetition**: ≥3 consecutive siblings with identical normalized subtrees (a product
     grid, a comment list) become one node annotated `×N` with N bucketed (`1, 2-5, 6-20, 20+`) —
     so going from 12 products to 14 doesn't invalidate, but going to 0 does.
3. Serialize the normalized tree canonically (depth-first, sorted attributes).
4. `fingerprint.hash = sha256(serialized)` — used for the fast exact-match path.
5. `fingerprint.tree = serialized` (compact) — used for similarity when hashes differ.

### Similarity, not equality
When hashes differ, compute **tree similarity** ∈ [0,1] via top-down weighted matching: node match
score decays with depth (a changed `<main>` child matters more than a leaf), interactive nodes
weigh 3× text-structure nodes, and the score is the matched weight / total weight (an
edit-distance-on-trees approximation that runs in milliseconds on normalized trees, which are
small — hundreds of nodes, not tens of thousands).

Decision thresholds (configurable):

| similarity | Decision | Rationale |
|---|---|---|
| = 1.0 (hash equal) | HIT | nothing structural changed |
| ≥ 0.90 | HIT | cosmetic drift; if the spec then fails, Triage/Healer handle it with full context |
| 0.60 – 0.90 | MISS (drift) | page meaningfully changed → re-explore; old asset kept as `previous/` for one generation so the Healer & report can diff |
| < 0.60 | MISS (rebuild) | effectively a new page |

Why HIT at 0.90 instead of demanding equality: the spec running is the real test. Fingerprints
route work; they are not themselves the verdict. A spec that still passes on a 0.93-similar page
is a better outcome (zero cost) than a reflexive re-exploration.

## Cache lifecycle & invalidation

### Events that touch an asset

| Event | Effect |
|---|---|
| Explorer generates + self-check passes | asset created/replaced, `status: active` |
| Explorer generates, self-check fails | `status: draft`, route reported `UNVERIFIED` |
| Healer repairs successfully | spec/fingerprint/baseline updated, history entry `healed` |
| Healing fails twice | `status: draft`, scheduled re-exploration next run |
| 3 flake strikes (see 06) | `status: quarantined` — spec skipped, route still gets lane checks (API contract + console/visual), reported yellow until re-explored |
| Route vanished 10 consecutive runs | `status: archived` (moved to `.vigil/archive/`) |
| User edits spec.ts by hand | detected via content hash in meta → `createdBy: human`, healer hands-off |
| User deletes asset dir | plain cache miss next run — deletion is the universal "regenerate" button |

### Explicit invalidation
`vigil invalidate <route-pattern|--all>` marks assets for re-exploration. Intended for "we
redesigned the whole app" moments. Also: `vigil.config.ts` carries `cacheVersion`; bumping it
invalidates everything (schema migrations of vigil itself do this automatically).

### Baseline refresh policy
Visual baselines and contracts go stale *legitimately* (marketing changes the hero image; an API
adds a field). Policy:
- **Contracts are append-tolerant by default**: new fields in responses don't fail; missing
  previously-seen required fields, status regressions, and latency blowups do. (Schema details in 05.)
- **Visual baselines auto-refresh on intentional change**: if the visual diff fails but the
  structural fingerprint is a HIT and all functional checks pass, Triage calls it `TEST_STALE
  (visual)`, and the baseline is refreshed with a `baseline-updated` annotation in the report —
  visible, never silent. If structure *and* pixels changed together with functional failures,
  that's evidence toward `APP_BROKEN`.

### Mask auto-refinement
If the same pixel region diffs on ≥3 consecutive *passing* runs, it's dynamic content the Explorer
missed → automatically added to `masks.json` (annotated in the report once). This is how visual
checking stays quiet without a human curating masks.

## Concurrency & integrity

- Writes go through `AssetStore` with per-asset advisory locks (two workers never write one asset;
  routes are sharded across workers anyway).
- Every write is atomic (temp file + rename). `index.json` is rebuilt from asset dirs if corrupt —
  asset dirs are the source of truth, the index is a cache of the cache.
- Store schema carries a version; vigil migrates forward automatically and refuses to run against
  a newer-versioned store than itself.

## Worked example

First run ever against a shop:

```
/               MISS → explored → asset created (6 LLM calls, 40s)
/products       MISS → explored → asset created
/products/:id   MISS → explored (sample /products/42) → asset created
/cart           MISS → explored → asset created
run: 4 misses, 0 hits · verdict HEALTHY · $0.31 · 3m10s
```

A week and 30 deploys later, marketing reworded the homepage hero and engineering broke the cart API:

```
/               hash≠, similarity 0.97 → HIT → spec passes, visual diff inside masks → green
/products       HIT (hash equal) → green
/products/:id   HIT → green
/cart           HIT → spec passes BUT contract check: POST /api/cart/summary → 500 (was 200)
                → Triage: deterministic rule "status regression on recorded endpoint" → APP_BROKEN
run: 4 hits, 0 misses · verdict BROKEN (/cart) · $0.00 · 22s
Slack: "❌ /cart — POST /api/cart/summary returning 500 (was 200). Trace attached."
```

The failure that mattered cost nothing to find and came with the exact endpoint. That's the system
working as designed.

Next: [05-execution.md](05-execution.md) — what the Runner and Explorer actually do on a page.
