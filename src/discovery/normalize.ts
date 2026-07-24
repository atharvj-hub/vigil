// URL normalization, filtering, and parametric collapsing — the pipeline every
// discovery candidate passes through (documentation/03-discovery.md).
//
// Misgrouping in parametric collapsing "costs at most a few extra or fewer
// visits, never correctness" — so the heuristics here are deliberately simple.

import type { DiscoveredPage, DiscoverySource } from "../types.js";

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|mc_|ref$|ref_|igshid$)/i;

/** Strip fragment + tracking params, sort remaining query keys, drop trailing slash. */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.hash = "";

  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (!TRACKING_PARAM.test(k)) kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Normalize trailing slash on non-root paths so "/a" and "/a/" dedupe.
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

/** Strip a leading "www." — apex and www are the same site in every practical sense. */
function stripWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

/** Same-origin test. www/apex are always treated as one site; other subdomains excluded unless allowSubdomains. */
export function isSameOrigin(candidate: string, origin: string, allowSubdomains: boolean): boolean {
  let c: URL, o: URL;
  try {
    c = new URL(candidate);
    o = new URL(origin);
  } catch {
    return false;
  }
  const cHost = stripWww(c.hostname);
  const oHost = stripWww(o.hostname);
  if (allowSubdomains) {
    return cHost === oHost || c.hostname.endsWith("." + o.hostname) || o.hostname.endsWith("." + c.hostname);
  }
  return cHost === oHost && c.port === o.port;
}

/** Convert a simple glob (`**`, `*`, `?`) to an anchored RegExp against the path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    // "/**" — the preceding slash is optional so "/admin/**" also matches "/admin".
    if (ch === "/" && glob.slice(i + 1, i + 3) === "**") {
      re += "(?:/.*)?";
      i += 2;
    } else if (glob.slice(i, i + 2) === "**") {
      re += ".*"; // bare ** — any chars including /
      i += 1;
    } else if (ch === "*") {
      re += "[^/]*"; // * — any chars except /
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

/** A path passes if it matches at least one include glob and no exclude glob. */
export function passesGlobs(path: string, include: string[], exclude: string[]): boolean {
  const inc = include.length === 0 || include.some((g) => globToRegExp(g).test(path));
  if (!inc) return false;
  return !exclude.some((g) => globToRegExp(g).test(path));
}

// ── Parametric collapsing ────────────────────────────────────────────────────

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HEX_HASH = /^[0-9a-f]{16,}$/i;

/** Replace high-cardinality segments with placeholders to yield a pattern key. */
export function pathPattern(pathname: string): { pattern: string; parametric: boolean } {
  const segs = pathname.split("/");
  let parametric = false;
  const out = segs.map((s) => {
    if (s === "") return s;
    if (/^\d+$/.test(s)) {
      parametric = true;
      return ":n";
    }
    if (UUID.test(s)) {
      parametric = true;
      return ":id";
    }
    if (HEX_HASH.test(s)) {
      parametric = true;
      return ":hash";
    }
    if (s.length > 24) {
      parametric = true;
      return ":slug";
    }
    return s;
  });
  return { pattern: out.join("/"), parametric };
}

/**
 * Collapse obvious parametric families: URLs sharing a parametric pattern keep
 * only `samplesPerPattern` representatives. Non-parametric URLs pass untouched.
 */
export function collapseParametric(pages: DiscoveredPage[], samplesPerPattern: number): DiscoveredPage[] {
  const groups = new Map<string, { pages: DiscoveredPage[]; parametric: boolean; queryKey: string }>();
  for (const p of pages) {
    const u = new URL(p.url);
    const { pattern, parametric } = pathPattern(u.pathname);
    // Family key includes the query-key shape so "/p/1?x" and "/p/2?x" group but
    // "/p/1" and "/p/1?edit" do not.
    const queryKey = [...u.searchParams.keys()].sort().join(",");
    const key = `${u.origin}${pattern}?${queryKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { pages: [], parametric, queryKey };
      groups.set(key, g);
    }
    g.pages.push(p);
  }

  const out: DiscoveredPage[] = [];
  for (const [, g] of groups) {
    if (!g.parametric || g.pages.length <= samplesPerPattern) {
      out.push(...g.pages);
      continue;
    }
    const u = new URL(g.pages[0]!.url);
    const { pattern } = pathPattern(u.pathname);
    for (const p of g.pages.slice(0, samplesPerPattern)) {
      out.push({ ...p, patternGroup: pattern });
    }
  }
  return out;
}

/**
 * Dedupe by normalized URL keeping the first (highest-priority) occurrence, and
 * therefore its source. Input must already be in priority order.
 */
export function dedupeByUrl(pages: DiscoveredPage[]): DiscoveredPage[] {
  const seen = new Set<string>();
  const out: DiscoveredPage[] = [];
  for (const p of pages) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    out.push(p);
  }
  return out;
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export type { DiscoverySource };
