// Orchestrator — owns a Run; sequences discovery → capture → judgment → report;
// enforces budgets (documentation/02-architecture.md).
//
// Phase 1: no model. The "judgment" step is the deterministic rule engine
// (judge/hardRules.ts). The AI judge and its cost accounting arrive in Phase 2.

import { chromium, firefox, webkit, type Browser } from "playwright";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  DiscoveredPage,
  PageResult,
  PageSet,
  RunResult,
  RunVerdict,
  Signals,
  VigilEvents,
} from "./types.js";
import { resolveConfig, type ResolvedConfig, type VigilConfig } from "./config.js";
import { discover } from "./discovery/index.js";
import { collect } from "./collector.js";
import { evaluateRules, type RuleDecision } from "./judge/hardRules.js";
import { evaluateDataFidelity } from "./judge/dataFidelity.js";
import { writeReport } from "./reporter/index.js";
import { TypedEmitter } from "./util/emitter.js";
import { slugForUrl, uniqueSlug } from "./util/slug.js";

const ENGINES = { chromium, firefox, webkit };

export class Vigil {
  readonly config: ResolvedConfig;
  readonly events = new TypedEmitter<VigilEvents>();

  private constructor(config: ResolvedConfig) {
    this.config = config;
  }

  static async create(config: VigilConfig = {}, url?: string): Promise<Vigil> {
    return new Vigil(resolveConfig(config, url));
  }

  private launch(): Promise<Browser> {
    return ENGINES[this.config.checks.browser].launch();
  }

  /** Phase 1 discovery only — a dry run for inspecting the Page Set. */
  async discover(): Promise<PageSet> {
    const browser = await this.launch();
    try {
      return await discover(this.config, browser);
    } finally {
      await browser.close();
    }
  }

  /** Full pipeline: discover, visit+capture in parallel, decide, report. */
  async run(): Promise<RunResult> {
    const startedAt = new Date();
    const runId = makeRunId(startedAt);
    const artifactsDir = join(this.config.report.dir, runId);
    const pagesDir = join(artifactsDir, "pages");
    await mkdir(pagesDir, { recursive: true });

    const browser = await this.launch();
    const budgetsExhausted = new Set<string>();
    let pages: PageResult[] = [];
    let pageSet: PageSet = {
      pages: [],
      generatedAt: startedAt.toISOString(),
      truncated: false,
      coverage: {
        config: 0,
        sitemap: { sitemapsFetched: 0, urlsDeclared: 0 },
        crawl: { urlsFound: 0 },
        api: { graphqlEndpoint: null, openapiEndpoint: null, candidatesGenerated: 0, candidatesConfirmed: 0 },
        duplicatesDropped: 0,
        samplingDropped: 0,
        capDropped: 0,
      },
    };

    try {
      pageSet = await discover(this.config, browser);
      if (pageSet.truncated) budgetsExhausted.add("maxPages");
      this.events.emit("run:start", { runId, pageSet });

      const slugs = new Set<string>();
      const slugOf = (url: string) => uniqueSlug(slugForUrl(url), slugs);
      const deadline = startedAt.getTime() + this.config.budgets.maxRunMinutes * 60_000;

      pages = await this.visitAll(browser, pageSet.pages, pagesDir, slugOf, deadline, budgetsExhausted);
    } finally {
      await browser.close();
    }

    const verdict = rollup(pages, budgetsExhausted.size > 0);
    const durationMs = Date.now() - startedAt.getTime();
    const result: RunResult = {
      schemaVersion: 1,
      runId,
      verdict,
      target: { url: this.config.url!, deployRef: this.config.deployRef },
      startedAt: startedAt.toISOString(),
      durationMs,
      counts: countStatuses(pages),
      cost: { modelCalls: 0, modelUsd: 0 }, // no model in Phase 1
      budgetsExhausted: [...budgetsExhausted],
      pages,
      coverage: pageSet.coverage,
      artifactsDir,
    };

    await writeReport(result, this.config);
    this.events.emit("run:complete", result);
    return result;
  }

