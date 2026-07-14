// Stage 1 — Hard-failure rules, plus the Phase-1 deterministic warn tier.
// (documentation/05-judgment.md)
//
// Hard rules (H1–H5) are absolute: first match FAILS the page with the rule as
// evidence, no model, no ambiguity. In full vigil, non-hard-failed pages go to
// the AI judge (Stage 2). Phase 1 has no judge, so instead of guessing we apply
// a conservative deterministic warn tier: loud, first-party, machine-checkable
// concerns become `warn` (yellow / DEGRADED) — never `fail`. This preserves the
// "zero false reds" guarantee while making Phase 1 a genuinely useful smoke test.

import type { Signals, HardRule } from "../types.js";

export interface RuleDecision {
  status: "pass" | "warn" | "fail";
  hardRule?: HardRule;
  headline: string;
  /** Human-readable warn reasons (drive the report's yellow detail in Phase 1). */
  warnReasons: string[];
}

/** Evaluate the deterministic rules against one page's signals. */
export function evaluateRules(signals: Signals): RuleDecision {
  const s = signals;

  // ── Hard failures (in order) ──
  // H1 — Navigation failed (DNS, refused, TLS, timeout with zero bytes).
  if (s.document.status === null) {
    return hard("H1", `Navigation failed: ${s.document.navigationError ?? "no response"}`);
  }
  // H2 — Document status ≥ 500.
  if (s.document.status >= 500) {
    return hard("H2", `Document responded ${s.document.status}`);
  }
  // H3 — Page crashed.
  if (s.crashed) {
    return hard("H3", "Browser reported a page crash");
  }
  // H4 — Blank render on a 200 (the classic bundle-404 / failed-mount symptom).
  if (s.render.textLength < 40 && s.render.screenshotLooksBlank) {
    return hard("H4", `Blank render: ${s.render.textLength} chars of visible text, no visual content`);
  }
  // H5 — 404 on a discovered page (every visited page is app-linked or listed).
  if (s.document.status === 404) {
    return hard("H5", "404 on a page the app itself links or lists");
  }

  // ── Deterministic warn tier (Phase 1) ──
  const warns: string[] = [];

  if (s.document.status >= 400) {
    warns.push(`document returned ${s.document.status}`);
  }

  const firstPartyBad = s.requests.filter(
    (r) => r.firstParty && !r.afterSettle && (r.status === null || (r.status ?? 0) >= 400)
  );
  if (firstPartyBad.length > 0) {
    const ex = firstPartyBad[0]!;
    const detail = ex.status === null ? (ex.failure ?? "network failure") : `HTTP ${ex.status}`;
    warns.push(
      `${firstPartyBad.length} first-party request(s) failed (e.g. ${ex.method} ${pathOf(ex.url)} → ${detail})`
    );
  }

  if (s.render.errorMarkersFound.length > 0) {
    warns.push(`error marker in page text (/${s.render.errorMarkersFound[0]}/)`);
  }
  if (s.render.missingSelectors.length > 0) {
    warns.push(`required selector(s) not found post-settle: ${s.render.missingSelectors.join(", ")}`);
  }
  if (s.render.notFoundMarkersFound.length > 0) {
    warns.push(`possible soft-404: page text matched /${s.render.notFoundMarkersFound[0]}/ on a 200 response`);
  }
  if (s.render.spinnerStuck) {
    warns.push("a loading spinner was still visible after settle");
  }
  if (s.pageErrors.length > 0) {
    warns.push(`${s.pageErrors.length} uncaught page error(s): ${firstClause(s.pageErrors[0]!)}`);
  }
  if (s.console.length > 0) {
    const total = s.console.reduce((n, c) => n + c.count, 0);
    warns.push(`${total} console error(s): ${firstClause(s.console[0]!.text)}`);
  }
  if (s.timedOut) {
    warns.push("page did not settle within the visit budget");
  }
  const slow = s.requests.filter((r) => r.firstParty && r.slow);
  if (slow.length > 0) {
    warns.push(`${slow.length} slow first-party request(s)`);
  }

  if (warns.length > 0) {
    return { status: "warn", headline: warns[0]!, warnReasons: warns };
  }

  return {
    status: "pass",
    headline: `${s.document.status} · ${s.render.textLength} chars rendered · signals clean`,
    warnReasons: [],
  };
}

function hard(rule: HardRule, headline: string): RuleDecision {
  return { status: "fail", hardRule: rule, headline, warnReasons: [] };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function firstClause(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 120 ? t.slice(0, 117) + "…" : t;
}
