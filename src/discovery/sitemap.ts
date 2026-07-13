// Sitemap source — cheap and usually present (documentation/03-discovery.md).
// Fetch {origin}/sitemap.xml plus any `Sitemap:` lines in robots.txt, and follow
// sitemap indexes recursively (real sites nest 2-3+ levels deep). Handles both
// server-negotiated gzip (Content-Encoding, decoded by fetch already) and
// literal `sitemap.xml.gz` files served as raw gzip bytes (fetch does NOT
// decode those on its own — there's no Content-Encoding header to trigger it).

import { XMLParser } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";

const parser = new XMLParser({ ignoreAttributes: true });

// Hard caps so a pathological or malicious sitemap index (deeply nested, or
// thousands of children) can't hang a run — discovery must always terminate.
const MAX_SITEMAPS_FETCHED = 50;
const MAX_SITEMAP_DEPTH = 6;

async function fetchBuffer(url: string, timeoutMs = 10_000): Promise<Buffer | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Fetch a sitemap URL and return decompressed text, transparently. */
async function fetchSitemapText(url: string): Promise<string | null> {
  const buf = await fetchBuffer(url);
  if (!buf) return null;
  // Gzip magic bytes (0x1f 0x8b) — catches literal .gz files that fetch's
  // automatic Content-Encoding handling never touches.
  const looksGzip = url.toLowerCase().endsWith(".gz") || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b);
  if (looksGzip) {
    try {
      return gunzipSync(buf).toString("utf8");
    } catch {
      return null; // corrupt/not actually gzip — treat as unfetchable, never throw
    }
  }
  return buf.toString("utf8");
}

/** Extract `Sitemap:` URLs declared in robots.txt. */
async function sitemapUrlsFromRobots(origin: string): Promise<string[]> {
  const txt = await fetchSitemapText(new URL("/robots.txt", origin).toString());
  if (!txt) return [];
  const out: string[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Parse one sitemap document → { locs, childSitemaps }. */
function parseSitemap(xml: string): { locs: string[]; children: string[] } {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return { locs: [], children: [] };
  }
  const locs: string[] = [];
  const children: string[] = [];

  // <urlset><url><loc>…  — actual pages
  for (const u of asArray(doc?.urlset?.url)) {
    if (u?.loc) locs.push(String(u.loc));
  }
  // <sitemapindex><sitemap><loc>…  — child sitemaps (followed recursively below)
  for (const s of asArray(doc?.sitemapindex?.sitemap)) {
    if (s?.loc) children.push(String(s.loc));
  }
  return { locs, children };
}

export interface SitemapDiscoveryResult {
  urls: string[];
  sitemapsFetched: number;
}

/**
 * Collect all same-origin page URLs from the origin's sitemaps, following
 * sitemap-index nesting to MAX_SITEMAP_DEPTH and fetching at most
 * MAX_SITEMAPS_FETCHED documents total. Robust to a missing/broken sitemap
 * (returns an empty result). Never throws.
 */
export async function discoverFromSitemap(origin: string): Promise<SitemapDiscoveryResult> {
  const roots = new Set<string>([new URL("/sitemap.xml", origin).toString()]);
  for (const s of await sitemapUrlsFromRobots(origin)) roots.add(s);

  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [...roots].map((url) => ({ url, depth: 0 }));
  const locs: string[] = [];
  let sitemapsFetched = 0;

  while (queue.length > 0 && sitemapsFetched < MAX_SITEMAPS_FETCHED) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const xml = await fetchSitemapText(url);
    if (!xml) continue;
    sitemapsFetched++;

    const { locs: l, children } = parseSitemap(xml);
    locs.push(...l);

    if (depth < MAX_SITEMAP_DEPTH) {
      for (const child of children) {
        if (!visited.has(child)) queue.push({ url: child, depth: depth + 1 });
      }
    }
  }

  return { urls: locs, sitemapsFetched };
}
