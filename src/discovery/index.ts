// Discovery — merges the four sources into the Page Set (documentation/03).
// Priority: config routes → crawl (breadth order) → sitemap order → schema-
// probed candidates (confirmed only). Config routes are authoritative: always
// kept, first, bypassing globs and the cap.
//
// The network/browser I/O (`discover`) is kept separate from the pure assembly
// logic (`assemblePageSet`) so the merge/normalize/collapse/cap rules can be
// unit-tested without a live target.

import type { Browser } from "playwright";
import type { DiscoveredPage, DiscoveryCoverage, PageSet } from "../types.js";
import type { ResolvedConfig } from "../config.js";
import { discoverFromSitemap } from "./sitemap.js";
import { crawl } from "./crawler.js";
import { discoverViaSchema } from "./schemaProbe.js";
import {
  normalizeUrl,
  isSameOrigin,
  passesGlobs,
  pathOf,
  dedupeByUrl,
  collapseParametric,
} from "./normalize.js";

/** Full discovery: run the four sources against a live target, then assemble. */
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

  const sitemapResult = discovery.sitemap
    ? await discoverFromSitemap(origin)
    : { urls: [], sitemapsFetched: 0 };

  // Schema probing is plain HTTP (no browser needed) and only useful once we
  // know at least one real URL pattern to template candidates against.
  let apiPages: DiscoveredPage[] = [];
  let apiStats: DiscoveryCoverage["api"] = {
    graphqlEndpoint: null,
    openapiEndpoint: null,
    candidatesGenerated: 0,
    candidatesConfirmed: 0,
  };
  if (discovery.api.enabled && discovery.api.maxCandidates > 0) {
    const schemaResult = await discoverViaSchema(origin, [...crawlUrls, ...sitemapResult.urls], {
      maxCandidates: discovery.api.maxCandidates,
      timeoutMs: discovery.api.timeoutMs,
    });
    apiPages = schemaResult.pages;
    apiStats = {
      graphqlEndpoint: schemaResult.graphqlEndpoint,
      openapiEndpoint: schemaResult.openapiEndpoint,
      candidatesGenerated: schemaResult.candidatesGenerated,
      candidatesConfirmed: schemaResult.candidatesConfirmed,
    };
  }

  return assemblePageSet(config, crawlUrls, sitemapResult.urls, {
    sitemapsFetched: sitemapResult.sitemapsFetched,
    apiPages,
    apiStats,
  });
}

/**
 * Pure assembly: given the raw URL lists from each source, produce the Page Set.
 * No I/O — deterministic and unit-testable. `crawlUrls` is expected in breadth
 * order; `sitemapUrls` in sitemap order. `meta` fields are all optional and
 * default to empty/zero for callers/tests that don't track them.
 */
export function assemblePageSet(
  config: ResolvedConfig,
  crawlUrls: string[],
  sitemapUrls: string[],
  meta: {
    sitemapsFetched?: number;
    apiPages?: DiscoveredPage[];
    apiStats?: DiscoveryCoverage["api"];
  } = {}
): PageSet {
  const target = normalizeUrl(config.url!);
  if (!target) throw new Error(`Invalid target URL: ${config.url}`);
  const origin = new URL(target).origin;
  const { discovery } = config;
  const apiPages = meta.apiPages ?? [];

  // ── Source 1: config routes (authoritative). Target URL is an implicit route. ──
  const configUrls = [config.url!, ...discovery.routes]
    .map((r) => normalizeUrl(r, origin))
    .filter((u): u is string => !!u);
  const configPages = dedupeByUrl(configUrls.map((url) => ({ url, source: "config" as const })));
  const configSet = new Set(configPages.map((p) => p.url));

  // ── Sources 2-4: normalize + same-origin + glob filter; config wins ties. ──
  const discoveredPages: DiscoveredPage[] = [];
  let crossOriginDropped = 0;
  const pushDiscovered = (raw: string, source: "crawl" | "sitemap" | "api") => {
    const url = normalizeUrl(raw, origin);
    if (!url) return;
    if (!isSameOrigin(url, origin, discovery.allowSubdomains)) {
      crossOriginDropped++;
      return;
    }
    if (!passesGlobs(pathOf(url), discovery.include, discovery.exclude)) return;
    if (configSet.has(url)) return;
    discoveredPages.push({ url, source });
  };
  for (const u of crawlUrls) pushDiscovered(u, "crawl");
  for (const u of sitemapUrls) pushDiscovered(u, "sitemap");
  for (const p of apiPages) pushDiscovered(p.url, "api");

  // Dedupe (crawl before sitemap before api → crawl wins), then collapse
  // parametric families.
  const deduped = dedupeByUrl(discoveredPages);
  const duplicatesDropped = discoveredPages.length - deduped.length;

  const collapsed = collapseParametric(deduped, discovery.samplesPerPattern);
  const samplingDropped = deduped.length - collapsed.length;

  // Cap: config routes always kept; fill the remaining budget with the rest.
  const remaining = Math.max(0, config.budgets.maxPages - configPages.length);
  const kept = collapsed.slice(0, remaining);
  const capDropped = Math.max(0, collapsed.length - remaining);

  const coverage: DiscoveryCoverage = {
    config: configPages.length,
    sitemap: { sitemapsFetched: meta.sitemapsFetched ?? 0, urlsDeclared: sitemapUrls.length },
    crawl: { urlsFound: crawlUrls.length },
    api: meta.apiStats ?? {
      graphqlEndpoint: null,
      openapiEndpoint: null,
      candidatesGenerated: 0,
      candidatesConfirmed: 0,
    },
    duplicatesDropped,
    samplingDropped,
    capDropped,
    crossOriginDropped,
  };

  return {
    pages: [...configPages, ...kept],
    generatedAt: new Date().toISOString(),
    truncated: collapsed.length > remaining,
    coverage,
  };
}
