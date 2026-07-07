# 05 — Execution: the two lanes, the Runner, and the Explorer

Execution is where a browser actually visits pages. This document covers the central efficiency
trick (two lanes, one visit), then each executor, then the safety model for running against
production.

## One visit, two lanes

vigil never makes "API tests" and "UI tests" as separate traffic. Every page visit is *observed*
in two dimensions simultaneously:

```
                   browser context opens page
                             │
        ┌────────────────────┼─────────────────────┐
        │                    │                     │
  NetworkRecorder      page renders           spec/explorer
  (attached before     (console, DOM,         interacts
   first byte)          pixels observed)
        │                    │                     │
        ▼                    ▼                     ▼
    API LANE              UI LANE            UI LANE (behavioral)
  every request        render integrity      elements respond
  checked against      checked against       as the spec asserts
  the contract         baselines
```

This mirrors reality: the API calls that matter for sanity are *the ones pages actually make*.
Testing them via the page catches what endpoint-list pinging can't — wrong payloads sent by the
new frontend build, auth headers missing, CORS breakage, an endpoint the page calls that nobody
documented.

### The API lane in detail

`NetworkRecorder` attaches `page.on("request"/"response"/"requestfailed")` before navigation and
captures for every exchange: method, normalized URL (IDs → `:param`, matched against known route
params), status, timing, request/response size, content-type, and — for JSON under a size cap —
the body (immediately reduced to a **shape**, see below; raw bodies are not persisted).

**On a miss**, the recording becomes the route's `contract.json`:

```jsonc
{
  "endpoints": [
    {
      "key": "GET /api/products/:id",
      "expectStatus": "2xx",            // status *class* observed
      "latencyBudgetMs": 1200,          // p95 of observations × headroom (2×)
      "schema": {                        // structural shape, inferred
        "type": "object",
        "required": ["id", "name", "price"],
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "price": { "type": "number" },
          "tags": { "type": "array", "items": { "type": "string" } }
        }
      },
      "critical": true                   // page render depended on it (see below)
    }
  ],
  "thirdParty": "observe-only"           // analytics/CDN domains: recorded, never failed on
}
```

Schema inference is mechanical (no LLM): merge shapes across observed samples; fields present in
all samples → `required`; value types unioned. **Criticality** is inferred by the Explorer: an
endpoint whose failure would visibly break the page (it feeds the main content) is `critical`;
a "recently viewed" widget call is not — non-critical endpoint failures degrade the route to
yellow, not red.

**On every run (hit or miss)**, `ApiJudge` checks the visit's recording against the contract:

| Check | Red when |
|---|---|
| Status | recorded 2xx endpoint now returns 4xx/5xx (critical) — non-critical → yellow |
| New failures | any first-party request fails with 5xx or network error, even if not in contract |
| Latency | exceeds budget (yellow at 1×, red at 3× on critical) |
| Schema | previously-required field missing, or type changed (additions are fine — append-tolerant) |
| Absence | a `critical` endpoint was not called at all (the code path is gone or broke before fetch) |

Contract drift that isn't a failure (endpoint consistently no longer called, new endpoint appears
consistently) is folded back into the contract after 3 consistent runs, annotated — the same
self-maintenance philosophy as visual masks.

### The UI lane in detail

Three sublayers, cheap to expensive:

**1. Render-integrity signals (free, every visit, no asset needed):**
- zero uncaught exceptions / `console.error` (allowlist configurable — some apps are noisy)
- zero failed first-party resource loads (the classic "JS chunk 404 → blank page")
- document reached `networkidle` within bound; no infinite spinner heuristic (loading indicator
  role still present after settle)
- body has non-trivial rendered content (guards the blank-white-screen-with-200 case)
- no framework error boundary / error page markers (`"Application error"`, configurable patterns)

These alone catch a large share of real post-deploy breakage, work on routes with no cached asset
yet, and cost nothing. They are why Phase-1 vigil (pre-AI) is already useful.

**2. Structural & behavioral assertions (the saved spec):** see Runner below.

**3. Visual comparison:** screenshot at a fixed viewport with animations disabled and fonts
awaited, pixel-diffed (SSIM-style, anti-aliasing tolerant) against `baseline.png` outside the
`masks.json` regions. Diff ratio > threshold → a *visual* check failure → Triage (which, remember,
auto-refreshes baselines for intentional-looking changes — see 04).

