import { describe, it, expect } from "vitest";
import { evaluateDataFidelity } from "../../src/judge/dataFidelity.js";
import { resolveConfig } from "../../src/config.js";
import type { Signals } from "../../src/types.js";

const baseSignals = (over: Partial<Signals> = {}): Signals => ({
  url: "https://app.example.com/movies/a-common-man",
  finalUrl: "https://app.example.com/movies/a-common-man",
  document: { status: 200, redirects: [], loadMs: 400, settledMs: 900 },
  requests: [],
  captureTimeline: [],
  console: [],
  pageErrors: [],
  crashed: false,
  render: {
    textLength: 500,
    title: "A Common Man",
    h1: "A Common Man",
    textSample: "A Common Man — a gripping thriller. Rated 4.5 stars.",
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
});

const dataFidelityConfig = (over: { enabled?: boolean; fields?: string[] } = {}) =>
  resolveConfig({
    url: "https://app.example.com",
    checks: { dataFidelity: { enabled: over.enabled ?? true, apiPathPatterns: [], fields: over.fields ?? ["title"] } },
  }).checks.dataFidelity;

describe("evaluateDataFidelity", () => {
  it("is a no-op when disabled, even with matching fields and a real mismatch", () => {
    const signals = baseSignals({ contentFields: { title: "Totally Different Title" } });
    const result = evaluateDataFidelity(signals, dataFidelityConfig({ enabled: false }));
    expect(result.warnReasons).toEqual([]);
  });

  it("is a no-op when no fields are configured", () => {
    const signals = baseSignals({ contentFields: { title: "Totally Different Title" } });
    const result = evaluateDataFidelity(signals, dataFidelityConfig({ fields: [] }));
    expect(result.warnReasons).toEqual([]);
  });

  it("is a no-op when no matching API response was seen this visit (field never captured)", () => {
    const signals = baseSignals({ contentFields: {}, apiMatchedCount: 0 });
    const result = evaluateDataFidelity(signals, dataFidelityConfig());
    expect(result.warnReasons).toEqual([]);
  });

  it("flags a possible backend rename when a matching API response was seen but the field never appeared in it", () => {
    const signals = baseSignals({ contentFields: {}, apiMatchedCount: 1 });
    const result = evaluateDataFidelity(signals, dataFidelityConfig());
    expect(result.warnReasons).toHaveLength(1);
    expect(result.warnReasons[0]).toContain("title");
    expect(result.warnReasons[0]).toMatch(/rename|removed field/);
  });

  it("passes when the API value appears in the rendered text, case/whitespace-insensitive", () => {
    const signals = baseSignals({ contentFields: { title: "a common man" } }); // different case than render
    const result = evaluateDataFidelity(signals, dataFidelityConfig());
    expect(result.warnReasons).toEqual([]);
  });

  it("flags a mismatch when the API value never appears in the rendered text", () => {
    const signals = baseSignals({ contentFields: { title: "The Wrong Movie Entirely" } });
    const result = evaluateDataFidelity(signals, dataFidelityConfig());
    expect(result.warnReasons).toHaveLength(1);
    expect(result.warnReasons[0]).toContain("title");
    expect(result.warnReasons[0]).toContain("The Wrong Movie Entirely");
  });

  it("checks multiple configured fields independently", () => {
    const signals = baseSignals({
      render: { ...baseSignals().render, textSample: "A Common Man — Rated 4.5 stars." },
      contentFields: { title: "A Common Man", tagline: "A gripping thriller you must see" },
    });
    const result = evaluateDataFidelity(signals, dataFidelityConfig({ fields: ["title", "tagline"] }));
    expect(result.warnReasons).toHaveLength(1); // title matches, tagline doesn't
    expect(result.warnReasons[0]).toContain("tagline");
  });

  it("skips a field whose captured value is an empty string", () => {
    const signals = baseSignals({ contentFields: { title: "" } });
    const result = evaluateDataFidelity(signals, dataFidelityConfig());
    expect(result.warnReasons).toEqual([]);
  });
});
