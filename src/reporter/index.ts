// Reporter — writes vigil-report/<run-id>/ (JSON + summary.md + self-contained
// HTML) and prunes old runs (documentation/06-reporting.md). Artifacts are for
// humans and CI only; vigil never reads them back.

import { writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PageResult, RunResult, RunVerdict } from "../types.js";
import type { ResolvedConfig } from "../config.js";
import { renderHtml } from "./html.js";

const VERDICT_EMOJI: Record<RunVerdict, string> = {
  HEALTHY: "✅",
  DEGRADED: "⚠️",
  BROKEN: "❌",
  INCONCLUSIVE: "❔",
};

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[0-9a-f]{4}$/;

export async function writeReport(result: RunResult, config: ResolvedConfig): Promise<void> {
  const dir = result.artifactsDir;
  await writeFile(join(dir, "report.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(join(dir, "summary.md"), buildSummary(result), "utf8");
  await writeFile(join(dir, "report.html"), await renderHtml(result), "utf8");
  await pruneOldRuns(config.report.dir, config.report.keepRuns);
}

/** The 10-second version — postable to Slack / a PR comment as-is. */
export function buildSummary(result: RunResult): string {
  const host = hostOf(result.target.url);
  const deploy = result.target.deployRef ? ` · deploy ${result.target.deployRef}` : "";
  const c = result.counts;
  const parts: string[] = [];
  if (c.fail) parts.push(`${c.fail} failed`);
  parts.push(`${c.pass} passed`);
  if (c.warn) parts.push(`${c.warn} warned`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);

  const cost = result.cost.modelUsd > 0 ? ` · $${result.cost.modelUsd.toFixed(2)}` : "";
  const lines = [
    `## vigil · ${result.verdict} · ${host}${deploy}`,
    `**${parts.join(" · ")}** · ${fmtDuration(result.durationMs)}${cost}`,
    "",
  ];

  const fails = result.pages.filter((p) => p.status === "fail");
  const warns = result.pages.filter((p) => p.status === "warn");
  const skips = result.pages.filter((p) => p.status === "skipped");
  for (const p of fails) lines.push(formatSummaryLine(p));
  for (const p of warns) lines.push(formatSummaryLine(p));
  for (const p of skips) lines.push(`⏭️ **${pathOf(p.url)}** — ${p.headline}`);

  if (result.budgetsExhausted.length)
    lines.push("", `_budgets exhausted: ${result.budgetsExhausted.join(", ")}_`);

  lines.push("", `_coverage: ${coverageLine(result.coverage)}_`);

  return lines.join("\n") + "\n";
}

// doc 06: format page summary lines with judge confidence or explicit unjudged reason.
// p.headline (built by the orchestrator's unjudgedWarn) already states *that*
// a page went unjudged; the technical *why* lives solely in p.judgeError and
// has to be appended separately — every caller that prints a page's headline
// needs this same check, or the *why* silently disappears for that caller (as
// happened to the `vigil check` CLI command, which reimplemented a subset of
// this by hand and dropped the reason clause).
export function judgeErrorReason(p: PageResult): string | undefined {
  return p.decidedBy === "error" && p.judgeError ? p.judgeError : undefined;
}

function formatSummaryLine(p: PageResult): string {
  const mark = { fail: "❌", warn: "⚠️", pass: "✅", skipped: "⏭️" }[p.status];
  let headline = p.headline;

  if (p.decidedBy === "judge" && p.judge && !headline.includes("low confidence")) {
    headline += ` (judge ${p.judge.confidence})`;
  } else {
    const reason = judgeErrorReason(p);
    if (reason) headline = `${headline} — reason: ${reason}`;
  }

  return `${mark} **${pathOf(p.url)}** — ${headline}`;
}

/** The one-line answer to "did discovery hit all the pages?" (documentation/03). */
export function coverageLine(cov: RunResult["coverage"]): string {
  const parts = [
    `sitemap ${cov.sitemap.urlsDeclared} url(s) across ${cov.sitemap.sitemapsFetched} sitemap doc(s)`,
    `crawl found ${cov.crawl.urlsFound}`,
    `config ${cov.config}`,
  ];
  if (cov.api.graphqlEndpoint || cov.api.openapiEndpoint) {
    const schemas = [cov.api.graphqlEndpoint && "graphql", cov.api.openapiEndpoint && "openapi"]
      .filter(Boolean)
      .join("+");
    parts.push(`api (${schemas}) confirmed ${cov.api.candidatesConfirmed}/${cov.api.candidatesGenerated}`);
  }
  const dropped: string[] = [];
  if (cov.duplicatesDropped) dropped.push(`${cov.duplicatesDropped} duplicate`);
  if (cov.samplingDropped) dropped.push(`${cov.samplingDropped} sampled out of parametric families`);
  if (cov.capDropped) dropped.push(`${cov.capDropped} cut by maxPages`);
  if (dropped.length) parts.push(`dropped: ${dropped.join(", ")}`);
  return parts.join(" · ");
}

/** Print the summary to stdout with the verdict emoji. */
export function printSummary(result: RunResult): void {
  process.stdout.write(`\n${VERDICT_EMOJI[result.verdict]} ${buildSummary(result)}\n`);
  process.stdout.write(`report: ${join(result.artifactsDir, "report.html")}\n`);
}

async function pruneOldRuns(reportDir: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(reportDir);
  } catch {
    return; // dir doesn't exist yet
  }
  const runDirs: { name: string; mtime: number }[] = [];
  for (const name of entries) {
    if (!RUN_ID_RE.test(name)) continue; // only ever touch our own run dirs
    try {
      const s = await stat(join(reportDir, name));
      if (s.isDirectory()) runDirs.push({ name, mtime: s.mtimeMs });
    } catch {
      /* skip */
    }
  }
  if (runDirs.length <= keep) return;
  runDirs.sort((a, b) => b.mtime - a.mtime); // newest first
  for (const { name } of runDirs.slice(keep)) {
    await rm(join(reportDir, name), { recursive: true, force: true }).catch(() => {});
  }
}

// ── formatting helpers (also used by html.ts) ────────────────────────────────

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function verdictEmoji(v: RunVerdict): string {
  return VERDICT_EMOJI[v];
}

/**
 * The CI exit-code contract (documentation/06). `failOn` decides whether a
 * DEGRADED run gates the pipeline: with the default `broken`, degraded exits 0
 * (visible in the report, but non-blocking); with `degraded`, it exits 2.
 *   0 HEALTHY · 1 BROKEN · 2 DEGRADED(gated) · 3 INCONCLUSIVE · 4 operational.
 */
export function exitCode(verdict: RunVerdict, failOn: "broken" | "degraded"): number {
  switch (verdict) {
    case "HEALTHY":
      return 0;
    case "BROKEN":
      return 1;
    case "DEGRADED":
      return failOn === "degraded" ? 2 : 0;
    case "INCONCLUSIVE":
      return 3;
  }
}

export function statusOrder(p: PageResult): number {
  return { fail: 0, warn: 1, skipped: 2, pass: 3 }[p.status];
}