  /** Targeted single-page re-check (fast feedback while configuring). */
  async checkPage(urlOrPath: string): Promise<PageResult> {
    const origin = new URL(this.config.url!).origin;
    const url = new URL(urlOrPath, origin).toString();
    const browser = await this.launch();
    const dir = join(this.config.report.dir, "_check");
    await mkdir(dir, { recursive: true });
    try {
      return await this.visitOne(browser, { url, source: "config" }, dir, "check");
    } finally {
      await browser.close();
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async visitAll(
    browser: Browser,
    discovered: DiscoveredPage[],
    pagesDir: string,
    slugOf: (url: string) => string,
    deadline: number,
    budgetsExhausted: Set<string>
  ): Promise<PageResult[]> {
    const results: PageResult[] = new Array(discovered.length);
    let next = 0;
    const concurrency = Math.min(this.config.budgets.concurrency, discovered.length || 1);

    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= discovered.length) return;
        const page = discovered[i]!;
        if (Date.now() > deadline) {
          budgetsExhausted.add("maxRunMinutes");
          results[i] = skipped(page, "run time budget exhausted before visit");
          this.events.emit("page:complete", results[i]!);
          continue;
        }
        this.events.emit("page:start", { url: page.url });
        results[i] = await this.visitOne(browser, page, pagesDir, slugOf(page.url));
        this.events.emit("page:complete", results[i]!);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  }

  private async visitOne(
    browser: Browser,
    page: DiscoveredPage,
    pagesDir: string,
    slug: string
  ): Promise<PageResult> {
    const origin = new URL(this.config.url!).origin;
    const opts = {
      origin,
      viewport: this.config.checks.viewport,
      latencyBudgetMs: this.config.checks.latencyBudgetMs,
      errorMarkers: this.config.checks.errorMarkers,
      consoleAllowlist: this.config.checks.consoleErrorAllowlist,
      perPageVisitMs: this.config.budgets.perPageVisitMs,
      dataFidelity: this.config.checks.dataFidelity,
    };

    const t0 = Date.now();
    const signals = await collect(browser, page.url, { ...opts, screenshotPath: join(pagesDir, `${slug}.png`) });
    let decision = evaluateRules(signals);

    // Data-fidelity is a separate, opt-in, warn-only signal — it never
    // overrides a hard fail and is reported through its own field rather than
    // merged into the hard-rule warn tier, so it stays visible on its own.
    const fidelity = evaluateDataFidelity(signals, this.config.checks.dataFidelity);
    const fidelityWarnings = fidelity.warnReasons.length > 0 ? fidelity.warnReasons : undefined;
    if (fidelityWarnings && decision.status === "pass") {
      decision = { ...decision, status: "warn", headline: fidelityWarnings[0]! };
    }

    let retried = false;
    let flaky = false;
    let retrySignals: Signals | undefined;

    // Retry protocol: any candidate fail is retried once with a fresh context.
    if (decision.status === "fail") {
      retried = true;
      retrySignals = await collect(browser, page.url, {
        ...opts,
        screenshotPath: join(pagesDir, `${slug}.retry.png`),
      });
      const retryDecision = evaluateRules(retrySignals);
      if (retryDecision.status !== "fail") {
        flaky = true;
        decision = {
          status: "warn",
          headline: `passed on retry (flaky): ${decision.headline}`,
          warnReasons: [`flaky — first visit failed (${decision.hardRule ?? "rule"}), retry recovered`],
        };
      }
      // Fail twice → the failure stands; both captures are kept.
    }

    const visitMs = Date.now() - t0;
    return toPageResult(page, decision, signals, retrySignals, { retried, flaky, visitMs, fidelityWarnings });
  }
}

// ── pure helpers ───────────────────────────────────────────────────────────

function toPageResult(
  page: DiscoveredPage,
  decision: RuleDecision,
  signals: Signals,
  retrySignals: Signals | undefined,
  meta: { retried: boolean; flaky: boolean; visitMs: number; fidelityWarnings?: string[] }
): PageResult {
  return {
    url: page.url,
    source: page.source,
    status: decision.status,
    headline: decision.headline,
    decidedBy: "hard-rule", // Phase 1: the deterministic rule engine decides every page
    hardRule: decision.hardRule,
    fidelityWarnings: meta.fidelityWarnings,
    retried: meta.retried,
    flaky: meta.flaky,
    signals,
    retrySignals,
    timings: { visitMs: meta.visitMs },
    cost: { judgeUsd: 0, flowsUsd: 0 },
  };
}

function skipped(page: DiscoveredPage, headline: string): PageResult {
  return {
    url: page.url,
    source: page.source,
    status: "skipped",
    headline,
    decidedBy: "skipped",
    retried: false,
    flaky: false,
    signals: emptySignals(page.url),
    timings: { visitMs: 0 },
    cost: { judgeUsd: 0, flowsUsd: 0 },
  };
}

function emptySignals(url: string): Signals {
  return {
    url,
    finalUrl: url,
    document: { status: null, redirects: [], loadMs: null, settledMs: null },
    requests: [],
    console: [],
    pageErrors: [],
    crashed: false,
    render: {
      textLength: 0,
      title: "",
      h1: null,
      textSample: "",
      errorMarkersFound: [],
      spinnerStuck: false,
      screenshotLooksBlank: true,
    },
    contentFields: {},
    flows: [],
    screenshotPath: "",
    timedOut: false,
  };
}

/** Verdict rollup + environmental override (documentation/05, 06). */
export function rollup(pages: PageResult[], budgetExhausted: boolean): RunVerdict {
  const visited = pages.filter((p) => p.status !== "skipped");
  const h1Fails = visited.filter((p) => p.status === "fail" && p.hardRule === "H1").length;
  // Environmental override: ≥50% of visited pages hit a network-type hard failure.
  if (visited.length > 0 && h1Fails / visited.length >= 0.5) return "INCONCLUSIVE";

  if (pages.some((p) => p.status === "fail")) return "BROKEN";
  if (budgetExhausted || pages.some((p) => p.status === "warn" || p.status === "skipped")) return "DEGRADED";
  return "HEALTHY";
}

export function countStatuses(pages: PageResult[]): RunResult["counts"] {
  const counts = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  for (const p of pages) counts[p.status]++;
  return counts;
}

function makeRunId(date: Date): string {
  const stamp = date.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  return `${stamp}_${randomBytes(2).toString("hex")}`;
}
