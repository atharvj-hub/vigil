# 04 — Checks: what one page visit captures

A single browser visit yields everything the judge needs. This document specifies the Signals
(the deterministic evidence), the waiting strategy that keeps them trustworthy, and the optional
natural-language flows.

## One visit, every dimension observed

```
             browser context opens page
                        │
     ┌──────────────────┼──────────────────────┐
     │                  │                      │
 NETWORK            RUNTIME                RENDER
 (listeners         (console,              (heuristics +
  attached before    exceptions)            screenshot)
  first byte)
     │                  │                      │
     └──────────────────┴──────────────────────┘
                        ▼
              Signals + screenshot → Judge
```

The API calls that matter for sanity are *the ones pages actually make*. Observing them through
the page catches what endpoint-pinging can't: wrong payloads from the new frontend build, missing
auth headers, CORS breakage, a hung dependency stalling render.

## The Signals, precisely

### Network lane
Attached via `page.on("request" / "response" / "requestfailed")` **before** navigation:

| Captured | Detail |
|---|---|
| Document response | status, redirect chain, total time |
| Every request | method, URL (origin + path), resource type, status, duration, size |
| Failures | network errors (DNS, refused, aborted, timed out) and HTTP ≥ 400 |
| Classification | first-party vs third-party (third-party failures are recorded but flagged `observeOnly` — an ad blocker–destined analytics 404 must never fail a deploy) |
| Slow requests | anything over `latencyBudgetMs` (default 5000) flagged |

No response bodies are stored (privacy + size); status/shape problems already surface as
statuses and render effects.

### Runtime lane
| Captured | Detail |
|---|---|
| `console.error` entries | text, source URL, first 20 (deduped); allowlist configurable (some apps are noisy — `/ResizeObserver loop/` etc.) |
| Uncaught exceptions | `page.on("pageerror")` — message + stack head |
| Page crash | `page.on("crash")` — an instant hard failure |

### Render lane
| Captured | Detail |
|---|---|
| Rendered text length | `document.body.innerText.length` after settle — the blank-white-screen-with-200 guard |
| Error markers | framework error-boundary/error-page text patterns (`"Application error"`, `"Something went wrong"`, `"Internal Server Error"`, configurable additions) present in visible text |
| Stuck loading | elements with `role="progressbar"`/common spinner selectors still visible after settle |
| Title & h1 | for the judge's context and the report |
| Screenshot | viewport (1280×720 default), animations disabled, fonts awaited — the judge's primary evidence |

### Flow lane (optional)
Outcomes of user-defined flows on this page (below): per-step success/failure with the agent's
step log.

## The waiting strategy (flake control at the source)

Most E2E flakiness is timing. vigil's settle protocol, per page:

1. Await the `load` event (hard cap 15s — a timeout is itself a signal, not an exception).
2. Best-effort cookie-consent-banner dismissal (`checks.dismissCookieBanners`, default on): a
   fresh browser context has no consent state, so most real sites show a first-visit modal that
   would otherwise sit on top of every screenshot and render-heuristic capture — evidence about
   vigil's own capture, not the app. Click a known consent-accept control if one is visibly
   present; no-op if not found. Bounded, silent on failure, never blocks the rest of the visit.
3. Then await a **network-quiet window**: no more than 2 in-flight requests for 750ms, capped at
   10s total (long-polling/websockets exempted by resource type).
4. Then a **DOM-stability wait** (`checks.domStabilityWait`, default on): network-quiet alone is
   a known-unreliable readiness signal for client-rendered apps — there's often a gap where the
   JS bundle has finished downloading (network goes quiet) but is still parsing and mounting,
   producing zero network traffic in that gap. Poll a small render **fingerprint** every 200ms —
   `{ textLength, childElementCount, spinnerVisible, visibleHeadingCount, readyState }` — and
   capture once the whole fingerprint has held unchanged for a continuous 500ms window (any
   change resets the window — same pattern as the network-quiet wait above), capped at 8s.
   Text length alone was the first version of this and is a weak signal on its own: plenty of
   real UI updates don't change it — a skeleton swapped for real cards of similar length, a
   spinner replaced by an SVG, CSS revealing a hidden section, hydration fixing a broken button.
   The fingerprint's other four fields catch most of that class without a full DOM diff. This is
   the fix for two related failure classes discovered dogfooding against real SPAs: a page
   captured too early reads as falsely broken (H4, or a judge fail on a near-empty screenshot); a
   page captured mid-render on a site whose *other* requests happened to keep the network busy a
   little longer reads as falsely healthy (a judge pass on a half-rendered shell). Server-
   rendered pages are unaffected — their text (and the rest of the fingerprint) is complete on
   first paint, so this returns immediately.
   **A known limit, not a bug:** this is a heuristic, and it cannot distinguish "settled, nothing
   left to render" from "hasn't started rendering yet" for content that changes only once, long
   after an otherwise-static initial paint — no passive observation can, without knowing the
   future. What it reliably catches is content still actively mounting/changing right as
   network-quiet fires, which is the common real case. A fuller DOM diff/fingerprint (or a
   framework-specific "app ready" hook) would close more of this gap; not implemented here to
   keep the check cheap and framework-agnostic.
5. Then a fixed 250ms paint grace, animations disabled via `prefers-reduced-motion` emulation
   and CSS injection.
6. Capture. Total worst case ≈ 34s, typical ≈ 2–4s.

Late requests that complete after capture are still recorded (the listener stays until context
close) and marked `afterSettle` — visible to the judge, useful for hung-dependency evidence.

## Flows: interaction checks without test code

Sanity visits never interact. But some teams want a few load-bearing interactions verified —
"search works", "login form accepts input". Flows are the escape hatch, and they follow the
same stateless philosophy: **plain English in config, executed fresh every run by an AI browser
agent, nothing generated or stored.**

```ts
flows: [
  {
    page: "/",
    name: "search returns results",
    steps: [
      "type 'shoes' into the search box and submit",
      "expect a list of product results to be visible",
    ],
  },
]
```

Execution: each step is handed to Stagehand — `act()` for actions, `extract()`/`observe()` for
expectations — in the already-captured page's context. Stagehand is MIT-licensed, TypeScript,
built for exactly this "natural language → resilient browser action" job, and model-agnostic
through the same AI SDK gateway vigil already uses (see [09-prior-art.md](09-prior-art.md)).
vigil wraps it thinly: step outcomes + the agent's action log land in the page's Signals, and a
failed step is judged like any other failure evidence (with retry).

Flow steps obey the safety denylist ([03](03-discovery.md)) — a step that would click a
destructive element fails safe with an explanatory error unless explicitly allowed.

Flows cost more than sanity visits (a few agent turns each, roughly $0.01–0.05 per flow with a
small model) and are expected to number ~0–10 per app, on critical pages only. Zero flows is the
default and is fully useful.

## What deliberately does NOT exist here

- **No visual baseline diffing.** Baselines are stored state → staleness → mask curation → the
  machinery this design deleted. The judge looks at today's screenshot with fresh eyes; "does
  this look broken?" is exactly the fuzzy judgment a vision model is for. What pixel-diffing
  catches that this doesn't (a subtle CSS regression that still "looks fine") is regression
  testing, not sanity — an explicit non-goal.
- **No API contract store.** New 5xx/4xx and network failures on requests the page makes are
  caught absolutely, this run, from this run's evidence. What a stored contract adds (schema
  drift detection on 200s) is again regression territory, and was the second-largest source of
  stored-state complexity.

Next: [05-judgment.md](05-judgment.md) — how evidence becomes a verdict.
