#!/usr/bin/env node
// CLI — thin wrapper over the library (documentation/07-library-api.md).
//   vigil run | discover | check | init | report
// Exit codes: 0 HEALTHY · 1 BROKEN · 2 DEGRADED · 3 INCONCLUSIVE · 4 operational.

import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Vigil } from "./orchestrator.js";
import type { VigilConfig } from "./config.js";
import { printSummary, pathOf, exitCode, coverageLine, judgeErrorReason } from "./reporter/index.js";

const program = new Command();
program.name("vigil").description("Post-deploy sanity checker — deterministic capture, AI judgment.");

program
  .command("run")
  .description("Run the full sanity pipeline against a target")
  .option("--url <url>", "target URL (overrides config)")
  .option("--fail-on <level>", "broken | degraded — gate the exit code", undefined)
  .option("--only <glob>", "restrict discovered pages to a path glob")
  .option("--no-judge", "disable AI judge (hard rules only)")
  .option("--json", "print the full RunResult as JSON")
  .option("--prev-verdict <verdict>", "previous run verdict (Slack recovery — Phase 4)")
  .action(async (opts) => {
    await withOperationalGuard(async () => {
      const config = await loadConfig();
      if (opts.only) config.discovery = { ...config.discovery, include: [opts.only] };
      if (opts.failOn) config.report = { ...config.report, failOn: opts.failOn };
      // doc 05: model.judge = false disables the judge stage (hard rules only)
      if (opts.judge === false) config.model = { ...config.model, judge: false };

      const vigil = await Vigil.create(config, opts.url);
      vigil.events.on("page:complete", (p) => {
        const mark = { fail: "❌", warn: "⚠️", pass: "✅", skipped: "⏭️" }[p.status];
        process.stderr.write(`  ${mark} ${pathOf(p.url)} — ${p.headline}\n`);
      });

      const result = await vigil.run();
      if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      else printSummary(result);

      process.exit(exitCode(result.verdict, vigil.config.report.failOn));
    });
  });

program
  .command("discover")
  .description("Print the Page Set (a dry run of discovery)")
  .option("--url <url>", "target URL (overrides config)")
  .action(async (opts) => {
    await withOperationalGuard(async () => {
      const vigil = await Vigil.create(await loadConfig(), opts.url);
      const set = await vigil.discover();
      process.stdout.write(`Discovered ${set.pages.length} page(s)${set.truncated ? " (truncated at maxPages)" : ""}:\n\n`);
      for (const p of set.pages) {
        process.stdout.write(`  ${p.source.padEnd(8)} ${pathOf(p.url)}${p.patternGroup ? `  [${p.patternGroup}]` : ""}\n`);
      }
      process.stdout.write(`\ncoverage: ${coverageLine(set.coverage)}\n`);
    });
  });

