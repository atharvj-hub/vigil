// Bounded same-origin crawl — the fallback and gap-filler (documentation/03).
// Read-only by construction: it navigates and reads hrefs, never clicks, submits,
// or executes interactions. SPA client-side navigations are caught by wrapping
// history.pushState/replaceState via an init script.

import type { Browser } from "playwright";
import { normalizeUrl, isSameOrigin, passesGlobs, pathOf } from "./normalize.js";

export interface CrawlOptions {
  depth: number;
  maxPages: number;
  politenessMs: number;
  allowSubdomains: boolean;
  include: string[];
  exclude: string[];
}

const INIT_SCRIPT = `
  (() => {
    window.__vigilNav = [];
    const rec = (u) => { try { window.__vigilNav.push(String(u)); } catch {} };
    const wrap = (name) => {
      const orig = history[name];
      history[name] = function (state, title, url) {
        if (url != null) rec(url);
        return orig.apply(this, arguments);
      };
    };
    wrap("pushState");
    wrap("replaceState");
  })();
`;

/**
 * BFS from startUrl. Returns normalized, same-origin, glob-passing URLs in
 * discovery (breadth) order — shallower pages first. Never throws.
 */
export async function crawl(browser: Browser, startUrl: string, opts: CrawlOptions): Promise<string[]> {
  const start = normalizeUrl(startUrl);
  if (!start) return [];
  const origin = new URL(start).origin;

  const found = new Set<string>([start]);
  const order: string[] = [start];
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];

  const context = await browser.newContext();
  try {
    await context.addInitScript(INIT_SCRIPT);

    while (queue.length > 0 && found.size < opts.maxPages) {
      const { url, depth } = queue.shift()!;
      if (depth >= opts.depth) continue;

      const links = await extractLinks(context, url);
      for (const link of links) {
        const norm = normalizeUrl(link, url);
        if (!norm) continue;
        if (!isSameOrigin(norm, origin, opts.allowSubdomains)) continue;
        if (!passesGlobs(pathOf(norm), opts.include, opts.exclude)) continue;
        if (found.has(norm)) continue;
        found.add(norm);
        order.push(norm);
        queue.push({ url: norm, depth: depth + 1 });
        if (found.size >= opts.maxPages) break;
      }
      if (opts.politenessMs > 0) await sleep(opts.politenessMs);
    }
  } finally {
    await context.close();
  }
  return order;
}

async function extractLinks(context: import("playwright").BrowserContext, url: string): Promise<string[]> {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(300); // brief grace for late pushState navigations
    return await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll("a[href]"), (a) =>
        (a as HTMLAnchorElement).getAttribute("href")
      ).filter((h): h is string => !!h);
      const nav = ((window as any).__vigilNav as string[]) ?? [];
      return [...hrefs, ...nav];
    });
  } catch {
    return [];
  } finally {
    await page.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
