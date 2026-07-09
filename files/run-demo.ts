import { applyHardRules } from "../src/hardRules.js";
import type { Signals } from "../src/types.js";

// Fixtures — each one mirrors a worked example from 05-judgment.md so we can
// see the doc's own examples actually decided by real code.

const fixtures: { name: string; signals: Signals }[] = [
  {
    name: "A. JS chunk 404 -> white screen (doc 05, example A)",
    signals: {
      url: "https://app.example.com/checkout",
      document: { status: 200 },
      crashed: false,
      render: { textLength: 0, screenshotLooksBlank: true },
      isDiscoveredPage: true,
    },
  },
  {
    name: "B. Payment API 500 (doc 05, example B — would need the judge; H2 doesn't fire since the DOCUMENT is 200, only the API call is 500. Flagged here as the honest 'unjudged' case)",
    signals: {
      url: "https://app.example.com/checkout",
      document: { status: 200 },
      crashed: false,
      render: { textLength: 850, screenshotLooksBlank: false },
      isDiscoveredPage: true,
    },
  },
  {
    name: "Document itself 500s (H2)",
    signals: {
      url: "https://app.example.com/api-gateway-down",
      document: { status: 502 },
      crashed: false,
      render: { textLength: 0, screenshotLooksBlank: true },
      isDiscoveredPage: true,
    },
  },
  {
    name: "DNS/navigation failure (H1)",
    signals: {
      url: "https://app.example.com/typo-domain-oops",
      document: { status: null, navigationError: "net::ERR_NAME_NOT_RESOLVED" },
      crashed: false,
      render: { textLength: 0, screenshotLooksBlank: true },
      isDiscoveredPage: true,
    },
  },
  {
    name: "404 on a sitemap-listed page (H5)",
    signals: {
      url: "https://app.example.com/products/discontinued-item",
      document: { status: 404 },
      crashed: false,
      render: { textLength: 300, screenshotLooksBlank: false },
      isDiscoveredPage: true,
    },
  },
  {
    name: "C. Marketing reworded the homepage (doc 05, example C — clean page, should pass)",
    signals: {
      url: "https://app.example.com/",
      document: { status: 200 },
      crashed: false,
      render: { textLength: 4200, screenshotLooksBlank: false },
      isDiscoveredPage: true,
    },
  },
];

console.log("Vigil Phase 1 — hard-rule engine demo\n" + "=".repeat(60));
for (const { name, signals } of fixtures) {
  const result = applyHardRules(signals);
  const badge = result.status === "fail" ? "FAIL" : result.status === "pass" ? "PASS" : result.status.toUpperCase();
  console.log(`\n${name}`);
  console.log(`  -> [${badge}]${result.hardRule ? ` (${result.hardRule})` : ""} ${result.headline}`);
}
console.log("\n" + "=".repeat(60));
