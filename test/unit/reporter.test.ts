import { describe, it, expect } from "vitest";
import { buildSummary, fmtDuration, pathOf, hostOf } from "../../src/reporter/index.js";
import { renderHtml } from "../../src/reporter/html.js";
import type { RunResult } from "../../src/types.js";

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    runId: "2026-07-09T06-00-00_abcd",
    verdict: "BROKEN",
    target: { url: "https://app.example.com", deployRef: "4f9c21b" },
    startedAt: "2026-07-09T06:00:00.000Z",
    durationMs: 161_000,
    counts: { pass: 39, warn: 2, fail: 1, skipped: 0 },
    cost: { modelCalls: 0, modelUsd: 0 },
    budgetsExhausted: [],
    pages: [
      { url: "https://app.example.com/checkout", source: "sitemap", status: "fail", headline: "POST /api/payment → 500", decidedBy: "hard-rule", hardRule: "H2", retried: true, flaky: false, signals: emptySignals(), timings: { visitMs: 1 }, cost: { judgeUsd: 0, flowsUsd: 0 } },
      { url: "https://app.example.com/account", source: "crawl", status: "warn", headline: "console error from a widget", decidedBy: "hard-rule", retried: false, flaky: false, signals: emptySignals(), timings: { visitMs: 1 }, cost: { judgeUsd: 0, flowsUsd: 0 } },
      { url: "https://app.example.com/", source: "config", status: "pass", headline: "clean", decidedBy: "hard-rule", retried: false, flaky: false, signals: emptySignals(), timings: { visitMs: 1 }, cost: { judgeUsd: 0, flowsUsd: 0 } },
    ],
    coverage: {
      config: 1,
      sitemap: { sitemapsFetched: 1, urlsDeclared: 2 },
      crawl: { urlsFound: 1 },
      api: { graphqlEndpoint: null, openapiEndpoint: null, candidatesGenerated: 0, candidatesConfirmed: 0 },
      duplicatesDropped: 0,
      samplingDropped: 0,
      capDropped: 0,
    },
    artifactsDir: "vigil-report/2026-07-09T06-00-00_abcd",
    ...over,
  };
}

function emptySignals(): any {
  return {
    url: "https://app.example.com",
    finalUrl: "https://app.example.com",
    document: { status: 200, redirects: [], loadMs: 100, settledMs: 200 },
    requests: [],
    console: [],
    pageErrors: [],
    crashed: false,
    render: { textLength: 500, title: "App", h1: "Home", textSample: "", errorMarkersFound: [], spinnerStuck: false, screenshotLooksBlank: false, missingSelectors: [], notFoundMarkersFound: [] },
    contentFields: {},
    apiMatchedCount: 0,
    flows: [],
    screenshotPath: "",
    timedOut: false,
  };
}

describe("buildSummary", () => {
  it("headlines the verdict, host, deploy, and counts", () => {
    const s = buildSummary(result());
    expect(s).toContain("vigil · BROKEN · app.example.com · deploy 4f9c21b");
    expect(s).toContain("1 failed · 39 passed · 2 warned");
  });
  it("lists fails before warns, each with its path and headline", () => {
    const s = buildSummary(result());
    const failIdx = s.indexOf("/checkout");
    const warnIdx = s.indexOf("/account");
    expect(failIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(failIdx);
    expect(s).toMatch(/❌ \*\*\/checkout\*\*/);
    expect(s).toMatch(/⚠️ \*\*\/account\*\*/);
  });
  it("notes exhausted budgets when present", () => {
    expect(buildSummary(result({ budgetsExhausted: ["maxModelCostUsd"] }))).toContain("budgets exhausted: maxModelCostUsd");
  });
  it("appends judge confidence and formats unjudged budget and error lines", () => {
    const r = result({
      pages: [
        {
          url: "https://app.example.com/checkout",
          source: "sitemap",
          status: "fail",
          headline: "error toast visible",
          decidedBy: "judge",
          judge: {
            status: "fail",
            confidence: 0.97,
            reasons: [{ kind: "visual", summary: "error toast visible", evidence: "toast banner" }],
          },
          retried: true,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1, judgeMs: 100 },
          cost: { judgeUsd: 0.004, flowsUsd: 0 },
        },
        {
          url: "https://app.example.com/budget-page",
          source: "crawl",
          status: "warn",
          headline: "unjudged — model budget exhausted: clean",
          decidedBy: "budget",
          unjudged: true,
          retried: false,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1 },
          cost: { judgeUsd: 0, flowsUsd: 0 },
        },
        {
          url: "https://app.example.com/error-page",
          source: "crawl",
          status: "warn",
          headline: "unjudged — judge error: clean",
          decidedBy: "error",
          unjudged: true,
          judgeError: "provider unavailable",
          retried: false,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1 },
          cost: { judgeUsd: 0, flowsUsd: 0 },
        },
      ],
    });
    const s = buildSummary(r);
    expect(s).toContain("❌ **/checkout** — error toast visible (judge 0.97)");
    expect(s).toContain("⚠️ **/budget-page** — unjudged — model budget exhausted: clean");
    expect(s).toContain("⚠️ **/error-page** — unjudged — judge error: clean — reason: provider unavailable");
  });
});

