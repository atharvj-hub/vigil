// Orchestrator — owns a Run; sequences discovery → capture → judgment → report;
// enforces budgets (documentation/02-architecture.md).
//
// Judgment is two-stage: the deterministic rule engine (judge/hardRules.ts)
// has absolute first say; pages it doesn't hard-fail go to the AI judge
// (judge/judge.ts) behind a reserve → commit/refund CostMeter. The judge
// itself never sees budgets — reservation, commit, and every fallback
// (`budget`, `error`) are decided here.

import { chromium, firefox, webkit, type Browser } from "playwright";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type {
  DiscoveredPage,
  JudgeVerdict,
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
import { CostMeter } from "./judge/costMeter.js";
import { resolveJudgeModel, type ResolvedModel } from "./judge/providers.js";
import { estimateJudgeCostUsd } from "./judge/pricing.js";
import { judgePage, ScreenshotUnreadableError } from "./judge/judge.js";
import { ModelUnavailableError, MalformedVerdictError } from "./judge/modelGateway.js";
import { applyPolicy } from "./judge/verdictPolicy.js";
import { writeReport } from "./reporter/index.js";
import { TypedEmitter } from "./util/emitter.js";
import { slugForUrl, uniqueSlug } from "./util/slug.js";

const ENGINES = { chromium, firefox, webkit };

/** The per-run judge machinery. null = judge explicitly disabled (hard rules only). */
interface JudgeRuntime {
  resolved: ResolvedModel;
  meter: CostMeter;
}

/** What one attempted judgment produced — the orchestrator's decision input. */
type JudgeAttempt =
  | { kind: "verdict"; verdict: JudgeVerdict; usd: number; ms: number }
  | { kind: "budget"; usd: 0; ms: 0 }
  | { kind: "error"; message: string; usd: number; ms: number };

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

  /**
   * Resolve the per-run judge machinery. `model.judge === false` disables the
   * judge entirely (hard rules only — the CLI's --no-judge). Otherwise a model
   * must be resolvable (explicit config or env key) — its absence is an
   * operational error, not a silent downgrade in scrutiny.
   */
  private async resolveJudgeRuntime(): Promise<JudgeRuntime | null> {
    const judgeCfg = (this.config.model as { judge?: LanguageModel | false } | undefined)?.judge;
    if (judgeCfg === false) return null;
    const resolved = await resolveJudgeModel(judgeCfg);
    return { resolved, meter: new CostMeter(this.config.budgets.maxModelCostUsd) };
  }

  /** Full pipeline: discover, visit+capture in parallel, decide, report. */
  async run(): Promise<RunResult> {
    const startedAt = new Date();
    const runId = makeRunId(startedAt);
    const artifactsDir = join(this.config.report.dir, runId);
    const pagesDir = join(artifactsDir, "pages");
    await mkdir(pagesDir, { recursive: true });

    const judge = await this.resolveJudgeRuntime();
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

      pages = await this.visitAll(browser, pageSet.pages, pagesDir, slugOf, deadline, budgetsExhausted, judge);
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
      cost: judge ? { modelCalls: judge.meter.calls, modelUsd: judge.meter.spent } : { modelCalls: 0, modelUsd: 0 },
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
    const judge = await this.resolveJudgeRuntime();
    const browser = await this.launch();
    const dir = join(this.config.report.dir, "_check");
    await mkdir(dir, { recursive: true });
    try {
      return await this.visitOne(browser, { url, source: "config" }, dir, "check", new Set(), judge);
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
    budgetsExhausted: Set<string>,
    judge: JudgeRuntime | null
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
        results[i] = await this.visitOne(browser, page, pagesDir, slugOf(page.url), budgetsExhausted, judge);
        this.events.emit("page:complete", results[i]!);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  }

  /**
   * One judgment attempt for one capture: reserve → judgePage → commit.
   * All budget/failure bookkeeping lives here, so `judgePage` stays budget-blind.
   */
  private async judgeOnce(
    judge: JudgeRuntime,
    signals: Signals,
    fidelityWarnings: string[] | undefined,
    budgetsExhausted: Set<string>
  ): Promise<JudgeAttempt> {
    const ticket = judge.meter.reserve(estimateJudgeCostUsd(judge.resolved.modelId));
    if (ticket === null) {
      if (!budgetsExhausted.has("maxModelCostUsd")) {
        this.events.emit("run:budget", { budget: "maxModelCostUsd", remaining: 0 });
        budgetsExhausted.add("maxModelCostUsd");
      }
      return { kind: "budget", usd: 0, ms: 0 };
    }

    const t0 = Date.now();
    try {
      const result = await judgePage(signals, {
        resolved: judge.resolved,
        origin: new URL(this.config.url!).origin,
        fidelityWarnings,
      });
      judge.meter.commit(ticket, result.usd);
      return { kind: "verdict", verdict: result.verdict, usd: result.usd, ms: result.ms };
    } catch (err) {
      if (err instanceof ModelUnavailableError || err instanceof MalformedVerdictError) {
        // Failed attempts still billed tokens — commit real spend, never hide it.
        judge.meter.commit(ticket, err.usdSoFar);
        return { kind: "error", message: err.message, usd: err.usdSoFar, ms: Date.now() - t0 };
      }
      if (err instanceof ScreenshotUnreadableError) {
        judge.meter.refund(ticket); // the provider was never reached
        return { kind: "error", message: err.message, usd: 0, ms: Date.now() - t0 };
      }
      judge.meter.refund(ticket);
      throw err; // unknown — a genuine bug, not a degradable model failure
    }
  }

  private async visitOne(
    browser: Browser,
    page: DiscoveredPage,
    pagesDir: string,
    slug: string,
    budgetsExhausted: Set<string>,
    judge: JudgeRuntime | null
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
      requiredSelectors: this.config.checks.requiredSelectors,
      notFoundMarkers: this.config.checks.notFoundMarkers,
      dismissCookieBanners: this.config.checks.dismissCookieBanners,
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
    let decidedBy: PageResult["decidedBy"] = "hard-rule";
    let judgeVerdict: JudgeVerdict | undefined;
    let unjudged = false;
    let judgeError: string | undefined;
    let judgeUsd = 0;
    let judgeMs = 0;

    if (decision.status === "fail") {
      // Hard-fail path — unchanged from Phase 1. Hard rules have absolute
      // authority; the model never second-guesses them.
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
    } else if (judge !== null) {
      // Judge stage — only for pages the deterministic layer didn't hard-fail.
      const attempt = await this.judgeOnce(judge, signals, fidelityWarnings, budgetsExhausted);
      judgeUsd += attempt.usd;
      judgeMs += attempt.ms;

      if (attempt.kind === "budget") {
        decidedBy = "budget";
        unjudged = true;
        decision = unjudgedWarn(decision, "unjudged — model budget exhausted");
      } else if (attempt.kind === "error") {
        decidedBy = "error";
        unjudged = true;
        judgeError = attempt.message;
        decision = unjudgedWarn(decision, "unjudged — judge error");
      } else {
        decidedBy = "judge";
        judgeVerdict = attempt.verdict;
        const policy = applyPolicy(attempt.verdict, {
          textLength: signals.render.textLength,
          screenshotLooksBlank: signals.render.screenshotLooksBlank,
        });

        if (policy.kind === "warn") {
          decision = { status: "warn", headline: policy.headline, warnReasons: decision.warnReasons };
        } else if (policy.kind === "candidate-fail") {
          // Free retry for flakiness — mirrors the hard-rule retry protocol:
          // one fresh capture, evaluated by hard rules only. No re-judge — a
          // second model call would double judge spend on every candidate
          // fail, and the confidence gate is meant to be the cost firewall,
          // not a second API call. Stricter than the hard-rule retry though:
          // the retry must come back fully clean (`pass`), not just
          // "not fail" — a page that's still warn-tier (e.g. a spinner still
          // stuck) means whatever the judge flagged is still there, not
          // flaky. Applies to every site, not tuned to any one target.
          retried = true;
          retrySignals = await collect(browser, page.url, {
            ...opts,
            screenshotPath: join(pagesDir, `${slug}.retry.png`),
          });
          const retryDecision = evaluateRules(retrySignals);
          if (retryDecision.status === "pass") {
            flaky = true;
            decision = {
              status: "warn",
              headline: `passed on retry (flaky): ${policy.headline}`,
              warnReasons: [
                "flaky — judge flagged this on the first visit, retry's deterministic signals came back fully clean",
              ],
            };
          } else {
            decision = { status: "fail", headline: policy.headline, warnReasons: [] };
          }
        } else if (decision.status !== "pass") {
          // Judge pass over a deterministic warn: the judge saw the warn-tier
          // evidence in the digest and cleared it. Status follows the judge
          // (doc 05 firewall); the deterministic concern stays in the headline.
          decision = {
            status: "pass",
            headline: `judged healthy (deterministic warns cleared: ${decision.headline})`,
            warnReasons: [],
          };
        }
      }
    }

    const visitMs = Date.now() - t0;
    return toPageResult(page, decision, signals, retrySignals, {
      retried,
      flaky,
      visitMs,
      fidelityWarnings,
      decidedBy,
      judge: judgeVerdict,
      unjudged,
      judgeError,
      judgeUsd,
      judgeMs: judge !== null && decidedBy === "judge" ? judgeMs : undefined,
    });
  }
}

/**
 * An unjudged page is yellow, never green (doc 02: budget exhaustion is always
 * visible) — a deterministic pass downgrades to warn with the reason attached.
 */
function unjudgedWarn(decision: RuleDecision, note: string): RuleDecision {
  return {
    status: "warn",
    headline: `${note}: ${decision.headline}`,
    warnReasons: [...decision.warnReasons, note],
  };
}

// ── pure helpers ───────────────────────────────────────────────────────────

function toPageResult(
  page: DiscoveredPage,
  decision: RuleDecision,
  signals: Signals,
  retrySignals: Signals | undefined,
  meta: {
    retried: boolean;
    flaky: boolean;
    visitMs: number;
    fidelityWarnings?: string[];
    decidedBy: PageResult["decidedBy"];
    judge?: JudgeVerdict;
    unjudged?: boolean;
    judgeError?: string;
    judgeUsd: number;
    judgeMs?: number;
  }
): PageResult {
  return {
    url: page.url,
    source: page.source,
    status: decision.status,
    headline: decision.headline,
    decidedBy: meta.decidedBy,
    hardRule: decision.hardRule,
    judge: meta.judge,
    unjudged: meta.unjudged || undefined,
    judgeError: meta.judgeError,
    fidelityWarnings: meta.fidelityWarnings,
    retried: meta.retried,
    flaky: meta.flaky,
    signals,
    retrySignals,
    timings: { visitMs: meta.visitMs, judgeMs: meta.judgeMs },
    cost: { judgeUsd: meta.judgeUsd, flowsUsd: 0 },
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
      missingSelectors: [],
      notFoundMarkersFound: [],
    },
    contentFields: {},
    apiMatchedCount: 0,
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
