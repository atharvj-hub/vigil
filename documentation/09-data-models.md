# 09 — Data Models

The precise shape of every entity, as TypeScript. These types are exported from the package and
constitute part of the stable API. (Illustrative fields elided with `…` are noted.)

## Discovery

```ts
export interface RouteManifest {
  routes: DiscoveredRoute[];
  sources: DiscoverySource[];
  generatedAt: ISODate;
}

export type DiscoverySource = "code" | "sitemap" | "crawl" | "manual";

export interface DiscoveredRoute {
  pattern: string;              // "/products/:id" — normalized; primary key everywhere
  samples: string[];            // concrete instances to visit (≥1)
  source: DiscoverySource;
  requiresAuth: boolean;
  priority: 0 | 1 | 2 | 3;      // P0 critical … P3 extra samples
}
```

## Asset store

```ts
export interface RouteIndex {                    // .vigil/index.json
  storeVersion: number;
  routes: Record<string /*pattern*/, RouteIndexEntry>;
}

export interface RouteIndexEntry {
  slug: string;                                  // asset directory name
  status: AssetStatus;
  fingerprintHash: string;                       // fast-path equality check
  lastVerified: ISODate | null;
  vanishedSince?: ISODate;                       // set while route is missing from manifests
}

export type AssetStatus = "active" | "draft" | "quarantined" | "archived";

export interface AssetMeta {                     // assets/<slug>/meta.json
  pattern: string;
  status: AssetStatus;
  createdBy: "explorer" | "healer" | "human";
  specContentHash: string;                       // detects human edits
  flakes: { strikes: number; signatures: FlakeSignature[] };
  history: AssetEvent[];                         // append-only audit log
  explorerVersion: string;
}

export interface AssetEvent {
  at: ISODate;
  event: "created" | "healed" | "baseline-refreshed" | "mask-refined"
       | "contract-evolved" | "quarantined" | "human-edited" | "demoted";
  detail: string;                                // human-readable, shown in reports
  diff?: string;                                 // unified diff where applicable
}

export interface Fingerprint {                   // assets/<slug>/fingerprint.json
  hash: string;                                  // sha256 of canonical serialization
  tree: string;                                  // compact normalized a11y tree (for similarity + healing diffs)
  capturedAt: ISODate;
  viewport: { width: number; height: number };
}
```

## API contract

```ts
export interface Contract {                      // assets/<slug>/contract.json
  endpoints: EndpointContract[];
  thirdParty: "observe-only";
  observations: number;                          // runs merged into this contract
}

export interface EndpointContract {
  key: string;                                   // "GET /api/products/:id" (normalized)
  expectStatus: "2xx" | "3xx";                   // status class observed
  latencyBudgetMs: number;                       // p95 × headroom, re-derived as observations grow
  schema: JsonShape | null;                      // null for non-JSON
  critical: boolean;                             // failure = red vs yellow
}

export type JsonShape =
  | { type: "object"; required: string[]; properties: Record<string, JsonShape> }
  | { type: "array"; items: JsonShape | null }
  | { type: "string" | "number" | "boolean" | "null" }
  | { type: "union"; of: JsonShape[] };
```

## Checks & judgment

```ts
export type Lane = "api" | "ui";
export type CheckTier = "T1_signal" | "T2_contract" | "T3_spec" | "T4_visual" | "T5_model";

export interface CheckResult {
  id: string;                                    // "api.status", "ui.console", "ui.spec", "ui.visual", …
  lane: Lane;
  tier: CheckTier;
  passed: boolean;
  severity: "red" | "yellow";                    // what a failure of this check implies
  headline: string;                              // one plain-English sentence
  detail?: unknown;                              // check-specific structured payload
}

export interface FailureBundle {                 // input to Triage; persisted as evidence.json
  route: string;
  failedChecks: CheckResult[];
  tracePath: string;
  consoleLog: ConsoleEntry[];
  network: NetworkExchangeSummary[];
  fingerprints: { stored: Fingerprint | null; current: Fingerprint; similarity: number };
  screenshots: { baseline?: string; current: string; diff?: string };
}

export interface TriageOutcome {
  classification: "APP_BROKEN" | "TEST_STALE" | "FLAKY" | "SUSPECT";
  decidedBy: `rule:${number}` | "retry-probe" | "llm";
  confidence: number;                            // 1.0 for rules
  reasoning: string;
  suggestedFix?: string;
}
```

## Run results (the object `runSanity` returns)

```ts
export interface RunResult {
  runId: string;
  verdict: "HEALTHY" | "DEGRADED" | "BROKEN" | "INCONCLUSIVE";
  target: { url: string; deployRef?: string };   // deployRef = git SHA if provided
  startedAt: ISODate;
  durationMs: number;
  cost: { llmCalls: number; llmUsd: number; cacheHits: number; cacheMisses: number };
  budgetsExhausted: string[];                    // e.g. ["maxLlmCostUsd"]
  routes: RouteResult[];
  artifactsDir: string;
}

export type RouteStatus =
  | "PASSED" | "HEALED" | "DEGRADED" | "SUSPECT"
  | "UNVERIFIED" | "SKIPPED" | "VANISHED" | "FAILED";

export interface RouteResult {
  route: string;                                 // pattern
  visited: string[];                             // concrete URLs
  status: RouteStatus;
  cache: "hit" | "miss-new" | "miss-drift" | "miss-rebuild" | "none";
  checks: CheckResult[];
  triage?: TriageOutcome;
  healed?: { diff: string; reason: string };
  headline: string;                              // the one line shown in summaries
  evidencePath?: string;                         // runs/<id>/routes/<slug>/
  timings: { visitMs: number; exploreMs?: number };
}
```

## Events (the `vigil.events` emitter)

```ts
export interface VigilEvents {
  "run:start":       (info: { runId: string; manifest: RouteManifest }) => void;
  "route:start":     (info: { route: string; cache: RouteResult["cache"] }) => void;
  "route:complete":  (result: RouteResult) => void;
  "explore:action":  (info: { route: string; action: string; step: number }) => void;
  "heal:attempt":    (info: { route: string; attempt: 1 | 2 }) => void;
  "run:budget":      (info: { budget: string; remaining: number }) => void;
  "run:complete":    (result: RunResult) => void;
}
```

## Invariants worth writing down

1. A route with `status: FAILED` always has ≥1 `CheckResult` with `severity: red, passed: false`,
   and (if the deciding tier was T3+) a `TriageOutcome` — no unexplained reds, ever.
2. `HEALED` implies the *post-heal* spec passed in this run; the pre-heal failure never appears
   as a failure in `checks`.
3. `verdict: HEALTHY` implies every route is `PASSED` or `HEALED` — all other statuses force at
   least `DEGRADED`.
4. `cost.llmUsd === 0` whenever `cacheMisses === 0` and no triage/heal ran — the steady-state
   guarantee, and a regression test we run on vigil itself.
5. Asset `history` is append-only; nothing vigil does to its own assets is undiscoverable.

Next: [10-roadmap.md](10-roadmap.md) — phases, risks, open questions.
