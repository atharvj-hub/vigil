// Signals → compact digest: the textual half of the judge's evidence packet
// (documentation/05-judgment.md input spec, ~500–1500 tokens).
//
// Pure compression of what the Collector already captured — nothing is
// re-visited, re-fetched, or re-derived (firstParty labels, fidelity checks
// etc. come straight from Signals / Phase 1). Every array is hard-capped with
// an explicit `omitted` count so the token cost is bounded and the judge knows
// when it is seeing a sample rather than the whole picture. No request or
// response bodies exist in Signals, so nothing secret can leak by construction;
// URLs and console text are kept but truncated.

import type { Signals } from "../types.js";

// Caps sized so a maximally noisy page serializes to ≲ 8,000 chars (~2,000
// tokens) — inside the pricing module's reserved input estimate. If a cap here
// grows, re-check EST_INPUT_TOKENS in pricing.ts.
const MAX_CONSOLE = 4;
const MAX_REQUESTS = 10;
const MAX_PAGE_ERRORS = 3;
const MAX_TEXT_SAMPLE = 400;
const MAX_LINE = 140;

export interface DigestOptions {
  /** Data-fidelity warn reasons already computed by the deterministic layer. */
  fidelityWarnings?: string[];
}

export interface SignalsDigest {
  url: string;
  finalUrl: string;
  document: {
    status: number | null;
    redirects: number;
    navigationError?: string;
    loadMs: number | null;
    settledMs: number | null;
    timedOut: boolean;
  };
  requests: {
    total: number;
    failed: number;
    slow: number;
    // Only first-party failed-or-slow requests are itemized — a healthy
    // request tells the judge nothing a count doesn't, and the prompt
    // explicitly says third-party failures are NOT broken. Itemizing them
    // anyway just hands the judge something to (wrongly) cite; a bare count
    // is all it needs to know they happened.
    notable: {
      method: string;
      url: string;
      status: number | null;
      failure?: string;
      durationMs: number;
      afterSettle: boolean;
      slow: boolean;
    }[];
    omitted: number;
    thirdPartyFailed: number;
  };
  console: { entries: { text: string; sourceUrl?: string; count: number }[]; omitted: number };
  pageErrors: { entries: string[]; omitted: number };
  render: {
    textLength: number;
    title: string;
    h1: string | null;
    textSample: string;
    errorMarkersFound: string[];
    spinnerStuck: boolean;
    screenshotLooksBlank: boolean;
    missingSelectors: string[];
    notFoundMarkersFound: string[];
  };
  dataFidelity?: {
    contentFields: Record<string, string | number>;
    apiMatchedCount: number;
    warnings: string[];
  };
  flows: { name: string; ok: boolean; failedStep?: string }[];
}

/** Deterministically compress one visit's Signals for the judge. */
export function buildDigest(signals: Signals, opts: DigestOptions = {}): SignalsDigest {
  const notableAll = signals.requests.filter((r) => r.status === null || (r.status ?? 0) >= 400 || r.slow);
  const firstPartyNotable = notableAll.filter((r) => r.firstParty);
  const notable = firstPartyNotable.slice(0, MAX_REQUESTS).map((r) => ({
    method: r.method,
    url: truncate(r.url, MAX_LINE),
    status: r.status,
    ...(r.failure !== undefined && { failure: truncate(r.failure, MAX_LINE) }),
    durationMs: r.durationMs,
    afterSettle: r.afterSettle,
    slow: r.slow,
  }));

  const consoleEntries = signals.console.slice(0, MAX_CONSOLE).map((c) => ({
    text: truncate(c.text, MAX_LINE),
    ...(c.sourceUrl !== undefined && { sourceUrl: truncate(c.sourceUrl, MAX_LINE) }),
    count: c.count,
  }));

  const pageErrors = signals.pageErrors.slice(0, MAX_PAGE_ERRORS).map((e) => truncate(firstLine(e), MAX_LINE));

  const fidelityWarnings = opts.fidelityWarnings ?? [];
  const hasFidelity = Object.keys(signals.contentFields).length > 0 || signals.apiMatchedCount > 0 || fidelityWarnings.length > 0;

  return {
    url: signals.url,
    finalUrl: signals.finalUrl,
    document: {
      status: signals.document.status,
      redirects: signals.document.redirects.length,
      ...(signals.document.navigationError !== undefined && { navigationError: signals.document.navigationError }),
      loadMs: signals.document.loadMs,
      settledMs: signals.document.settledMs,
      timedOut: signals.timedOut,
    },
    requests: {
      total: signals.requests.length,
      failed: signals.requests.filter((r) => r.status === null || (r.status ?? 0) >= 400).length,
      slow: signals.requests.filter((r) => r.slow).length,
      notable,
      omitted: firstPartyNotable.length - notable.length,
      thirdPartyFailed: notableAll.length - firstPartyNotable.length,
    },
    console: { entries: consoleEntries, omitted: signals.console.length - consoleEntries.length },
    pageErrors: { entries: pageErrors, omitted: signals.pageErrors.length - pageErrors.length },
    render: {
      textLength: signals.render.textLength,
      title: truncate(signals.render.title, MAX_LINE),
      h1: signals.render.h1 === null ? null : truncate(signals.render.h1, MAX_LINE),
      textSample: truncate(signals.render.textSample, MAX_TEXT_SAMPLE),
      errorMarkersFound: signals.render.errorMarkersFound,
      spinnerStuck: signals.render.spinnerStuck,
      screenshotLooksBlank: signals.render.screenshotLooksBlank,
      missingSelectors: signals.render.missingSelectors,
      notFoundMarkersFound: signals.render.notFoundMarkersFound,
    },
    ...(hasFidelity && {
      dataFidelity: {
        contentFields: signals.contentFields,
        apiMatchedCount: signals.apiMatchedCount,
        warnings: fidelityWarnings,
      },
    }),
    flows: signals.flows.map((f) => ({
      name: f.name,
      ok: f.ok,
      ...(!f.ok && { failedStep: f.steps.find((s) => !s.ok)?.instruction }),
    })),
  };
}

export function serializeDigest(digest: SignalsDigest): string {
  // Compact — indentation whitespace is pure token cost to the judge.
  return JSON.stringify(digest);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return nl === -1 ? s : s.slice(0, nl);
}
