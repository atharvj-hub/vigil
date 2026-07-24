import { describe, it, expect } from "vitest";
import { buildSummary, fmtDuration, pathOf, hostOf, judgeErrorReason } from "../../src/reporter/index.js";
import { renderHtml } from "../../src/reporter/html.js";
import type { RunResult, PageResult } from "../../src/types.js";

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
      crossOriginDropped: 0,
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
    captureTimeline: [],
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
            renderAssessment: {
              loadingIndicatorVisible: false,
              meaningfulContentRendered: true,
              pageStillLoading: false,
              visualEvidence: "checkout form rendered; a red error toast overlays it",
            },
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
            renderAssessment: {
              loadingIndicatorVisible: false,
              meaningfulContentRendered: true,
              pageStillLoading: false,
              visualEvidence: "checkout form rendered; a red error toast overlays it",
            },
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

  it("renders the render-assessment checklist inside the judge card, flagging concerning answers", async () => {
    const r = result({
      pages: [
        {
          url: "https://app.example.com/stuck",
          source: "sitemap",
          status: "fail",
          headline: "judge: stuck on a loading spinner",
          decidedBy: "judge",
          judge: {
            renderAssessment: {
              loadingIndicatorVisible: true,
              meaningfulContentRendered: false,
              pageStillLoading: true,
              visualEvidence: "black screen, one spinner mid-animation, textSample is a placeholder string",
            },
            status: "fail",
            confidence: 0.95,
            reasons: [{ kind: "visual", summary: "stuck on a loading spinner", evidence: "black screen with spinner" }],
          },
          retried: false,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1, judgeMs: 100 },
          cost: { judgeUsd: 0.004, flowsUsd: 0 },
        },
      ],
    });

    const html = await renderHtml(r);
    expect(html).toContain("Render assessment");
    expect(html).toContain("black screen, one spinner mid-animation");
    // All three checklist answers are concerning here (spinner visible, no
    // content rendered, still loading), so all three must render with the
    // visual flag class — this is what makes a bad verdict catchable by eye
    // without vigil's code interfering with the verdict itself.
    const flagCount = (html.match(/ra-value ra-flag/g) ?? []).length;
    expect(flagCount).toBe(3);
  });

  it("flags nothing when the render assessment is entirely healthy", async () => {
    const r = result({
      pages: [
        {
          url: "https://app.example.com/faq",
          source: "sitemap",
          status: "pass",
          headline: "clean",
          decidedBy: "judge",
          judge: {
            renderAssessment: {
              loadingIndicatorVisible: false,
              meaningfulContentRendered: true,
              pageStillLoading: false,
              visualEvidence: "FAQ content fully rendered, no spinners",
            },
            status: "pass",
            confidence: 1,
            reasons: [],
          },
          retried: false,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1, judgeMs: 100 },
          cost: { judgeUsd: 0.004, flowsUsd: 0 },
        },
      ],
    });
    const html = await renderHtml(r);
    // Every page — pass included — is its own expandable row carrying the
    // judge card (only the screenshot is pass-gated), so this asserts
    // directly on the flag count with no status-dependent caveat.
    expect((html.match(/ra-value ra-flag/g) ?? []).length).toBe(0);
  });

  it("omits the render-assessment block gracefully when absent (old report replays)", async () => {
    const r = result({
      pages: [
        {
          url: "https://app.example.com/checkout",
          source: "sitemap",
          status: "fail",
          headline: "POST /api/payment → 500",
          decidedBy: "hard-rule",
          hardRule: "H2",
          retried: true,
          flaky: false,
          signals: emptySignals(),
          timings: { visitMs: 1 },
          cost: { judgeUsd: 0, flowsUsd: 0 },
        },
      ],
    });
    const html = await renderHtml(r);
    expect(html).not.toContain("Render assessment");
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

describe("judgeErrorReason", () => {
  // This is the single source of truth every caller must use to surface why
  // a judge call failed (p.headline never carries it — see the comment at
  // its definition). Both `vigil run`'s summary and `vigil check`'s single-
  // page output go through this; a caller that reimplements the condition by
  // hand is exactly how the `check` command silently dropped the reason.
  const base = (over: Partial<PageResult>): PageResult => ({
    url: "https://app.example.com/x",
    source: "sitemap",
    status: "warn",
    headline: "unjudged — judge error: clean",
    decidedBy: "error",
    retried: false,
    flaky: false,
    signals: emptySignals(),
    timings: { visitMs: 1 },
    cost: { judgeUsd: 0, flowsUsd: 0 },
    ...over,
  });

  it("returns the reason when decidedBy is error and judgeError is set", () => {
    expect(judgeErrorReason(base({ judgeError: "provider unavailable" }))).toBe("provider unavailable");
  });

  it("returns undefined when decidedBy is not error, even with judgeError set", () => {
    expect(judgeErrorReason(base({ decidedBy: "judge", judgeError: "provider unavailable" }))).toBeUndefined();
  });

  it("returns undefined when judgeError is absent", () => {
    expect(judgeErrorReason(base({ judgeError: undefined }))).toBeUndefined();
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
