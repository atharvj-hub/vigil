# 06 — Judgment, Triage, and Healing

Detection is easy; **deciding what a failure means** is the hard problem that determines whether
anyone trusts the tool. This document defines the check hierarchy, the triage decision procedure,
the healing loop, and flake control.

## The check hierarchy (recap, with authority levels)

| Tier | Checks | Cost | Authority |
|---|---|---|---|
| T1 free signals | HTTP status, console errors, failed resources, blank-render, error-boundary markers | ~0 | can set RED alone |
| T2 contract | API status/latency/schema/absence vs. `contract.json` | ~0 | can set RED alone |
| T3 spec | saved Playwright assertions & interactions | ~0 | can set RED **after** Triage |
| T4 visual | pixel diff vs. baseline outside masks | ~0 | can set YELLOW alone; RED only with corroboration |
| T5 model | VLM before/after judgment | $ | **never** sets RED alone; informs Triage only |

The asymmetry is deliberate: tiers whose failures are near-unambiguous (a 500, an uncaught
exception) act directly; tiers with ambiguity (a locator not found — did the app break or did the
button get renamed?) must pass through Triage.

## Triage: `APP_BROKEN` vs `TEST_STALE` vs `FLAKY`

Input: the failure bundle — failing check(s), Playwright trace, console log, network recording,
current vs. stored fingerprint (+ similarity), current screenshot vs. baseline.

### Stage 1 — deterministic rules (no LLM), evaluated in order

| # | Rule | Classification |
|---|---|---|
| 1 | any T1/T2 red fired alongside the spec failure | **APP_BROKEN** (the spec failure is a symptom) |
| 2 | spec failed on locator-not-found AND fingerprint similarity < 1.0 AND the a11y-tree diff shows a *renamed/moved* interactive node with matching role near the old position | **TEST_STALE** (locator drift) |
| 3 | visual diff failed but fingerprint HIT and T1–T3 all green | **TEST_STALE** (visual — auto-refresh baseline, see 04) |
| 4 | spec failed on timeout AND network recording shows a first-party request pending > budget | **APP_BROKEN** (hung dependency) |
| 5 | failure is in the known-flaky signature list for this asset (same assertion, same symptom as a previously confirmed flake) | **FLAKY** (fast-path) |

Measured ambition: rules should resolve ~80% of failures. Every rule outcome logs which rule fired
— triage is explainable.

### Stage 2 — retry probe
Unresolved failures get **one retry in a brand-new browser context** (fresh everything except
auth). Pass on retry → provisional **FLAKY** (strike recorded; see below). Same failure twice →
Stage 3.

### Stage 3 — LLM triage (the ambiguous residue)
One structured call: the model receives the failure bundle summaries (a11y-tree diff, the failing
assertion, relevant network exchanges, before/after screenshots) and must return
`{ classification, confidence, reasoning, suggestedFix? }`. Policy:
- `APP_BROKEN` at confidence ≥ 0.7 → red, with the model's reasoning included as *supporting*
  evidence next to the hard evidence (never as the only evidence shown).
- `TEST_STALE` → Healer.
- confidence < 0.7 either way → route reported **`SUSPECT`** (yellow) with the full bundle:
  "vigil can't tell whether this is real — human, look here." Honest uncertainty beats a coin flip;
  a SUSPECT still prevents a HEALTHY verdict.

## The Healer

Input: the spec, old + new fingerprints/trees, the failure trace, Triage's `suggestedFix`.

Loop (≤2 attempts):
1. Produce a **minimal patch** to the spec — re-anchor the failing locator(s) to the moved/renamed
   node, adjust an assertion that referenced changed structure. The Healer must not add or remove
   test *intent*; it repairs bindings. (Enforced by prompt + a diff-size guard: a patch touching
   >40% of spec lines is rejected and treated as heal-failure.)
2. Run the patched spec in a fresh context.
3. Pass → commit: spec updated, fingerprint updated to current, visual baseline refreshed,
   `meta.history` gets `{ event: "healed", diff, reason }`. Route reports **green with a `healed`
   annotation** — visible in the run summary ("2 specs auto-healed"), so humans can audit drift.
4. Two failures → demote asset to `draft`, schedule full re-exploration next run, report route
   `UNVERIFIED` (yellow) this run.

Human-authored specs (`createdBy: human`): the Healer computes the patch but does **not** apply it
by default — it attaches the proposed diff to the report instead (`healHumanSpecs: true` opts in).

### Why heal instead of just re-exploring
Re-exploration regenerates intent from scratch — it may test *different* things than before,
silently narrowing coverage. Healing preserves accumulated intent (including any human edits) and
costs one small LLM call instead of a full exploration. Re-exploration is the fallback, not the
first resort.

## Flake control

Flakiness is the tax every E2E system pays; vigil's budget for it:

- **Strikes:** each provisional FLAKY adds a strike to the asset (`meta.flakes`). Strikes decay
  (one removed per 10 clean runs).
- **3 strikes → quarantine:** the spec is skipped; the route still gets T1/T2/T4 checks every run
  (so real breakage on that page is still caught) and reports yellow with reason `quarantined`.
  Quarantine automatically schedules a re-exploration (a fresh spec often avoids the flaky
  assertion pattern); two consecutive clean generations lift it.
- **Environmental flake detection:** if >30% of routes fail in one run with network-error
  signatures, the Orchestrator declares the *run* suspect (target or network issue), retries the
  run once after a backoff, and reports `INCONCLUSIVE` rather than a sea of red. A sanity tool
  must recognize when it, not the app, is having the bad day.
- **Determinism hygiene baked into generated specs:** auto-waiting locators only, no fixed sleeps,
  animations disabled, clock APIs available for freezing time on pages the Explorer flags as
  time-sensitive.

## Worked triage examples

**A. Button renamed.** Deploy renames "Sign up" → "Create account". Spec fails
`getByRole("button", { name: /sign up/i })`. T1/T2 green. Rule 2 matches (same-role node, new
name, same region). → TEST_STALE → Healer patches one locator → re-run passes → green,
annotated `healed: locator "Sign up"→"Create account"`. Zero human minutes.

**B. JS chunk 404.** Deploy ships HTML referencing a stale hashed bundle. T1 fires (failed
first-party resource + blank render) before the spec even runs. Rule 1 → APP_BROKEN, evidence:
the 404'd URL. Red in seconds.

**C. Payment API degraded.** Page renders, spec passes, but `POST /api/payment/intent` (critical,
recorded 2xx, budget 800ms) now takes 9s and 504s intermittently. T2 fires. → APP_BROKEN with the
endpoint, both symptoms, and the trace.

**D. Full redesign of /pricing.** Similarity 0.41 → not a triage case at all: cache MISS
(rebuild) → Explorer regenerates. Report shows `re-explored (major change)` — informative, not
alarming.

**E. Genuinely ambiguous.** Spec's "recent orders" table assertion fails; table region absent;
T1/T2 green; retry fails identically. LLM triage: could be a feature removal (stale) or a broken
widget (broken); confidence 0.55. → SUSPECT, yellow, bundle attached. A human looks once, deletes
the asset if the feature is gone (universal regenerate button), done.

Next: [07-reporting.md](07-reporting.md) — verdicts, artifacts, and integrations.
