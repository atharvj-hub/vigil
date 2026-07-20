import { describe, it, expect } from "vitest";
import { buildDigest, serializeDigest } from "../../src/judge/digest.js";
import type { Signals, RequestSummary } from "../../src/types.js";

function signals(over: Partial<Signals> = {}): Signals {
  return {
    url: "https://app.example.com/",
    finalUrl: "https://app.example.com/",
    document: { status: 200, redirects: [], loadMs: 400, settledMs: 900 },
    requests: [],
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
    screenshotPath: "shot.png",
    timedOut: false,
    ...over,
  };
}

function req(over: Partial<RequestSummary> = {}): RequestSummary {
  return {
    method: "GET",
    url: "https://app.example.com/api/x",
    resourceType: "fetch",
    status: 200,
    durationMs: 50,
    firstParty: true,
    slow: false,
    afterSettle: false,
    ...over,
  };
}

describe("buildDigest", () => {
  it("itemizes only failed-or-slow requests, keeping totals for the rest", () => {
    const d = buildDigest(
      signals({
        requests: [
          req(), // healthy — counted, not itemized
          req({ url: "https://app.example.com/api/fail", status: 500 }),
          req({ url: "https://cdn.thirdparty.com/w.js", status: null, failure: "net::ERR_FAILED", firstParty: false }),
          req({ url: "https://app.example.com/api/slow", slow: true, durationMs: 8000 }),
        ],
      })
    );
    expect(d.requests.total).toBe(4);
    expect(d.requests.failed).toBe(2);
    expect(d.requests.slow).toBe(1);
    expect(d.requests.notable).toHaveLength(3);
    expect(d.requests.notable.map((r) => r.url)).not.toContain("https://app.example.com/api/x");
    // First/third-party labels come straight from Signals — never recomputed.
    expect(d.requests.notable.find((r) => r.url.includes("thirdparty"))!.firstParty).toBe(false);
  });

  it("caps every array and reports the omitted count", () => {
    const many = Array.from({ length: 40 }, (_, i) => req({ url: `https://app.example.com/api/f${i}`, status: 500 }));
    const noisyConsole = Array.from({ length: 12 }, (_, i) => ({ text: `err ${i}`, count: 1 }));
    const errors = Array.from({ length: 7 }, (_, i) => `Error: boom ${i}\n  at main.js:1`);
    const d = buildDigest(signals({ requests: many, console: noisyConsole, pageErrors: errors }));
    expect(d.requests.notable).toHaveLength(10);
    expect(d.requests.omitted).toBe(30);
    expect(d.console.entries).toHaveLength(4);
    expect(d.console.omitted).toBe(8);
    expect(d.pageErrors.entries).toHaveLength(3);
    expect(d.pageErrors.omitted).toBe(4);
  });

  it("keeps only the stack head of page errors and truncates long lines", () => {
    const d = buildDigest(signals({ pageErrors: ["TypeError: x is not a function\n  at foo.js:10\n  at bar.js:20"] }));
    expect(d.pageErrors.entries[0]).toBe("TypeError: x is not a function");
    const long = buildDigest(signals({ console: [{ text: "x".repeat(500), count: 1 }] }));
    expect(long.console.entries[0]!.text.length).toBeLessThanOrEqual(140);
  });

  it("bounds the rendered text sample", () => {
    const d = buildDigest(signals({ render: { ...signals().render, textSample: "y".repeat(3000) } }));
    expect(d.render.textSample.length).toBeLessThanOrEqual(400);
  });

  it("includes data-fidelity only when there is something to say", () => {
    expect(buildDigest(signals()).dataFidelity).toBeUndefined();
    const d = buildDigest(signals({ contentFields: { title: "Blue Kettle" }, apiMatchedCount: 1 }), {
      fidelityWarnings: ['API field "title" = "Blue Kettle", but that text was not found on the rendered page'],
    });
    expect(d.dataFidelity).toBeDefined();
    expect(d.dataFidelity!.warnings).toHaveLength(1);
  });

  it("summarizes flows to name/ok and the first failed step", () => {
    const d = buildDigest(
      signals({
        flows: [
          { name: "checkout", ok: false, steps: [{ instruction: "add to cart", ok: true, detail: "" }, { instruction: "click pay", ok: false, detail: "button missing" }] },
          { name: "search", ok: true, steps: [{ instruction: "type query", ok: true, detail: "" }] },
        ],
      })
    );
    expect(d.flows).toEqual([
      { name: "checkout", ok: false, failedStep: "click pay" },
      { name: "search", ok: true },
    ]);
  });

  it("worst-case serialized digest stays inside the token budget", () => {
    const worst = signals({
      requests: Array.from({ length: 200 }, (_, i) =>
        req({ url: `https://app.example.com/${"p".repeat(150)}/${i}`, status: 500, failure: "f".repeat(300), slow: true })
      ),
      console: Array.from({ length: 50 }, () => ({ text: "e".repeat(600), sourceUrl: "https://x.com/" + "s".repeat(300), count: 9 })),
      pageErrors: Array.from({ length: 20 }, () => "E".repeat(1000)),
      render: {
        ...signals().render,
        title: "t".repeat(500),
        h1: "h".repeat(500),
        textSample: "z".repeat(5000),
        errorMarkersFound: ["error", "failed"],
        missingSelectors: ["#a", "#b"],
        notFoundMarkersFound: ["not found"],
      },
      contentFields: { a: "v".repeat(100), b: 42 },
      apiMatchedCount: 3,
      flows: [{ name: "f", ok: false, steps: [{ instruction: "i".repeat(200), ok: false, detail: "" }] }],
    });
    const json = serializeDigest(buildDigest(worst, { fidelityWarnings: ["w".repeat(200)] }));
    // ~4 chars/token → ≤ 8000 chars keeps the digest under ~2000 tokens even worst-case.
    expect(json.length).toBeLessThanOrEqual(8000);
  });

  it("is deterministic — same signals, same digest", () => {
    const s = signals({ requests: [req({ status: 500 })], console: [{ text: "boom", count: 2 }] });
    expect(serializeDigest(buildDigest(s))).toBe(serializeDigest(buildDigest(s)));
  });
});