**VLM escalation (rare, capped):** only when signals conflict — e.g. all deterministic checks pass
but visual diff is large and structural similarity is mid — a single vision-model call is made:
"here is before/after; is the page broken or redesigned?" Its answer routes Triage; it alone never
sets red. Budgeted at ≤1 call per route per run.

## The Runner (cache hit path)

Executes `spec.ts` in the already-open context via Playwright's programmatic runner. What a
generated spec looks like — deliberately boring, idiomatic Playwright:

```ts
// .vigil/assets/products-_id/spec.ts — generated by vigil explorer v1 · 2026-07-04
// route: /products/:id
import { test, expect } from "@playwright/test";

test("product page renders and responds", async ({ page }) => {
  await page.goto("/products/42");

  // load-bearing structure
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /add to cart/i })).toBeEnabled();
  await expect(page.getByRole("img", { name: /product/i })).toBeVisible();

  // safe interaction: gallery responds
  await page.getByRole("tab", { name: /details/i }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();

  // safe interaction: add-to-cart is wired (asserts the request fires; state restored by context teardown)
  const cartCall = page.waitForRequest(/\/api\/cart/);
  await page.getByRole("button", { name: /add to cart/i }).click();
  await cartCall;
  await expect(page.getByRole("status")).toContainText(/added/i);
});
```

Runner conventions:
- specs receive `page` already authenticated and `baseURL` injected — they are portable
  (`npx playwright test .vigil/assets` works standalone, by design: the escape hatch).
- per-spec timeout (default 30s); a timeout is a failure with trace, not a hang.
- trace/video capture: `retain-on-failure`.

## The Explorer (cache miss path)

An LLM agent operating the browser through semantic actions, with a hard-bounded loop:

```
snapshot = a11y tree of page
repeat (≤ maxActionsPerExploration):
    plan   = LLM(snapshot, goal, action history, safety rules)
    action = plan.next            // click(role,name) | fill(label, synthetic) | press | navigate | scroll | done
    execute(action);  snapshot = re-read
until plan says done
emit asset: spec.ts + criticality annotations + masks + fingerprint
```

Its goal prompt is fixed and narrow — this is a *sanity* explorer, not a QA brain:
1. Identify what this page is for and its load-bearing elements (the things whose absence means
   "broken page" to a user).
2. Exercise each *safe* primary interaction once (open menu, switch tab, focus form, type into
   search) to confirm the page responds.
3. Note dynamic regions (for masks) and which network calls fed the main content (for criticality).
4. Emit the spec: resilient locators only (`getByRole`/`getByLabel`/`getByText`; `data-testid` if
   present; **never** CSS/XPath paths), assertions ordered structure → behavior.

Generated specs are immediately self-checked (run once); only passing specs go `active`. The
LLM sees only accessibility snapshots (compact, cheap) — screenshots are attached only on the
final "review your spec against the page" step and for pages the a11y tree can't represent
(canvas-heavy apps), keeping token cost low.

## The safety model (running against production)

vigil's default posture is **read-mostly**. The Explorer and generated specs obey, in order:

1. **Never** navigate off-origin; never open external links.
2. **Never** click elements matching the destructive denylist: names matching
   `/delete|remove|cancel subscription|pay|purchase|confirm order|send|publish|transfer/i` and
   anything `role=button` inside `role=alertdialog`. Configurable, but the denylist can only be
   extended, not disabled, unless `allowDestructive: true` (intended for staging).
3. Forms: fill with clearly synthetic data (`vigil-test+<runid>@example.invalid`) and **abandon**
   — submission requires the form's route to be in `allowSubmit` config.
4. GET/HEAD network requests are always fine; the Explorer treats an interaction that fired a
   POST/PUT/DELETE it didn't expect as a signal to back off that element and note it.
5. `blockedRoutes` config (e.g. `/admin/**`) is enforced at the context level (request
   interception), not just by convention.
6. Everything the Explorer did is in the trace — full auditability of agent behavior.

Recommended deployment patterns, documented for users: run against a staging mirror with
`allowDestructive` if you want deep interaction coverage; run against production with defaults for
breadth; or both (two config profiles).

Next: [06-judgment-and-healing.md](06-judgment-and-healing.md) — how failures are classified,
healed, and kept honest.
