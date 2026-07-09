// Trimmed from 08-data-models.md — only the fields Stage 1 (hard rules) reads.
// The full Signals type (console, requests[], flows, etc.) is what the real
// Collector will produce in Phase 1/2; this is the honest subset for today.

export interface Signals {
  url: string;
  document: {
    status: number | null;      // null = navigation failed entirely
    navigationError?: string;   // DNS/refused/timeout/TLS text (only set if status is null)
  };
  crashed: boolean;
  render: {
    textLength: number;         // document.body.innerText.length after settle
    screenshotLooksBlank: boolean; // heuristic stand-in for "screenshot ~= uniform color"
  };
  isDiscoveredPage: boolean;    // true if the app itself links/lists this page (sitemap/crawl)
}

export type PageStatus = "pass" | "warn" | "fail" | "skipped";

export interface PageResult {
  url: string;
  status: PageStatus;
  headline: string;
  decidedBy: "hard-rule" | "judge" | "unjudged";
  hardRule?: "H1" | "H2" | "H3" | "H4" | "H5";
}
