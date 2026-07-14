# Phase 2 Implementation Plan — The Judge

> Goal (roadmap §Phase 2): the AI verdict layer, end to end. ModelGateway (AI SDK),
> judge prompt + zod schema, confidence policy, cost metering, `maxModelCostUsd`
> enforcement, `unjudged` degradation, provider auto-detection from env.
>
> **Exit criterion:** on dogfood apps with seeded breakages (error toast with 200s,
> half-rendered page, dead widget), judge catches ≥ 90% with zero false BROKENs
> across 100 clean runs; per-page judge cost ≤ $0.006.

This plan is written against the merged Phase 1 code (orchestrator, collector,
hard rules, data-fidelity, reporter, CLI — all green, 67 unit tests). It changes
**one seam in the orchestrator** and adds a self-contained `src/judge/` subtree;
Phase 1 determinism, the "zero false reds" guarantee, and the report schema are
preserved.

---

## 1. What already exists (do not rebuild)

- `PageResult.judge?: JudgeVerdict`, `.unjudged?`, `.decidedBy`, `.cost.judgeUsd`,
  `timings.judgeMs` — the **types are already forward-compatible** (`src/types.ts`).
  Phase 2 populates them; `report.json` schemaVersion stays `1`.
- `config.model` accepted + validated (loose `z.any()`), `budgets.maxModelCostUsd`
  (default $2), `RunResult.cost.{modelCalls,modelUsd}` — all present, currently
  hardcoded to 0.
- Retry protocol, flake handling, environmental override (H1 ≥50%) — reused as-is,
  extended to cover judged fails.

So Phase 2 is **additive**: no data-model migration, no report-consumer breakage.

---

## 2. Module layout (new files under `src/judge/`)

```
src/judge/
  hardRules.ts        (exists — unchanged)
  dataFidelity.ts     (exists — unchanged)
  modelGateway.ts     NEW — provider auto-detect, generateObject wrapper, cost accounting, transient-retry
  providers.ts        NEW — env → LanguageModel resolution (anthropic/openai/google/compatible)
  schema.ts           NEW — zod schema for JudgeVerdict (the model's contract)
  digest.ts           NEW — Signals → compact digest JSON (token-bounded)
  prompt.ts           NEW — fixed instruction + message assembly (screenshot + digest)
  judge.ts            NEW — orchestration of one page's judgment (digest→call→map)
  verdictPolicy.ts    NEW — JudgeVerdict + confidence → PageStatus (the firewall table)
  costMeter.ts        NEW — shared, concurrency-safe budget reserve/commit
```

Everything the model touches lives here; the orchestrator only imports `judge.ts`
and `costMeter.ts`. Matches doc 02's "vigil touches the model behind one seam".

---

## 3. Dependencies

Add to `dependencies`:
- `ai` (Vercel AI SDK — the `LanguageModel` seam + `generateObject`)