program
  .command("check")
  .description("Check a single page (fast feedback while configuring)")
  .argument("<url-or-path>", "a full URL or a path like /checkout")
  .option("--url <url>", "base URL for relative paths (overrides config)")
  .action(async (target, opts) => {
    await withOperationalGuard(async () => {
      // A full URL argument doubles as the target; a bare path needs --url/config.
      const base = opts.url ?? (/^https?:\/\//i.test(target) ? target : undefined);
      const vigil = await Vigil.create(await loadConfig(), base);
      const p = await vigil.checkPage(target);
      const mark = { fail: "❌", warn: "⚠️", pass: "✅", skipped: "⏭️" }[p.status];
      // p.headline for an unjudged/error page is a label glued onto the
      // *pre-judge* deterministic headline ("unjudged — judge error: <old
      // headline>") — it never carries the actual reason the judge call
      // failed. Without printing judgeError too, a rate limit or provider
      // outage is indistinguishable from the judge having genuinely looked
      // and found the page unresolved.
      const why = judgeErrorReason(p);
      const reason = why ? `\n   reason: ${why}` : "";
      process.stdout.write(`\n${mark} ${p.status.toUpperCase()}${p.hardRule ? ` (${p.hardRule})` : ""} ${pathOf(p.url)}\n   ${p.headline}${reason}\n`);
      process.exit(p.status === "fail" ? 1 : 0);
    });
  });

program
  .command("init")
  .description("Scaffold vigil.config.ts and .gitignore entries")
  .action(async () => {
    const cfgPath = resolve("vigil.config.ts");
    if (existsSync(cfgPath)) process.stdout.write("vigil.config.ts already exists — leaving it untouched.\n");
    else {
      await writeFile(cfgPath, CONFIG_TEMPLATE, "utf8");
      process.stdout.write("Created vigil.config.ts\n");
    }
    await ensureGitignore();
  });

program
  .command("report")
  .description("Open the HTML report for a run (defaults to the latest)")
  .argument("[run-id]", "run id; omit for the most recent")
  .action(async (runId) => {
    await withOperationalGuard(async () => {
      const config = await loadConfig();
      const dir = (config.report?.dir as string) ?? "vigil-report";
      const id = runId ?? (await latestRun(dir));
      if (!id) throw new Error(`No runs found in ${dir}/`);
      const html = join(dir, id, "report.html");
      if (!existsSync(html)) throw new Error(`Report not found: ${html}`);
      openInBrowser(html);
      process.stdout.write(`Opening ${html}\n`);
    });
  });

// ── helpers ──────────────────────────────────────────────────────────────────

const CONFIG_NAMES = ["vigil.config.ts", "vigil.config.mts", "vigil.config.mjs", "vigil.config.js"];

async function loadConfig(cwd = process.cwd()): Promise<VigilConfig> {
  for (const name of CONFIG_NAMES) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      return (mod.default ?? mod) as VigilConfig;
    } catch (err) {
      const hint = name.endsWith(".ts") ? " (run under tsx, or use a .mjs/.js config)" : "";
      throw new Error(`Failed to load ${name}${hint}: ${(err as Error).message}`);
    }
  }
  return {};
}

/** Operational failures throw; check failures never do. Exit 4 on operational. */
async function withOperationalGuard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    process.stderr.write(`\nvigil: ${(err as Error).message}\n`);
    process.exit(4);
  }
}

async function latestRun(dir: string): Promise<string | null> {
  try {
    const runIdRe = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[0-9a-f]{4}$/;
    const entries = (await readdir(dir)).filter((n) => runIdRe.test(n)).sort();
    return entries.at(-1) ?? null;
  } catch {
    return null;
  }
}

async function ensureGitignore(): Promise<void> {
  const path = resolve(".gitignore");
  const entries = ["vigil-report/", ".vigil-auth.json"];
  let current = "";
  if (existsSync(path)) current = await readFile(path, "utf8");
  const missing = entries.filter((e) => !current.split(/\r?\n/).includes(e));
  if (missing.length === 0) return;
  const block = `${current && !current.endsWith("\n") ? "\n" : ""}\n# vigil\n${missing.join("\n")}\n`;
  await appendFile(path, block, "utf8");
  process.stdout.write(`Added to .gitignore: ${missing.join(", ")}\n`);
}

function openInBrowser(file: string): void {
  const abs = resolve(file);
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", abs] : [abs];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

const CONFIG_TEMPLATE = `import { defineConfig } from "vigil";

export default defineConfig({
  url: process.env.TARGET_URL ?? "https://example.com",

  discovery: {
    routes: ["/"],            // always visited, first
    sitemap: true,
    crawl: { depth: 2, maxPages: 100 },
    exclude: ["/admin/**", "/api/**", "/logout"],
  },

  budgets: {
    maxPages: 150,
    maxRunMinutes: 10,
    concurrency: 5,
  },

  // Judge auto-detects from ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY if omitted.
  // Use --no-judge or model: { judge: false } to disable.
  // model: { judge: anthropic("claude-haiku-4-5") },
});
`;

program.parseAsync();
