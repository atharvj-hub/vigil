// Data models — the precise shape of every entity vigil produces.
// These types are the stable public API (documentation/08-data-models.md).
//
// Phase 1 note: the Judge (Stage 2) is not built yet, so `PageResult.judge` is
// never populated this phase. The types are kept complete for forward-compat so
// report.json's schema does not change when the judge lands in Phase 2.

export type ISODate = string; // e.g. "2026-07-08T18:22:09.123Z"

// ── Discovery ───────────────────────────────────────────────────────────────

export type DiscoverySource = "config" | "sitemap" | "crawl" | "api";

export interface DiscoveredPage {
  url: string; // absolute, normalized
  source: DiscoverySource;
  patternGroup?: string; // "/products/:n" when parametric collapsing grouped it
}

/**
 * How many candidates each source actually contributed, and what got dropped
 * along the way — the answer to "did discovery hit all the pages?"
 */
export interface DiscoveryCoverage {
  config: number; // explicit config routes (always kept)
  sitemap: { sitemapsFetched: number; urlsDeclared: number };
  crawl: { urlsFound: number };
  api: {
    graphqlEndpoint: string | null; // set only if introspection responded
    openapiEndpoint: string | null; // set only if a spec doc was found
    candidatesGenerated: number;
    candidatesConfirmed: number;
  };
  duplicatesDropped: number; // same URL from >1 source, or repeated
  samplingDropped: number; // parametric families collapsed to samples
  capDropped: number; // dropped by maxPages after everything else
}

export interface PageSet {
  pages: DiscoveredPage[];
  generatedAt: ISODate;
  truncated: boolean; // maxPages cap was hit
  coverage: DiscoveryCoverage;
}

// ── Signals (the evidence from one visit) ───────────────────────────────────

export interface RequestSummary {
  method: string;
  url: string;
  resourceType: string; // document|script|xhr|fetch|image|…
  status: number | null; // null = network failure
  failure?: string; // playwright failure text
  durationMs: number;
  firstParty: boolean;
  slow: boolean; // > latencyBudgetMs
  afterSettle: boolean; // completed after capture
}

export interface ConsoleEntry {
  text: string;
  sourceUrl?: string;
  count: number; // dedupe counter
}

/**
 * A bounded, relative-time trace of the collector's readiness decision. It is
 * diagnostic evidence: timestamps are milliseconds from navigation start.
 */
export type CaptureTimelineEvent =
  | {
      kind: "navigation-start" | "domcontentloaded" | "load" | "network-quiet" | "network-quiet-timeout" | "dom-stable" | "capture-decision" | "capture" | "navigation-error";
      atMs: number;
      detail?: string;
    }
  | {
      kind: "fingerprint";
      atMs: number;
      inFlight: number;
      textLength: number;
      childElementCount: number;
      spinnerVisible: boolean;
      visibleHeadingCount: number;
      readyState: string;
    }
  | {
      kind: "request-complete";
      atMs: number;
      resourceType: string;
      status: number | null;
      failure?: string;
    };

export interface FlowOutcome {
  name: string;
  steps: { instruction: string; ok: boolean; detail: string }[];
  ok: boolean;
}

export interface Signals {
  url: string;
  finalUrl: string; // after redirects
  document: {
    status: number | null; // null = navigation failed
    redirects: string[];
    navigationError?: string; // DNS/refused/timeout/TLS text
    loadMs: number | null;
    settledMs: number | null;
  };
  requests: RequestSummary[]; // every request on the visit
  captureTimeline: CaptureTimelineEvent[]; // bounded readiness trace for this capture
  console: ConsoleEntry[]; // errors only, deduped, capped
  pageErrors: string[]; // uncaught exceptions (message + stack head)
  crashed: boolean;
  render: {
    textLength: number;
    title: string;
    h1: string | null;
    textSample: string; // bounded (~2000 chars) rendered text — data-fidelity matches against this, never the full body
    errorMarkersFound: string[];
    spinnerStuck: boolean;
    screenshotLooksBlank: boolean; // downsampled screenshot ≈ uniform color
    missingSelectors: string[]; // checks.requiredSelectors entries not found post-settle — empty unless configured
    notFoundMarkersFound: string[]; // checks.notFoundMarkers matches in rendered text — the "soft 404" signal, empty unless configured
  };
  contentFields: Record<string, string | number>; // fields pulled from a matching content-API response, per checks.dataFidelity config — empty unless configured
  apiMatchedCount: number; // # of first-party responses this visit that matched checks.dataFidelity.apiPathPatterns — lets dataFidelity distinguish "nothing to check" from "field went missing"
  flows: FlowOutcome[]; // empty unless flows configured for this page
  screenshotPath: string;
  timedOut: boolean; // per-page visit cap hit
}

// ── Judgment ────────────────────────────────────────────────────────────────

export type PageStatus = "pass" | "warn" | "fail" | "skipped";

export type HardRule = "H1" | "H2" | "H3" | "H4" | "H5";

export interface JudgeReason {
  kind: "console" | "network" | "render" | "visual" | "flow";
  summary: string; // one plain-English sentence
  evidence: string; // cites a concrete signal / visible element
}

export interface JudgeVerdict {
  status: "pass" | "warn" | "fail";
  confidence: number; // 0–1
  reasons: JudgeReason[];
}

export interface PageResult {
  url: string;
  source: DiscoverySource;
  status: PageStatus;
  headline: string; // the one line shown in summaries
  // budget = model budget exhausted before this page; error = the judge was
  // attempted but failed operationally (provider outage, timeout, malformed
  // response). Both fall back to the deterministic warn-tier decision, but a
  // report reader can tell "we chose not to spend" from "the model call broke".
  decidedBy: "hard-rule" | "judge" | "budget" | "error" | "skipped";
  hardRule?: HardRule;
  judge?: JudgeVerdict; // absent for hard rules / unjudged
  unjudged?: boolean; // model budget/outage — hard rules only ran
  judgeError?: string; // short reason when decidedBy === "error" (e.g. "provider unavailable", "malformed verdict")
  retried: boolean;
  flaky: boolean; // failed then passed on retry
  fidelityWarnings?: string[]; // data-fidelity mismatches (checks.dataFidelity) — separate from hardRule warns so they're always visible in the report
  signals: Signals; // first capture
  retrySignals?: Signals; // present when retried
  timings: { visitMs: number; judgeMs?: number };
  cost: { judgeUsd: number; flowsUsd: number };
}

// ── Run result (the object `runSanity` returns) ─────────────────────────────

export type RunVerdict = "HEALTHY" | "DEGRADED" | "BROKEN" | "INCONCLUSIVE";

export interface RunResult {
  schemaVersion: 1;
  runId: string;
  verdict: RunVerdict;
  target: { url: string; deployRef?: string }; // deployRef = git SHA if provided
  startedAt: ISODate;
  durationMs: number;
  counts: { pass: number; warn: number; fail: number; skipped: number };
  cost: { modelCalls: number; modelUsd: number };
  budgetsExhausted: string[]; // e.g. ["maxModelCostUsd"]
  pages: PageResult[];
  coverage: DiscoveryCoverage;
  artifactsDir: string;
}

// ── Events (the `vigil.events` emitter) ─────────────────────────────────────

export interface VigilEvents {
  "run:start": (info: { runId: string; pageSet: PageSet }) => void;
  "page:start": (info: { url: string }) => void;
  "page:complete": (result: PageResult) => void;
  "flow:step": (info: { page: string; flow: string; step: string; ok: boolean }) => void;
  "run:budget": (info: { budget: string; remaining: number }) => void;
  "run:complete": (result: RunResult) => void;
}