Add to `optionalDependencies` (users install only the provider they use; keeps the
agnostic promise and avoids a fat install):
- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`

`zod` is already a dependency. Provider packages are imported dynamically in
`providers.ts` so a missing one yields a clean operational error (exit 4), never a
crash.

---

## 4. Provider auto-detection (`providers.ts`)

Resolution order for the judge model:
1. `config.model.judge` if the user passed an explicit AI SDK `LanguageModel` → use it verbatim (full agnostic escape hatch).
2. Else auto-detect from env, first match wins:
   - `ANTHROPIC_API_KEY` → `anthropic("claude-haiku-4-5")` (doc 05 default tier)
   - `OPENAI_API_KEY` → `openai("gpt-…-mini vision tier")`
   - `GOOGLE_GENERATIVE_AI_API_KEY` → `google("gemini-…-flash")`
   - `OPENAI_BASE_URL` (+ compatible key) → OpenAI-compatible (vLLM/Ollama)
3. No model resolvable → **operational error, exit code 4** ("no model key"),
   per doc 06 exit-code contract. `vigil run` still works for hard-rule-only via a
   future `--no-judge`, but absence of a key when the judge is expected is exit 4.

The default model id is a single named constant so the roadmap's "tune the default"
is a one-line change. Requirements enforced/documented: vision input + structured
output.

---

## 5. The judge schema (`schema.ts`)

Exact zod mirror of `JudgeVerdict` in doc 08 / `types.ts`:

```ts
export const JudgeReasonSchema = z.object({
  kind: z.enum(["console", "network", "render", "visual", "flow"]),
  summary: z.string().min(1),
  evidence: z.string().min(1),
});
export const JudgeVerdictSchema = z.object({
  status: z.enum(["pass", "warn", "fail"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(JudgeReasonSchema),
});
```

**Data-integrity guards on top of schema validation:**
- Clamp `confidence` to [0,1] defensively (belt-and-suspenders vs. schema).
- Require `reasons.length ≥ 1` whenever `status !== "pass"` (a non-pass with no cited
  evidence violates doc 08 invariant 2 → treat as a malformed response → `unjudged`
  fallback rather than a naked red).
- The runtime `JudgeVerdict` we store is derived from the parsed object only — never
  from free text — satisfying "no free-text parsing".

---

## 6. Signals digest (`digest.ts`) — the evidence that travels with the screenshot

Doc 05 input spec: compact JSON ~500–1500 tokens. Build deterministically from
`Signals`, **bounded** so token cost is predictable (exit-criterion budget):

- `document`: status, finalUrl, redirects count, navigationError, loadMs, settledMs
- `console`: count + first N (≤5) entries `{text (truncated), sourceUrl, count}`
- `requests`: totals + **first N failed/slow**, each labeled `firstParty` and
  `afterSettle`; third-party vs first-party explicit (the "most invisible breakage is
  loud in signals" lever). Cap arrays hard (e.g. ≤15) with an `omittedN` count.
- `render`: textLength, title, h1, errorMarkersFound, spinnerStuck,
  screenshotLooksBlank, a **truncated** textSample (≤400 chars)
- `pageErrors`: first ≤3, stack-head only
- `flows`: outcomes (Phase 3 populates; empty now — schema stable)
- `contentFields` / data-fidelity mismatches: passed through so the judge sees the
  frontend-didn't-render-backend-data signal (integrates the Phase 1 data-fidelity
  work into the judged decision instead of only warn-tier).

`digest.ts` is pure and unit-tested for **token-bound** (assert serialized length ≤
a ceiling) and **redaction** (no secrets/PII: URLs kept, request/response bodies
never included — only status/type/timing).

---

## 7. Prompt assembly (`prompt.ts`)

- **Fixed system instruction** = the doc 05 essence verbatim ("checking whether this
  page is broken for a real user right now — not whether it is well-designed…
  third-party analytics failures / cosmetic imperfections / intentional emptiness are
  not failures… cite concrete evidence for every reason; if ambiguous prefer `warn`").
- **User message** = multimodal: `[ image(viewport screenshot), text(digest JSON),
  text(url + origin context) ]`.
- **Identical scaffold per page** — the only variable is the evidence (doc 05
  "determinism discipline"). One template constant, snapshot-tested so prompt drift is
  caught in review.
- Screenshot read from `signals.screenshotPath` as a data part; if unreadable →
  `unjudged` (never fabricate).

---

## 8. ModelGateway (`modelGateway.ts`)

One `judgePage(signals, ctx)` entry. Responsibilities:

1. Resolve model (via `providers.ts`), assemble prompt (`prompt.ts`).
2. `generateObject({ model, schema: JudgeVerdictSchema, messages })`.
3. **Cost accounting** from returned `usage` (input/output tokens) × the model's
   price table (a small per-model `{inUsd,outUsd}` map; unknown model → conservative
   estimate + a `costEstimated` flag so we never *under*-count against the budget).
4. **Transient-retry**: one retry on network/5xx/timeout from the provider (distinct
   from vigil's page-level retry protocol) with short backoff; on repeated failure →
   throw a typed `ModelUnavailable` → caller degrades to `unjudged`.
5. Returns `{ verdict: JudgeVerdict, usd: number, ms: number, estimated: boolean }`.

Never throws into the worker loop uncaught — a model outage degrades one page to
`unjudged` (yellow), it does not fail the run.

---

## 9. Budget integrity under concurrency (`costMeter.ts`) — **the critical correctness piece**

Doc 08 invariant 5: `cost.modelUsd ≤ maxModelCostUsd`, always, **pre-call**. The
worker pool runs `budgets.concurrency` pages in parallel, so a naive "check then
call" races — N workers could each see budget remaining and collectively overspend.

Design:
- A shared `CostMeter` with **reserve → commit/refund** semantics, executed
  synchronously (single-threaded event loop makes the reserve atomic):
  - `reserve(estUsd)`: if `spent + reserved + estUsd > cap` → returns `null` (deny);
    else adds to `reserved`, returns a ticket.
  - `commit(ticket, actualUsd)`: moves reserved→spent with the real cost.
  - `refund(ticket)`: releases the reservation (used when the call degrades to
    `unjudged` before spending).
- `estUsd` = a fixed per-page upper estimate (doc 05 worked figure ~$0.004, use a
  safety ceiling e.g. $0.006 = the exit-criterion cap) so reservations are
  conservative — we may leave a little budget unused, never overspend.
- On `reserve` denial → page recorded `unjudged` (hard-rule decision stands),
  `budgetsExhausted` gains `maxModelCostUsd`, `run:budget` event emitted.
- `RunResult.cost.modelUsd = meter.spent`, `modelCalls = committed count`. Asserted
  ≤ cap in an integration test.

This is the one place a subtle bug would violate a stated invariant, so it gets its
own focused unit tests (parallel reserve race, exact-cap boundary, refund path).

---

## 10. Verdict policy (`verdictPolicy.ts`) — the false-alarm firewall

Pure function `applyPolicy(judge: JudgeVerdict): { status; headline; lowConfidence }`
implementing doc 05 exactly:

| Judge says | vigil records |
|---|---|
| `pass` | `pass` |
| `warn` (any conf) | `warn` (non-gating) |
| `fail`, conf ≥ 0.8 | **candidate fail** → retry protocol |
| `fail`, conf < 0.8 | `warn`, annotated `low-confidence` |

Threshold `0.8` = a named constant (roadmap open-question #1: "tune against
seeded-breakage runs") — single source of truth, not scattered literals. Unit-tested
at the 0.8 boundary (0.79 → warn, 0.80 → candidate-fail).

---

## 11. Orchestrator integration (`orchestrator.ts`) — the single changed seam

Current `visitOne`: `collect → evaluateRules → (data-fidelity) → retry-if-fail`.

New flow:
```
collect → evaluateRules
  ├─ hard fail (H1–H5)  → candidate fail (decidedBy "hard-rule")  [unchanged]
  └─ not hard-failed    → JUDGE STAGE:
        reserve budget?
          no  → unjudged: keep deterministic warn-tier decision, decidedBy "budget"
          yes → judgePage()
                  ok        → applyPolicy → status + judge verdict, decidedBy "judge"
                  outage    → refund + unjudged (decidedBy "budget"), warn-tier stands
```
Then the **existing retry protocol** is generalized: a candidate fail (hard *or*
judged) is retried once with a fresh context — and on the judged path the retry
**re-judges** the fresh capture (doc 05: "fresh capture, fresh judgment"). Pass on
retry → `warn (flaky)`; fail twice → the fail stands with both captures + both judge
verdicts shipped.

Bookkeeping wired through `toPageResult`:
- `decidedBy`: `"hard-rule" | "judge" | "budget"` (budget = unjudged).
- `judge`: the verdict (and `retryJudge` conceptually — stored via `retrySignals`
  detail; keep to schema by attaching the surviving verdict to `judge`).
- `unjudged: true` when budget/outage.
- `cost.judgeUsd` from the meter; `timings.judgeMs` from the gateway.
- `RunResult.cost.modelUsd/modelCalls` from the shared meter (replaces hardcoded 0).

**Determinism preserved:** hard rules keep absolute authority and run first; the
judge only ever sees pages the deterministic layer didn't already fail. A judged
`fail` still requires `retried: true` (invariant 1). The environmental override
(H1 ≥50% → INCONCLUSIVE) is unchanged and still short-circuits before judged-fail
rollup matters.

---

## 12. Data integrity — explicit invariant checks (doc 08)

Each becomes an assertion or a targeted test:
1. **No unexplained reds**: any `status:"fail"` ⇒ (`hardRule` set) XOR (`judge.status==="fail"` ∧ `confidence≥0.8`) ∧ `retried===true`. Add a dev-mode assert in `toPageResult`.
2. **Evidence grounding**: reasons carry `evidence`; schema requires it; non-pass with empty reasons ⇒ discarded → `unjudged`. (Human spot-checkable, not machine-provable — documented as such.)
3. **HEALTHY ⇒ all pass**: unchanged rollup; verified by test.
4. **Self-contained RunResult**: judge adds only in-result fields; no external reads.
5. **cost ≤ cap**: enforced by CostMeter pre-call; integration test asserts.

---

## 13. Frontend / report UX (doc 06) — surface the judge without noise

`summary.md` (`reporter/index.ts`):
- Reds/yellows already list `headline`. Append judge confidence when judge-decided,
  matching doc 06 example: `❌ **/checkout** — …error toast visible (judge 0.97)`.
- Show `$X.XX` model spend (already wired; now non-zero).
- Mark `unjudged` yellows explicitly (`⚠️ … (unjudged — model budget)`), and
  `low-confidence` (`⚠️ … (judge 0.6, low confidence — human look)`).

`report.html` (`reporter/html.ts`) — extend the per-page **detail** block (keep the
existing screenshot + signals evidence layout, add a "Judge" section):
- **Judge verdict card**: status pill + confidence as a small labeled meter/bar
  (color-coded to the existing `--green/--yellow/--red` vars — theme-aware light/dark
  already handled by the CSS `prefers-color-scheme`).
- **Reasons list**: each reason as `kind` tag + `summary` + monospace `evidence`
  (reuse the `.evi`/`.tag` styles already defined — no new visual language).
- **`decidedBy` badge** on the row (`hard-rule` / `judge` / `budget`) so a reader
  sees at a glance *what* decided each page.
- **Retry + re-judge**: when a page was retried, show both captures (exists) and both
  judge confidences side by side.
- **unjudged / low-confidence** callouts styled with the existing `.note` yellow.
- Meta bar: model spend already shown; add "Judged N · unjudged M" counts.

No framework, no new assets — the report stays a single self-contained inlined-CSS
file (doc 06 constraint). All additions reuse existing CSS custom properties, so
light/dark and the color system stay consistent. Reporter changes are covered by
extending `test/unit/reporter.test.ts` with a judged fixture.

---

## 14. Testing strategy

Unit (`test/unit/`, no network — mock the `LanguageModel`):
- `digest.test.ts` — token bound, truncation, first/third-party labeling, redaction.
- `verdictPolicy.test.ts` — the full firewall table + 0.8 boundary.
- `costMeter.test.ts` — parallel reserve race, exact-cap boundary, refund, commit.
- `providers.test.ts` — env resolution order, explicit-model passthrough, no-key → error.
- `schema.test.ts` — valid/invalid model outputs, non-pass-with-empty-reasons rejection.
- `judge.test.ts` — mocked gateway → PageResult mapping (judge/unjudged/budget).
- Extend `reporter.test.ts` — judged fixture renders confidence + reasons + decidedBy.

Integration (`test/integration/`, mocked ModelGateway, real pipeline + fixture app):
- `judge.test.ts` — seeded breakages (error toast on 200, half-render, dead widget)
  → BROKEN with judge evidence; clean run → HEALTHY, no false red; **cost ≤ cap**
  asserted; budget-exhaustion → `unjudged` yellows; model-outage → `unjudged`, run
  still completes.
- Extend `test/fixtures/app.mjs` with a `?break=toast|halfrender|deadwidget` route so
  the judge path is exercised deterministically against a fake model returning canned
  verdicts keyed on the digest.

CI targets from exit criterion (run manually against dogfood apps, not in unit CI):
catch ≥90% seeded, zero false BROKENs / 100 clean, per-page ≤ $0.006.

---

## 15. CLI / config touchpoints

- `config.model` schema tightened slightly: accept `{ judge?: LanguageModel; flows?: LanguageModel }` (still optional; `z.any()` inside for the model object to avoid coupling to AI SDK types in zod). Backward compatible.
- `cli.ts`: add `--no-judge` (hard-rules-only, explicit opt-out — makes Phase 1
  behavior reachable and gives a graceful path when no key is set) and surface model
  spend in the printed summary (mostly already there via `printSummary`).
- `init` template comment: show how to set a provider key / pass `model.judge`.

---

## 16. Sequencing (suggested commit order)

1. Deps + `providers.ts` + `schema.ts` + `costMeter.ts` (+ their unit tests). Pure, no orchestrator change yet.
2. `digest.ts` + `prompt.ts` + `modelGateway.ts` + `judge.ts` (+ unit tests, mocked model).
3. `verdictPolicy.ts` + orchestrator seam + generalized retry/re-judge (+ integration test with fake model). Wire real `cost.modelUsd`.
4. Reporter/HTML/summary judge rendering (+ reporter test).
5. CLI `--no-judge`, config tightening, init template.
6. Docs pass: confirm 05/08 match implementation; update roadmap "Phase 2" → done.

Each step keeps `npm test` green; the orchestrator seam (step 3) is the only one that
changes existing behavior and is gated behind the judge stage only running on
not-hard-failed pages.

---

## 17. Risks & mitigations (Phase-2-specific, from roadmap)

- **False BROKENs kill trust** → confidence gate (0.8) + fresh-context re-judge on
  retry + `warn` absorbs ambiguity + evidence citation required. The 0.8 constant is
  tunable (open-question #1).
- **Judge misses subtle breakage** → the signals digest (console/network, first vs
  third party) travels with the screenshot; data-fidelity mismatch fed in too.
- **Cost/latency surprise** → hard `maxModelCostUsd` enforced pre-call by CostMeter;
  conservative reservations; costs printed every run; `unjudged` fallback keeps the
  run useful when budget/outage hits.
- **Provider drift/lock-in** → all access behind the AI SDK `LanguageModel` seam;
  provider packages optional; no provider-specific features beyond structured output.
- **Concurrency overspend** → reserve/commit CostMeter, dedicated tests.
```
