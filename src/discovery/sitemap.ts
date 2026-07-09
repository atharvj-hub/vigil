// Sitemap source — cheap and usually present (documentation/03-discovery.md).
// Fetch {origin}/sitemap.xml plus any `Sitemap:` lines in robots.txt, and follow
// sitemap indexes one level deep. Same-origin <loc>s become candidates.

import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: true });

async function fetchText(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Extract `Sitemap:` URLs declared in robots.txt. */
async function sitemapUrlsFromRobots(origin: string): Promise<string[]> {
  const txt = await fetchText(new URL("/robots.txt", origin).toString());
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
  // <sitemapindex><sitemap><loc>…  — child sitemaps (one level deep)
  for (const s of asArray(doc?.sitemapindex?.sitemap)) {
    if (s?.loc) children.push(String(s.loc));
  }
  return { locs, children };
}

/**
 * Collect all same-origin page URLs from the origin's sitemaps.
 * Robust to a missing sitemap (returns []). Never throws.
 */
export async function discoverFromSitemap(origin: string): Promise<string[]> {
  const roots = new Set<string>([new URL("/sitemap.xml", origin).toString()]);
  for (const s of await sitemapUrlsFromRobots(origin)) roots.add(s);

  const locs: string[] = [];
  const childSitemaps: string[] = [];

  // Level 0 — the declared/root sitemaps.
  for (const root of roots) {
    const xml = await fetchText(root);
    if (!xml) continue;
    const { locs: l, children } = parseSitemap(xml);
    locs.push(...l);
    childSitemaps.push(...children);
  }

  // Level 1 — child sitemaps from any index (one level deep only).
  const visited = new Set(roots);
  for (const child of childSitemaps) {
    if (visited.has(child)) continue;
    visited.add(child);
    const xml = await fetchText(child);
    if (!xml) continue;
    locs.push(...parseSitemap(xml).locs);
  }

  return locs;
}
