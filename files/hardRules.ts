import type { Signals, PageResult } from "./types.js";

/**
 * Stage 1 — Hard-failure rules (05-judgment.md).
 * Evaluated in order; first match fails the page with the rule as evidence.
 * If nothing matches, this page needs the judge (Stage 2, not built yet in Phase 1)
 * or, in the AI-less Phase 1 slice, defaults to "pass".
 */
export function applyHardRules(signals: Signals): PageResult {
  const { url } = signals;

  // H1 — Navigation failed (DNS, refused, TLS, timeout with zero bytes)
  if (signals.document.status === null) {
    return fail(url, "H1", `Navigation failed: ${signals.document.navigationError ?? "unknown error"}`);
  }

  // H2 — Document status >= 500
  if (signals.document.status >= 500) {
    return fail(url, "H2", `Document responded ${signals.document.status}`);
  }

  // H3 — Page crashed
  if (signals.crashed) {
    return fail(url, "H3", "Browser reported a page crash");
  }

  // H4 — Rendered text length < 40 chars AND screenshot ~= uniform (blank-white-screen-with-200)
  if (signals.render.textLength < 40 && signals.render.screenshotLooksBlank) {
    return fail(url, "H4", `Blank render: only ${signals.render.textLength} chars of visible text on a 200`);
  }

  // H5 — 404 on a page the app itself discovered (sitemap/crawl/config), not a random guess
  if (signals.document.status === 404 && signals.isDiscoveredPage) {
    return fail(url, "H5", "404 on a page the app itself links or lists");
  }

  // Nothing hard-failed. In full Vigil this goes to the judge (Stage 2).
  // Phase 1 has no judge yet, so we say so honestly instead of guessing "pass".
  return {
    url,
    status: "pass",
    headline: `Status ${signals.document.status}, ${signals.render.textLength} chars rendered — no hard failures (unjudged: Stage 2 judge not built yet)`,
    decidedBy: "unjudged",
  };
}

function fail(url: string, rule: PageResult["hardRule"], headline: string): PageResult {
  return { url, status: "fail", headline, decidedBy: "hard-rule", hardRule: rule };
}
