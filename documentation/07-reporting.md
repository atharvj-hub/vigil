# 07 — Reporting & Integrations

A sanity check is only as good as the ten seconds after it finishes. Reporting is designed around
three audiences with three attention budgets: **a pipeline** (milliseconds — exit code), **a human
glancing at Slack** (ten seconds — one line + colors), **a human debugging** (minutes — full
evidence, zero re-running).

## The verdict model

Route-level statuses roll up into one run verdict:

| Route status | Meaning | Color |
|---|---|---|
| `PASSED` | all lanes green | green |
| `HEALED` | green after auto-repair (annotation attached) | green· |
| `DEGRADED` | non-critical failures only (slow non-critical endpoint, quarantined spec, visual-only oddity) | yellow |
| `SUSPECT` | triage couldn't classify with confidence; human eyes requested | yellow |
| `UNVERIFIED` | couldn't establish/heal a baseline; budget exhaustion; draft asset | yellow |
| `SKIPPED` | budget exhaustion before visiting | yellow |
| `VANISHED` | previously-known route no longer discoverable | yellow |
| `FAILED` | at least one authoritative red check | red |

Rollup: any `FAILED` → **BROKEN**; else any yellow → **DEGRADED**; else **HEALTHY**. A separate
run-level `INCONCLUSIVE` exists for environmental failure (see 06) — distinct from BROKEN because
the required human action differs ("check the network" vs "check the app").

Exit codes (CI contract): `0` HEALTHY · `1` BROKEN · `2` DEGRADED (gate on it or not via
`--fail-on degraded|broken`) · `3` INCONCLUSIVE · `4` operational error (bad config, unreachable
target).

## Artifacts: `.vigil/runs/<run-id>/`

```
runs/2026-07-04T18-22-09_a3f2/
├── report.json          # the complete machine-readable RunResult (schema in 09)
├── report.html          # single-file human report (below)
├── summary.md           # the 10-second version; pasted into Slack/PR comments as-is
└── routes/<slug>/       # only for non-PASSED routes
    ├── trace.zip        # Playwright trace — full timeline: DOM snapshots, network, console
    ├── failure.png / baseline.png / diff.png
    ├── video.webm
    └── evidence.json    # the triage bundle: which checks failed, which rule/LLM classified, why
```

Retention: last 20 runs locally (configurable); the directory is gitignored. `report.html` is a
single self-contained file (inline assets) so it can be attached anywhere — CI artifact, Jira,
email — and opened with no server.

### The HTML report, top to bottom
1. Verdict banner + one-line summary + deploy metadata (git SHA, target URL, duration, LLM spend).
2. Route table: status, route, headline finding, links to evidence. Reds pinned to top.
3. Per-red detail: the failing check in plain words ("POST /api/cart/summary returned 500; the
   contract from 31 previous runs expects 2xx"), screenshot pair, embedded trace-viewer link,
   the network exchange.
4. Fold-out: healed diffs, refreshed baselines, mask refinements, contract evolutions — the
   audit trail of everything vigil changed about *itself* this run.

### `summary.md` example

```markdown
## vigil · BROKEN · app.example.com · deploy 4f9c21b
**1 broken · 39 passed · 2 healed · 1 suspect** · 41s · $0.00

❌ **/cart** — POST /api/cart/summary → 500 (contract: 2xx, 31 runs) · [trace](…)
⚠️ **/account** — "recent orders" section missing; unable to classify · [evidence](…)
🔧 /pricing — locator healed ("Sign up" → "Create account")
🔧 /docs — visual baseline refreshed (hero image changed)
```

## Integrations

All integrations are **Reporter plugins** implementing one interface (`onRunComplete(result)`,
optional `onRouteComplete` for streaming) — third parties can add their own (see 08). Built-in:

**CI (universal, zero config):** exit code + `summary.md` to stdout + artifacts dir. GitHub
Action wrapper additionally posts `summary.md` as a PR/commit comment and uploads artifacts.

**Slack / generic webhook:** POSTs the summary; reds include the headline finding and a link to
the HTML report (artifact URL template configurable). Notification policy configurable:
`always | on-change | on-problem` (default `on-problem`, plus the *recovery* message when a
previously-broken route passes — recovery notifications are what make people keep the channel).

**Jira / GitHub Issues:** on `FAILED` routes, creates one issue per route (deduplicated by an
open-issue search on a `vigil:<route>` marker label — repeat failures comment on the existing
issue rather than spamming new ones; recovery closes with a comment). Issue body = the per-route
detail section; trace + screenshots attached.

**Programmatic:** the library returns the full `RunResult` object; wrappers and user code can do
anything else with it.

## Trend awareness (lightweight, local)

`report.json` history enables cheap but valuable deltas without any server component:
- "first failure of this route in N runs" vs "failing for 6 consecutive runs" (escalation hint)
- latency trend per critical endpoint (creeping p95 flagged at yellow before it ever breaches red)
- flake and heal rates per route (a route healing every other run = churn worth a human look;
  surfaced in a monthly `vigil health` digest command)

A hosted dashboard is explicitly out of scope for the library (10-roadmap.md lists it as a
possible product layer later).

Next: [08-library-api.md](08-library-api.md) — the public surface.
