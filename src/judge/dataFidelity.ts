// Data-fidelity check — deterministic, opt-in, warn-only companion to
// hardRules.ts (documentation plan, 2026-07-13).
//
// Problem: a backend field-rename, a broken i18n key, or a stale mapping can
// mean the API returns correct data but the frontend fails to render it
// faithfully — none of which crash, blank the page, or fail a request, so
// H1-H5 and the existing warn tier never see them.
//
// This check asks one narrow question per configured field: does that field's
// value (already extracted from a matching content-API response by the
// collector, per checks.dataFidelity.apiPathPatterns) actually appear,
// normalized, in the rendered page's bounded text sample?
//
// Never promotes to a hard fail: text-matching is inherently heuristic
// (truncation, casing, i18n) — this project's hard-won principle is that
// trust in the red light is the scarcest resource. A miss is always a warn.

import type { Signals } from "../types.js";
import type { ResolvedConfig } from "../config.js";

export interface DataFidelityResult {
  warnReasons: string[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Compare captured content-field values against the rendered text sample. */
export function evaluateDataFidelity(
  signals: Signals,
  config: ResolvedConfig["checks"]["dataFidelity"]
): DataFidelityResult {
  if (!config.enabled || config.fields.length === 0) return { warnReasons: [] };

  const sample = normalize(signals.render.textSample);
  const warnReasons: string[] = [];
  for (const field of config.fields) {
    const value = signals.contentFields[field];
    if (value === undefined) continue; // no matching API response seen this visit — nothing to check
    const needle = normalize(String(value));
    if (needle.length === 0) continue;
    if (!sample.includes(needle)) {
      warnReasons.push(`API field "${field}" = ${JSON.stringify(value)}, but that text was not found on the rendered page`);
    }
  }
  return { warnReasons };
}
