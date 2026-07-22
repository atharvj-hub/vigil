import { describe, it, expect } from "vitest";
import { evaluateRules } from "../../src/judge/hardRules.js";
import type { Signals } from "../../src/types.js";

// A clean baseline; each test overrides only what it needs.
function signals(over: Partial<Signals> = {}): Signals {
  return {
    url: "https://app.example.com/",
    finalUrl: "https://app.example.com/",
    document: { status: 200, redirects: [], loadMs: 400, settledMs: 900 },
    requests: [],
    captureTimeline: [],
    console: [],
    pageErrors: [],
    crashed: false,
    render: {
      textLength: 1200,
      title: "Home",
      h1: "Welcome",
      textSample: "Welcome to the shop",
      errorMarkersFound: [],
      spinnerStuck: false,
      screenshotLooksBlank: false,
      missingSelectors: [],
      notFoundMarkersFound: [],
    },
    contentFields: {},
    apiMatchedCount: 0,
    flows: [],
    screenshotPath: "",
    timedOut: false,
    ...over,
  };
}
const doc = (status: number | null, extra: Partial<Signals["document"]> = {}): Signals["document"] => ({
  status,
  redirects: [],
  loadMs: 100,
  settledMs: 100,
  ...extra,
});
const blank: Signals["render"] = {
  textLength: 0,
  title: "",
  h1: null,
  textSample: "",
  errorMarkersFound: [],
  spinnerStuck: false,
  screenshotLooksBlank: true,
  missingSelectors: [],
  notFoundMarkersFound: [],
};

describe("hard rules (fail)", () => {
  it("H1 — navigation failed (null status)", () => {
    const d = evaluateRules(signals({ document: doc(null, { navigationError: "net::ERR_NAME_NOT_RESOLVED" }) }));
    expect(d.status).toBe("fail");
    expect(d.hardRule).toBe("H1");
  });
  it("H2 — document 5xx", () => {
    expect(evaluateRules(signals({ document: doc(502) })).hardRule).toBe("H2");
  });
  it("H3 — crash", () => {
    expect(evaluateRules(signals({ crashed: true })).hardRule).toBe("H3");
  });
  it("H4 — blank render on a 200 (the chunk-404 symptom)", () => {
    expect(evaluateRules(signals({ render: blank })).hardRule).toBe("H4");
  });
  it("H5 — 404 on a discovered page", () => {
    expect(evaluateRules(signals({ document: doc(404) })).hardRule).toBe("H5");
  });
  it("hard-fail order: 5xx wins over blank render", () => {
    expect(evaluateRules(signals({ document: doc(503), render: blank })).hardRule).toBe("H2");
  });
});

describe("deterministic warn tier (never fail)", () => {
  it("first-party API 500 → warn (a judged fail only in Phase 2)", () => {
    const d = evaluateRules(signals({
      requests: [{ method: "POST", url: "https://app.example.com/api/payment/intent", resourceType: "fetch", status: 500, durationMs: 120, firstParty: true, slow: false, afterSettle: false }],
    }));
    expect(d.status).toBe("warn");
    expect(d.warnReasons[0]).toMatch(/first-party/);
  });
  it("third-party failure is observe-only → still pass", () => {
    const d = evaluateRules(signals({
      requests: [{ method: "GET", url: "https://analytics.thirdparty.com/x", resourceType: "script", status: 404, durationMs: 50, firstParty: false, slow: false, afterSettle: false }],
    }));
    expect(d.status).toBe("pass");
  });
  it("console errors → warn", () => {
    expect(evaluateRules(signals({ console: [{ text: "TypeError: x is undefined", count: 3 }] })).status).toBe("warn");
  });
  it("uncaught page error → warn", () => {
    expect(evaluateRules(signals({ pageErrors: ["ReferenceError: foo is not defined"] })).status).toBe("warn");
  });
  it("error marker in text → warn", () => {
    expect(evaluateRules(signals({ render: { ...signals().render, errorMarkersFound: ["something went wrong"] } })).status).toBe("warn");
  });
  it("stuck spinner → warn", () => {
    expect(evaluateRules(signals({ render: { ...signals().render, spinnerStuck: true } })).status).toBe("warn");
  });
  it("slow load (timedOut) → warn, not a hard fail", () => {
    const d = evaluateRules(signals({ timedOut: true }));
    expect(d.status).toBe("warn");
    expect(d.hardRule).toBeUndefined();
  });
  it("missing required selector → warn (silent component that failed to mount)", () => {
    const d = evaluateRules(signals({ render: { ...signals().render, missingSelectors: [".widget-related"] } }));
    expect(d.status).toBe("warn");
    expect(d.warnReasons[0]).toMatch(/\.widget-related/);
  });
  it("not-found marker on a 200 → warn (SPA soft-404)", () => {
    const d = evaluateRules(signals({ render: { ...signals().render, notFoundMarkersFound: ["couldn't find that product"] } }));
    expect(d.status).toBe("warn");
    expect(d.warnReasons[0]).toMatch(/soft-404/);
  });
});

describe("pass", () => {
  it("clean signals → pass (reworded homepage, no baseline to cry wolf)", () => {
    const d = evaluateRules(signals());
    expect(d.status).toBe("pass");
    expect(d.warnReasons).toHaveLength(0);
  });
  it("an after-settle first-party failure does not warn (late, not load-blocking)", () => {
    const d = evaluateRules(signals({
      requests: [{ method: "GET", url: "https://app.example.com/api/late", resourceType: "fetch", status: 500, durationMs: 50, firstParty: true, slow: false, afterSettle: true }],
    }));
    expect(d.status).toBe("pass");
  });
});
