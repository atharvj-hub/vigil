import { describe, it, expect } from "vitest";
import { assemblePageSet } from "../../src/discovery/index.js";
import { resolveConfig, type VigilConfig } from "../../src/config.js";

const cfg = (over: Partial<VigilConfig> = {}) => resolveConfig({ url: "https://a.com", ...over });

describe("assemblePageSet — merging the three sources", () => {
  it("always puts the target first as a config route", () => {
    const set = assemblePageSet(cfg(), [], []);
    expect(set.pages[0]).toEqual({ url: "https://a.com/", source: "config" });
  });

  it("keeps explicit config routes, first and authoritative", () => {
    const set = assemblePageSet(cfg({ discovery: { routes: ["/checkout"] } }), [], []);
    const cfgPages = set.pages.filter((p) => p.source === "config").map((p) => p.url);
    expect(cfgPages).toContain("https://a.com/checkout");
  });

  it("merges crawl + sitemap, with crawl winning a dedupe tie", () => {
    const set = assemblePageSet(cfg(), ["https://a.com/about"], ["https://a.com/about", "https://a.com/pricing"]);
    const about = set.pages.find((p) => p.url === "https://a.com/about");
    expect(about?.source).toBe("crawl");
    expect(set.pages.map((p) => p.url)).toContain("https://a.com/pricing");
  });

  it("applies exclude globs to discovered pages", () => {
    const set = assemblePageSet(cfg({ discovery: { exclude: ["/admin/**"] } }), ["https://a.com/admin/users"], []);
    expect(set.pages.map((p) => p.url)).not.toContain("https://a.com/admin/users");
  });

  it("drops off-origin URLs and counts them so the gap is visible", () => {
    const set = assemblePageSet(cfg(), ["https://evil.com/x"], ["https://a.com/ok"]);
    expect(set.pages.map((p) => p.url)).toEqual(expect.arrayContaining(["https://a.com/ok"]));
    expect(set.pages.map((p) => p.url)).not.toContain("https://evil.com/x");
    expect(set.coverage.crossOriginDropped).toBe(1);
  });

  it("does not drop www vs apex as cross-origin (the qplus.tv case)", () => {
    const set = assemblePageSet(cfg(), [], ["https://www.a.com/pricing"]);
    expect(set.pages.map((p) => p.url)).toContain("https://www.a.com/pricing");
    expect(set.coverage.crossOriginDropped).toBe(0);
  });

  it("collapses a parametric family from the sitemap", () => {
    const sitemap = Array.from({ length: 20 }, (_, i) => `https://a.com/products/${i + 1}`);
    const set = assemblePageSet(cfg(), [], sitemap);
    const products = set.pages.filter((p) => p.patternGroup === "/products/:n");
    expect(products).toHaveLength(2);
  });

  it("caps at maxPages and marks truncated (config routes still all kept)", () => {
    const sitemap = Array.from({ length: 10 }, (_, i) => `https://a.com/page-${i}`);
    const set = assemblePageSet(cfg({ budgets: { maxPages: 4 } }), [], sitemap);
    expect(set.pages).toHaveLength(4); // target(config) + 3 sitemap
    expect(set.truncated).toBe(true);
  });
});
