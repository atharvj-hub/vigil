// Discovery — merges the three sources into the Page Set (documentation/03).
// Priority: config routes → shallow crawl (breadth order) → sitemap order.
// Config routes are authoritative: always kept, first, bypassing globs and the cap.
//
// The network/browser I/O (`discover`) is kept separate from the pure assembly
// logic (`assemblePageSet`) so the merge/normalize/collapse/cap rules can be
// unit-tested without a live target.

import type { Browser } from "playwright";
import type { DiscoveredPage, PageSet } from "../types.js";
import type { ResolvedConfig } from "../config.js";
import { discoverFromSitemap } from "./sitemap.js";
import { crawl } from "./crawler.js";
import {
  normalizeUrl,
  isSameOrigin,
  passesGlobs,
  pathOf,
  dedupeByUrl,
  collapseParametric,
} from "./normalize.js";

/** Full discovery: run the three sources against a live target, then assemble. */
export async function discover(config: ResolvedConfig, browser?: Browser): Promise<PageSet> {
  const target = normalizeUrl(config.url!);
  if (!target) throw new Error(`Invalid target URL: ${config.url}`);
  const origin = new URL(target).origin;
  const { discovery } = config;

  let crawlUrls: string[] = [];
  if (discovery.crawl.enabled && discovery.crawl.maxPages > 0 && browser) {
    crawlUrls = await crawl(browser, target, {
      depth: discovery.crawl.depth,
      maxPages: discovery.crawl.maxPages,
      politenessMs: discovery.crawl.politenessMs,
      allowSubdomains: discovery.allowSubdomains,
      include: discovery.include,
      exclude: discovery.exclude,
    });
  }

  const sitemapUrls = discovery.sitemap ? await discoverFromSitemap(origin) : [];

  return assemblePageSet(config, crawlUrls, sitemapUrls);
}

/**
 * Pure assembly: given the raw URL lists from each source, produce the Page Set.
 * No I/O — deterministic and unit-testable. `crawlUrls` is expected in breadth
 * order; `sitemapUrls` in sitemap order.
 */
export function assemblePageSet(
  config: ResolvedConfig,
  crawlUrls: string[],
  sitemapUrls: string[]
): PageSet {
  const target = normalizeUrl(config.url!);
  if (!target) throw new Error(`Invalid target URL: ${config.url}`);
  const origin = new URL(target).origin;
  const { discovery } = config;

  // ── Source 1: config routes (authoritative). Target URL is an implicit route. ──
  const configUrls = [config.url!, ...discovery.routes]
    .map((r) => normalizeUrl(r, origin))
    .filter((u): u is string => !!u);
  const configPages = dedupeByUrl(configUrls.map((url) => ({ url, source: "config" as const })));
  const configSet = new Set(configPages.map((p) => p.url));

  // ── Sources 2 & 3: normalize + same-origin + glob filter; config wins ties. ──
  const discoveredPages: DiscoveredPage[] = [];
  const pushDiscovered = (raw: string, source: "crawl" | "sitemap") => {
    const url = normalizeUrl(raw, origin);
    if (!url) return;
    if (!isSameOrigin(url, origin, discovery.allowSubdomains)) return;
    if (!passesGlobs(pathOf(url), discovery.include, discovery.exclude)) return;
    if (configSet.has(url)) return;
    discoveredPages.push({ url, source });
  };
  for (const u of crawlUrls) pushDiscovered(u, "crawl");
  for (const u of sitemapUrls) pushDiscovered(u, "sitemap");

  // Dedupe (crawl before sitemap → crawl wins), then collapse parametric families.
  const deduped = dedupeByUrl(discoveredPages);
  const collapsed = collapseParametric(deduped, discovery.samplesPerPattern);

  // Cap: config routes always kept; fill the remaining budget with the rest.
  const remaining = Math.max(0, config.budgets.maxPages - configPages.length);
  const kept = collapsed.slice(0, remaining);

  return {
    pages: [...configPages, ...kept],
    generatedAt: new Date().toISOString(),
    truncated: collapsed.length > remaining,
  };
}
