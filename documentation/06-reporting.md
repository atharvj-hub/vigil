# 06 — Reporting & Integrations

A sanity check is only as good as the ten seconds after it finishes. Reporting serves three
audiences with three attention budgets: **a pipeline** (milliseconds — exit code), **a human
glancing at Slack** (ten seconds — one line + colors), **a human debugging** (minutes — full
evidence, zero re-running).

## The verdict model

Page-level statuses roll up into one run verdict:

| Page status | Meaning | Color |
|---|---|---|
| `pass` | clean signals, judge satisfied | green |
| `warn` | judge concern below the fail bar, low-confidence fail, flaky (passed on retry), or `unjudged` (model budget/outage — hard rules only) | yellow |
| `fail` | hard rule fired, or high-confidence judge fail — confirmed by retry | red |
| `skipped` | budget exhausted before visiting | yellow |

Rollup: any `fail` → **BROKEN**; else any yellow → **DEGRADED**; else **HEALTHY**.
Run-level **INCONCLUSIVE** (environmental override, [05](05-judgment.md)) is distinct from
BROKEN because the required human action differs ("check the network/target" vs "check the app").

Exit codes (the CI contract):
`0` HEALTHY · `1` BROKEN · `2` DEGRADED (gate on it or not via `--fail-on broken|degraded`) ·
`3` INCONCLUSIVE · `4` operational error (bad config, unreachable target, no model key).

## Artifacts: `vigil-report/<run-id>/`

```
vigil-report/2026-07-07T18-22-09_a3f2/
├── report.json          # complete machine-readable RunResult (schema in doc 08)
├── report.html          # single-file human report (below)
├── summary.md           # the 10-second version; postable to Slack/PR comments as-is
└── pages/
    ├── home.png                 # screenshot per page
    ├── checkout.png
    └── checkout.retry.png       # fail/warn pages keep the retry capture too
```

Artifacts are **for humans and CI only** — vigil never reads a previous run's artifacts
(statelessness is architectural, doc 02). The directory is gitignored; retention is the user's
CI artifact policy, with a local `keepRuns` default of 10.

`report.html` is a single self-contained file (inlined CSS/JS, screenshots embedded as data
URIs) so it can be attached anywhere — CI artifact, email, ticket — and opened with no server.

### The HTML report, top to bottom
1. Verdict banner + one-line summary + run metadata (target, git SHA if provided, duration,
   pages visited, model spend).
2. Page table: status, URL, headline finding, discovery source. Reds pinned to top.
3. Per-red detail: the evidence in plain words ("POST /api/payment/intent returned 500; page
   shows an error toast"), the screenshot (and retry screenshot), the failing requests, the
   console excerpt, the judge's cited reasons and confidence.
4. Per-yellow detail: collapsed, same structure.

### `summary.md` example

```markdown
## vigil · BROKEN · app.example.com · deploy 4f9c21b
**1 failed · 39 passed · 2 warned** · 2m 41s · $0.31

❌ **/checkout** — POST /api/payment/intent → 500; error toast visible (judge 0.97)
⚠️ **/account** — console error from third-party widget (Intercom)
⚠️ **/blog** — passed on retry (flaky: initial visit timed out)
```

## Integrations

All integrations are **Reporter plugins** implementing one interface
(`onRunComplete(result)`, optional `onPageComplete` for streaming). Built-in:

- **CLI (universal, zero config):** exit code + `summary.md` to stdout + artifacts dir.
- **Slack / generic webhook:** POSTs `summary.md` (Slack-flavored) with the verdict color.
  Policy configurable: `always | on-problem` (default `on-problem`). Recovery messages ("✅
  back to healthy") are what make people keep the channel — but detecting recovery needs the
  previous verdict, and vigil stores nothing. Solution: CI passes it. `vigil run
  --prev-verdict $LAST` (one line in any pipeline; CI systems already know their last run's
  outcome) makes vigil send the recovery message when a non-HEALTHY previous verdict flips
  to HEALTHY. Statelessness preserved; the state lives where it already existed.
- **GitHub Action (wrapper, built after v1):** runs the CLI, uploads `vigil-report/` as an
  artifact, posts `summary.md` as a commit/PR comment.
- **Programmatic:** the library returns the full `RunResult`; user code can do anything else.

Deliberately absent: Jira/issue-tracker automation (a webhook consumer's job, not core),
trend dashboards (vigil is stateless; longitudinal analysis belongs to the CI system or a
future hosted layer — see [10-roadmap.md](10-roadmap.md)).

Next: [07-library-api.md](07-library-api.md) — the public surface.
