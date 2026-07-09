import { describe, it, expect } from "vitest";
import {
  normalizeUrl,
  isSameOrigin,
  globToRegExp,
  passesGlobs,
  collapseParametric,
  dedupeByUrl,
} from "../../src/discovery/normalize.js";
import type { DiscoveredPage } from "../../src/types.js";

describe("normalizeUrl", () => {
  it("strips fragments and tracking params, sorts query keys", () => {
    expect(normalizeUrl("https://a.com/p?utm_source=x&b=2&a=1#frag")).toBe("https://a.com/p?a=1&b=2");
  });
  it("drops trailing slash on non-root paths but keeps root", () => {
    expect(normalizeUrl("https://a.com/foo/")).toBe("https://a.com/foo");
    expect(normalizeUrl("https://a.com/")).toBe("https://a.com/");
  });
  it("resolves relative URLs against a base", () => {
    expect(normalizeUrl("/x", "https://a.com/y")).toBe("https://a.com/x");
  });
  it("rejects non-http(s) and junk", () => {
    expect(normalizeUrl("mailto:x@y.com")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("isSameOrigin", () => {
  const origin = "https://a.com";
  it("matches exact host, rejects other hosts and subdomains by default", () => {
    expect(isSameOrigin("https://a.com/x", origin, false)).toBe(true);
    expect(isSameOrigin("https://b.com/x", origin, false)).toBe(false);
    expect(isSameOrigin("https://sub.a.com/x", origin, false)).toBe(false);
  });
  it("allows subdomains when opted in", () => {
    expect(isSameOrigin("https://sub.a.com/x", origin, true)).toBe(true);
  });
});

describe("globToRegExp / passesGlobs", () => {
  it("** matches across slashes, including the parent path", () => {
    expect(globToRegExp("/admin/**").test("/admin")).toBe(true);
    expect(globToRegExp("/admin/**").test("/admin/users/1")).toBe(true);
    expect(globToRegExp("/admin/**").test("/adminx")).toBe(false);
  });
  it("* does not cross slashes", () => {
    expect(globToRegExp("/p/*").test("/p/1")).toBe(true);
    expect(globToRegExp("/p/*").test("/p/1/2")).toBe(false);
  });
  it("include + exclude compose", () => {
    expect(passesGlobs("/admin/x", ["/**"], ["/admin/**"])).toBe(false);
    expect(passesGlobs("/shop/x", ["/**"], ["/admin/**"])).toBe(true);
    expect(passesGlobs("/x", ["/shop/**"], [])).toBe(false);
  });
});

describe("collapseParametric", () => {
  const mk = (url: string): DiscoveredPage => ({ url, source: "sitemap" });
  it("collapses a numeric family to samplesPerPattern, tagging patternGroup", () => {
    const pages = Array.from({ length: 50 }, (_, i) => mk(`https://a.com/products/${i + 1}`));
    const out = collapseParametric(pages, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.patternGroup).toBe("/products/:n");
  });
  it("collapses UUID and long-slug families too", () => {
    const uuids = Array.from({ length: 5 }, (_, i) =>
      mk(`https://a.com/u/0000000${i}-0000-0000-0000-000000000000`)
    );
    expect(collapseParametric(uuids, 2)).toHaveLength(2);
  });
  it("leaves small families and non-parametric paths untouched", () => {
    const pages = [mk("https://a.com/about"), mk("https://a.com/pricing"), mk("https://a.com/products/1")];
    const out = collapseParametric(pages, 2);
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.patternGroup === undefined)).toBe(true);
  });
  it("does not merge different query-key shapes", () => {
    const pages = [
      mk("https://a.com/p/1"),
      mk("https://a.com/p/2"),
      mk("https://a.com/p/3?edit=1"),
      mk("https://a.com/p/4?edit=1"),
      mk("https://a.com/p/5?edit=1"),
    ];
    // /p/:n (3 → 2) + /p/:n?edit (3 → 2) = 4
    expect(collapseParametric(pages, 2)).toHaveLength(4);
  });
});

describe("dedupeByUrl", () => {
  it("keeps the first occurrence (highest priority) and its source", () => {
    const pages: DiscoveredPage[] = [
      { url: "https://a.com/x", source: "config" },
      { url: "https://a.com/x", source: "sitemap" },
    ];
    const out = dedupeByUrl(pages);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("config");
  });
});
