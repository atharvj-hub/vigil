# 08 — Data Models

The precise shape of every entity, as TypeScript. These types are exported from the package and
constitute part of the stable API.

## Discovery

```ts
export type DiscoverySource = "config" | "sitemap" | "crawl";

export interface PageSet {
  pages: DiscoveredPage[];
  generatedAt: ISODate;
  truncated: boolean;               // maxPages cap was hit
}

export interface DiscoveredPage {
  url: string;                      // absolute, normalized
  source: DiscoverySource;
  patternGroup?: string;            // "/products/:n" when parametric collapsing grouped it
}
```

## Signals (the evidence from one visit)

```ts
export interface Signals {
  url: string;
  finalUrl: string;                     // after redirects
  document: {
    status: number | null;              // null = navigation failed
    redirects: string[];
    navigationError?: string;           // DNS/refused/timeout/TLS text
    loadMs: number | null;
    settledMs: number | null;
  };
  requests: RequestSummary[];           // every request on the visit
  console: ConsoleEntry[];              // errors only, deduped, capped
  pageErrors: string[];                 // uncaught exceptions (message + stack head)
  crashed: boolean;
  render: {
    textLength: number;
    title: string;
    h1: string | null;
    errorMarkersFound: string[];
    spinnerStuck: boolean;
  };
  flows: FlowOutcome[];                 // empty unless flows configured for this page
  screenshotPath: string;
  timedOut: boolean;                    // per-page visit cap hit
}

export interface RequestSummary {
  method: string;
  url: string;
  resourceType: string;                 // document|script|xhr|fetch|image|…
  status: number | null;                // null = network failure
  failure?: string;                     // playwright failure text
  durationMs: number;
  firstParty: boolean;
  slow: boolean;                        // > latencyBudgetMs
  afterSettle: boolean;                 // completed after capture
}

export interface ConsoleEntry {
  text: string;
  sourceUrl?: string;
  count: number;                        // dedupe counter
}

export interface FlowOutcome {
  name: string;
  steps: { instruction: string; ok: boolean; detail: string }[];
  ok: boolean;
}
```

## Judgment

```ts
export type PageStatus = "pass" | "warn" | "fail" | "skipped";

export interface JudgeVerdict {                  // the model's schema-enforced output
  status: "pass" | "warn" | "fail";
  confidence: number;                            // 0–1
  reasons: JudgeReason[];
}

export interface JudgeReason {
  kind: "console" | "network" | "render" | "visual" | "flow";
  summary: string;                               // one plain-English sentence
  evidence: string;                              // cites a concrete signal / visible element
}

export interface PageResult {
  url: string;
  source: DiscoverySource;
  status: PageStatus;
  headline: string;                              // the one line shown in summaries
  decidedBy: "hard-rule" | "judge" | "budget" | "error" | "skipped";
                                                 // budget = spend cap denied the call;
                                                 // error  = call attempted but failed (outage/malformed)
  hardRule?: "H1" | "H2" | "H3" | "H4" | "H5";
  judge?: JudgeVerdict;                          // absent for hard rules / unjudged
  unjudged?: boolean;                            // model budget/outage: hard rules only ran
  judgeError?: string;                           // short reason when decidedBy === "error"
  retried: boolean;
  flaky: boolean;                                // failed then passed on retry
  signals: Signals;                              // first capture
  retrySignals?: Signals;                        // present when retried
  timings: { visitMs: number; judgeMs?: number };
  cost: { judgeUsd: number; flowsUsd: number };
}
```

## Run result (the object `runSanity` returns)

```ts
export type RunVerdict = "HEALTHY" | "DEGRADED" | "BROKEN" | "INCONCLUSIVE";

export interface RunResult {
  schemaVersion: 1;
  runId: string;
  verdict: RunVerdict;
  target: { url: string; deployRef?: string };   // deployRef = git SHA if provided
  startedAt: ISODate;
  durationMs: number;
  counts: { pass: number; warn: number; fail: number; skipped: number };
  cost: { modelCalls: number; modelUsd: number };
  budgetsExhausted: string[];                    // e.g. ["maxModelCostUsd"]
  pages: PageResult[];
  artifactsDir: string;
}
```

## Events (the `vigil.events` emitter)

```ts
export interface VigilEvents {
  "run:start":      (info: { runId: string; pageSet: PageSet }) => void;
  "page:start":     (info: { url: string }) => void;
  "page:complete":  (result: PageResult) => void;
  "flow:step":      (info: { page: string; flow: string; step: string; ok: boolean }) => void;
  "run:budget":     (info: { budget: string; remaining: number }) => void;
  "run:complete":   (result: RunResult) => void;
}
```

## Invariants worth writing down

1. A page with `status: "fail"` always has either a `hardRule` or a `judge` verdict with
   `status: "fail"` and `confidence ≥ 0.8` — and `retried: true`. No unexplained, unretried reds.
2. Every `JudgeReason.evidence` refers to content present in `signals` or the screenshot —
   the judge cannot introduce facts (enforced by prompt + spot-checkable by humans).
3. `verdict: "HEALTHY"` implies every page is `pass` — any other status forces at least
   `DEGRADED`.
4. `RunResult` is self-contained: reproducing the report needs no other input, and no vigil
   run ever reads a prior `RunResult`.
5. `cost.modelUsd ≤ budgets.maxModelCostUsd`, always — budget enforcement is pre-call.

Next: [09-prior-art.md](09-prior-art.md) — the landscape and the exact tools vigil stands on.
