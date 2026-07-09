import { chromium } from "playwright";
import type { Signals } from "./types.js";

/**
 * Visits ONE page and captures the Signals subset Stage 1 needs.
 * Mirrors the settle protocol in 04-checks.md:
 *   1. wait for 'load' (hard cap 15s)
 *   2. network-quiet window (skipped here for brevity — full version in Phase 1 proper)
 *   3. fixed paint grace
 *   4. capture
 *
 * This is pure observation — never clicks, types, or submits (02-architecture.md:
 * "Collector is pure observation").
 */
export async function collect(url: string, isDiscoveredPage = true): Promise<Signals> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  let crashed = false;
  page.on("crash", () => { crashed = true; });

  let status: number | null = null;
  let navigationError: string | undefined;

  try {
    const response = await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    status = response?.status() ?? null;
  } catch (err) {
    navigationError = err instanceof Error ? err.message : String(err);
  }

  // paint grace (real version also disables animations + awaits network-quiet)
  await page.waitForTimeout(250);

  const textLength = status !== null
    ? await page.evaluate(() => document.body.innerText.length)
    : 0;

  // Real version diffs a downsampled screenshot against a uniform-color reference.
  // Placeholder heuristic for this slice:
  const screenshotLooksBlank = textLength < 40;

  await browser.close();

  return {
    url,
    document: { status, navigationError },
    crashed,
    render: { textLength, screenshotLooksBlank },
    isDiscoveredPage,
  };
}
