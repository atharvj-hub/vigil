import { describe, it, expect } from "vitest";
import { resolveConfig } from "../../src/config.js";

describe("resolveConfig", () => {
  it("requires a target URL", () => {
    expect(() => resolveConfig({})).toThrow(/No target URL/);
  });
  it("rejects a malformed URL", () => {
    expect(() => resolveConfig({ url: "not-a-url" })).toThrow(/Invalid vigil config/);
  });
  it("applies sensible defaults", () => {
    const c = resolveConfig({ url: "https://a.com" });
    expect(c.budgets.maxPages).toBe(150);
    expect(c.budgets.concurrency).toBe(5);
    expect(c.budgets.maxRunMinutes).toBe(10);
    expect(c.discovery.sitemap).toBe(true);
    expect(c.discovery.crawl.depth).toBe(2);
    expect(c.checks.viewport).toEqual({ width: 1280, height: 720 });
    expect(c.checks.browser).toBe("chromium");
    expect(c.report.failOn).toBe("broken");
    expect(c.report.keepRuns).toBe(10);
  });
  it("lets an explicit url argument override the config", () => {
    const c = resolveConfig({ url: "https://a.com" }, "https://b.com");
    expect(c.url).toBe("https://b.com");
  });
  it("rejects out-of-range budgets", () => {
    expect(() => resolveConfig({ url: "https://a.com", budgets: { concurrency: 0 } })).toThrow(/Invalid vigil config/);
  });
  it("passes user overrides through", () => {
    const c = resolveConfig({ url: "https://a.com", discovery: { routes: ["/checkout"], sitemap: false } });
    expect(c.discovery.routes).toEqual(["/checkout"]);
    expect(c.discovery.sitemap).toBe(false);
  });
});
