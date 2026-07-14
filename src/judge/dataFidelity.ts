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
    if (value === undefined) {
      // A matching content-API response was seen this visit, but this specific
      // field never appeared in it — most likely the backend renamed or
      // dropped the field and the frontend (still reading the old name) is
      // silently rendering nothing for it. If no matching response was seen
      // at all, there's genuinely nothing to check — stay silent.
      if (signals.apiMatchedCount > 0) {
        warnReasons.push(
          `configured field "${field}" was never found in ${signals.apiMatchedCount} matching API response(s) this visit — possible backend rename or removed field`
        );
      }
      continue;
    }
    const needle = normalize(String(value));
    if (needle.length === 0) continue;
    if (!sample.includes(needle)) {
      warnReasons.push(`API field "${field}" = ${JSON.stringify(value)}, but that text was not found on the rendered page`);
    }
  }
  return { warnReasons };
}