describe("renderHtml", () => {
  it("renders decidedBy badges, judged/unjudged meta counts, judge card and unjudged notes", async () => {
    const r = result({
      pages: [
        {
          url: "https://app.example.com/checkout",
          source: "sitemap",
          status: "fail",
          headline: "error toast visible",
          decidedBy: "judge",
          judge: {
            status: "fail",
            confidence: 0.97,
            reasons: [{ kind: "visual", summary: "error toast visible", evidence: "toast banner visible" }],
          },
          retried: true,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1, judgeMs: 100 },
          cost: { judgeUsd: 0.004, flowsUsd: 0 },
        },
        {
          url: "https://app.example.com/budget-page",
          source: "crawl",
          status: "warn",
          headline: "unjudged — model budget exhausted: clean",
          decidedBy: "budget",
          unjudged: true,
          retried: false,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1 },
          cost: { judgeUsd: 0, flowsUsd: 0 },
        },
        {
          url: "https://app.example.com/error-page",
          source: "crawl",
          status: "warn",
          headline: "unjudged — judge error: clean",
          decidedBy: "error",
          unjudged: true,
          judgeError: "provider unavailable",
          retried: false,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1 },
          cost: { judgeUsd: 0, flowsUsd: 0 },
        },
      ],
    });

    const html = await renderHtml(r);
    expect(html).toContain('<span class="tag">judge</span>');
    expect(html).toContain('<span class="tag">budget</span>');
    expect(html).toContain('<span class="tag">error</span>');
    expect(html).toContain("Judged 1 · unjudged 2");
    expect(html).toContain("Judge verdict");
    expect(html).toContain("Confidence 0.97");
    expect(html).toContain("toast banner visible");
    expect(html).toContain("Unjudged — model budget exhausted");
    expect(html).toContain("Unjudged — judge error: provider unavailable");
  });

  it("renders a status filter with per-status counts, and tags every row/detail so it can filter", async () => {
    const html = await renderHtml(result());
    expect(html).toContain('data-filter="all">All <b>3</b>');
    expect(html).toContain('data-filter="fail"');
    expect(html).toContain('data-filter="warn"');
    expect(html).toContain('data-filter="pass"');
    // Every row carries the status the filter keys off — without this the
    // buttons render but filter nothing.
    expect(html).toContain('data-status="fail"');
    expect(html).toContain('data-status="warn"');
    expect(html).toContain('data-status="pass"');
  });

  it("omits filter buttons for statuses no page has (a filter that shows nothing is noise)", async () => {
    const html = await renderHtml(result());
    expect(html).not.toContain('data-filter="skipped"');
  });

  it("buckets settle timing into fast / moderate / slow", async () => {
    const slow = (ms: number) => {
      const s = emptySignals();
      s.document.settledMs = ms;
      return s;
    };
    const page = (path: string, settledMs: number) => ({
      url: `https://app.example.com${path}`,
      source: "sitemap" as const,
      status: "pass" as const,
      headline: "clean",
      decidedBy: "hard-rule" as const,
      retried: false,
      flaky: false,
      signals: slow(settledMs),
      timings: { visitMs: 1 },
      cost: { judgeUsd: 0, flowsUsd: 0 },
    });
    const html = await renderHtml(
      result({ pages: [page("/quick", 900), page("/mid", 3200), page("/crawling", 7400)] })
    );
    expect(html).toContain("Settle timing");
    expect(html).toContain("under 2s");
    expect(html).toContain("2–5s");
    expect(html).toContain("over 5s");
    expect(html).toContain("900ms");
    expect(html).toContain("3200ms");
    expect(html).toContain("7400ms");
  });

  it("notes pages that never produced a document rather than silently dropping them", async () => {
    const noDoc = emptySignals();
    noDoc.document.settledMs = null;
    const html = await renderHtml(
      result({
        pages: [
          {
            url: "https://app.example.com/dead",
            source: "sitemap",
            status: "fail",
            headline: "navigation failed",
            decidedBy: "hard-rule",
            hardRule: "H1",
            retried: true,
            flaky: false,
            signals: noDoc,
            timings: { visitMs: 1 },
            cost: { judgeUsd: 0, flowsUsd: 0 },
          },
        ],
      })
    );
    expect(html).toContain("never produced a document");
  });
});

describe("formatting helpers", () => {
  it("fmtDuration renders seconds and minutes", () => {
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(161_000)).toBe("2m 41s");
  });
  it("pathOf returns path + query, hostOf returns the host", () => {
    expect(pathOf("https://a.com/x/y?z=1")).toBe("/x/y?z=1");
    expect(hostOf("https://a.com:8080/x")).toBe("a.com:8080");
  });
});
