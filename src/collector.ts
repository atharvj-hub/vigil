// Collector — visits ONE page and captures the Signals + screenshot (doc 04).
// Pure observation: it navigates and records; it never clicks, types, or submits
// (02-architecture.md: "Collector is pure observation") — with one narrow,
// documented exception: best-effort cookie-consent-banner dismissal (see
// dismissCookieBanner below). A fresh browser context carries no consent
// state, so most real sites render a first-visit consent modal that a real
// user dismisses in seconds. Left alone, that modal becomes part of every
// screenshot and can be misread as broken content by both hard rules and the
// judge — evidence about vigil's own capture, not the app. This is
// environment normalization (same class as the animation-disable CSS
// injection below), not the flow/interaction machinery FlowRunner owns —
// bounded to a fixed, well-known set of consent-button patterns, best-effort,
// and disableable via checks.dismissCookieBanners.
//
// The settle protocol (doc 04) is the flake-control-at-the-source:
//   1. await 'load' (hard cap 15s — a timeout is a signal, not an exception)
//   2. dismiss a cookie-consent banner, if present (best-effort)
//   3. network-quiet window: ≤2 in-flight for 750ms, capped 10s (ws/sse exempt)
//   4. DOM-stability wait: poll a small render fingerprint (text length, element
//      count, spinner visibility, visible heading count, readyState), capture
//      once it holds unchanged for a continuous window, capped 8s
//      (checks.domStabilityWait)
//   5. 250ms paint grace, animations disabled
//   6. capture
//
// Step 4 exists because network-quiet alone is a known-unreliable readiness
// signal for client-rendered apps: there's often a gap where the JS bundle
// has finished loading (network goes quiet) but is still parsing and
// mounting the DOM, with zero network activity during that gap. Capturing on
// network-quiet alone can catch the empty shell — a false "broken" page — or,
// if other requests keep the network busy a little longer, capture a
// half-rendered page and call it clean — a false "healthy" page. Waiting for
// rendering to stop changing catches both directions. Text length alone is a
// weak stability signal — plenty of real UI updates don't change it (a
// skeleton swapped for real cards of similar length, a spinner replaced by an
// SVG, CSS revealing a hidden section) — so the fingerprint also tracks
// element count and spinner visibility, the two cheapest signals that catch
// those cases without a full DOM diff.

import type { Browser, Request } from "playwright";
import type { Signals, RequestSummary, ConsoleEntry, CaptureTimelineEvent } from "./types.js";

const LOAD_CAP_MS = 15_000;
const QUIET_WINDOW_MS = 750;
const QUIET_MAX_MS = 10_000;
const QUIET_INFLIGHT_MAX = 2;
const DOM_STABLE_POLL_MS = 200;
const DOM_STABLE_WINDOW_MS = 500;
const DOM_STABLE_MAX_MS = 8_000;
// Below this, a "stable" fingerprint is treated as not-yet-rendered rather
// than settled (see looksUnrendered). Matches hard rule H4's blank threshold
// so the two agree on what "effectively empty" means.
const MIN_RENDERED_TEXT = 40;
const PAINT_GRACE_MS = 250;
const MAX_CONSOLE = 20;
const MAX_TEXT_SAMPLE = 2_000; // bounded rendered-text sample for data-fidelity matching — never the full body
const MAX_FIDELITY_BODY_BYTES = 500_000; // only a couple of named scalar fields get extracted, so this stays small
// Cap on the screenshot itself. Playwright's screenshot waits for document.fonts
// to be ready, which never resolves while a resource hangs — so without a bound
// it burns its full 30s default on any slow page and blows the per-page budget.
const SCREENSHOT_CAP_MS = 10_000;
const MAX_TIMELINE_REQUESTS = 60;
const MAX_TIMELINE_FINGERPRINTS = 60;

// Resource types exempt from the network-quiet count (long-lived by nature).
const QUIET_EXEMPT = new Set(["websocket", "eventsource"]);

// Shared with the final render-heuristics capture below — one definition of
// "what counts as a spinner" for both the stability wait and the report.
const SPINNER_SELECTOR = '[role="progressbar"],[aria-busy="true"],.spinner,.loading,.loader';

// Built-in framework error-page / error-boundary markers (doc 04).
const BUILTIN_MARKERS = [
  /application error/i,
  /something went wrong/i,
  /internal server error/i,
  /this page (isn'?t|is not) working/i,
  /500\s*[-–]\s*internal/i,
];

const DISABLE_ANIM_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important;}`;

// Passed to addInitScript as a raw string (not a function) so no bundler/transform
// can inject helpers (e.g. esbuild's `__name`) that would throw in page context.
const DISABLE_ANIM_INIT = `(() => {
  var css = ${JSON.stringify(DISABLE_ANIM_CSS)};
  var apply = function () {
    var s = document.createElement("style");
    s.textContent = css;
    (document.documentElement || document.head || document.body).appendChild(s);
  };
  if (document.documentElement) apply();
  else document.addEventListener("DOMContentLoaded", apply);
})();`;

export interface CollectOptions {
  origin: string;
  screenshotPath: string;
  viewport: { width: number; height: number };
  latencyBudgetMs: number;
  errorMarkers: RegExp[];
  consoleAllowlist: RegExp[];
  perPageVisitMs: number;
  dataFidelity: { apiPathPatterns: RegExp[]; fields: string[] };
  requiredSelectors: string[];
  notFoundMarkers: RegExp[];
  dismissCookieBanners: boolean;
  domStabilityWait: boolean;
}

// Fixed, bounded set of consent-button patterns covering the handful of
// consent-management platforms (OneTrust, Cookiebot, Osano, Quantcast, generic
// GDPR/CCPA banners) that account for most real-world sites, plus a
// text-based fallback for everything else. Deliberately does not attempt to
// be exhaustive — a banner this doesn't catch just leaves the page as it was
// (same as today), it never makes evidence worse.
const COOKIE_SELECTOR = [
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  ".osano-cm-accept-all",
  "[data-testid='uc-accept-all-button']",
  "button[aria-label='Accept all']",
  "button[aria-label='Accept All']",
].join(",");
const COOKIE_TEXT_RE =
  /^(accept all|accept all cookies|i accept|accept|allow all|allow all cookies|got it|agree|aceptar todo|aceptar)$/i;

/** Best-effort: click one consent-accept control if one is visibly present. Never throws. */
async function dismissCookieBanner(page: import("playwright").Page): Promise<void> {
  try {
    const known = page.locator(COOKIE_SELECTOR).first();
    if (await known.isVisible({ timeout: 800 }).catch(() => false)) {
      await known.click({ timeout: 800 });
      return;
    }
    const candidates = page.getByRole("button", { name: COOKIE_TEXT_RE });
    const count = await candidates.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const btn = candidates.nth(i);
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ timeout: 800 });
        return;
      }
    }
  } catch {
    /* best-effort — no banner, or the click failed; leave the page as-is */
  }
}

/** Recursively pull named scalar fields out of a parsed JSON value (bounded depth). */
function extractNamedFields(
  node: unknown,
  fieldNames: Set<string>,
  out: Record<string, string | number>,
  depth = 0
): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) extractNamedFields(item, fieldNames, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((typeof value === "string" || typeof value === "number") && fieldNames.has(key) && !(key in out)) {
      out[key] = value;
    } else if (value && typeof value === "object") {
      extractNamedFields(value, fieldNames, out, depth + 1);
    }
  }
}

export async function collect(browser: Browser, url: string, opts: CollectOptions): Promise<Signals> {
  const started = Date.now();
  const context = await browser.newContext({
    viewport: opts.viewport,
    reducedMotion: "reduce",
    ignoreHTTPSErrors: false,
  });
  await context.addInitScript(DISABLE_ANIM_INIT);

  const page = await context.newPage();

  // The final report needs to answer "why did we capture here?", without
  // turning every visit into an unbounded browser trace. Keep the useful
  // readiness evidence: lifecycle milestones, a sample at every DOM-stability
  // poll, and a capped number of request completions.
  const captureTimeline: CaptureTimelineEvent[] = [];
  let navStart = started;
  let timelineRequests = 0;
  let timelineFingerprints = 0;
  const trace = (event: CaptureTimelineEvent) => captureTimeline.push(event);
  const atNavigation = () => Math.max(0, Date.now() - navStart);

  // ── Listeners attached BEFORE navigation ──
  let crashed = false;
  page.on("crash", () => (crashed = true));
  page.on("domcontentloaded", () => trace({ kind: "domcontentloaded", atMs: atNavigation() }));
  page.on("load", () => trace({ kind: "load", atMs: atNavigation() }));

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => {
    const stackHead = (err.stack ?? "").split("\n").slice(0, 2).join(" ").trim();
    pageErrors.push(stackHead || err.message);
  });

  const consoleMap = new Map<string, ConsoleEntry>();
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (opts.consoleAllowlist.some((re) => re.test(text))) return;
    const existing = consoleMap.get(text);
    if (existing) existing.count++;
    else if (consoleMap.size < MAX_CONSOLE)
      consoleMap.set(text, { text, sourceUrl: msg.location()?.url || undefined, count: 1 });
  });

  // Network tracking.
  let inFlight = 0;
  let settledAt = Number.POSITIVE_INFINITY; // set at capture; anything later is afterSettle
  const reqStart = new WeakMap<Request, number>();
  const requests: RequestSummary[] = [];
  const contentFields: Record<string, string | number> = {};
  const fidelityFieldNames = new Set(opts.dataFidelity.fields);
  let apiMatchedCount = 0;

  const isExempt = (r: Request) => QUIET_EXEMPT.has(r.resourceType());

  page.on("request", (req) => {
    reqStart.set(req, Date.now());
    if (!isExempt(req)) inFlight++;
  });
  const finalize = async (req: Request, failure?: string) => {
    if (!isExempt(req)) inFlight = Math.max(0, inFlight - 1);
    const start = reqStart.get(req) ?? Date.now();
    const durationMs = Date.now() - start;
    let status: number | null = null;
    let response: import("playwright").Response | null = null;
    if (!failure) {
      try {
        response = await req.response();
        status = response?.status() ?? null;
      } catch {
        status = null;
      }
    }
    let firstParty = false;
    try {
      firstParty = new URL(req.url()).origin === opts.origin;
    } catch {
      /* keep false */
    }
    // Data-fidelity extraction: only for first-party, successful responses
    // matching a configured content-API pattern — never the whole body, only
    // the specific named fields the user asked for. apiMatchedCount is tracked
    // independent of whether any configured field was actually found in the
    // body, so evaluateDataFidelity can tell "no matching API called this
    // visit" (nothing to check) apart from "API called, but the field wasn't
    // in it" (a possible backend rename — see judge/dataFidelity.ts).
    if (
      response &&
      firstParty &&
      status !== null &&
      status < 400 &&
      opts.dataFidelity.apiPathPatterns.some((re) => re.test(req.url()))
    ) {
      apiMatchedCount++;
      if (fidelityFieldNames.size > 0) {
        try {
          const body = await response.text();
          if (body.length <= MAX_FIDELITY_BODY_BYTES) {
            extractNamedFields(JSON.parse(body), fidelityFieldNames, contentFields);
          }
        } catch {
          /* not JSON, or body unavailable — this is best-effort evidence, not a check itself */
        }
      }
    }
    requests.push({
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      status,
      failure,
      durationMs,
      firstParty,
      slow: durationMs > opts.latencyBudgetMs,
      afterSettle: Date.now() > settledAt,
    });
    if (timelineRequests < MAX_TIMELINE_REQUESTS) {
      timelineRequests++;
      trace({ kind: "request-complete", atMs: atNavigation(), resourceType: req.resourceType(), status, failure });
    }
  };
  page.on("requestfinished", (req) => void finalize(req));
  page.on("requestfailed", (req) => void finalize(req, req.failure()?.errorText ?? "request failed"));

  // ── Navigate ──
  const redirects: string[] = [];
  let status: number | null = null;
  let navigationError: string | undefined;
  let loadMs: number | null = null;
  let timedOut = false;

  navStart = Date.now();
  trace({ kind: "navigation-start", atMs: 0 });
  let response: import("playwright").Response | null = null;
  try {
    // "commit" resolves as soon as the server responds and navigation commits,
    // so we capture the document status even when the load event never fires.
    // A genuine navigation failure (DNS, refused, TLS, zero-byte timeout) throws
    // here → H1. A merely slow *load* is handled below as a signal, not a failure.
    response = await page.goto(url, { waitUntil: "commit", timeout: LOAD_CAP_MS });
  } catch (err) {
    navigationError = firstLine(err instanceof Error ? err.message : String(err));
    trace({ kind: "navigation-error", atMs: atNavigation(), detail: navigationError });
  }

  if (response) {
    status = response.status();
    for (const r of collectRedirectChain(response)) redirects.push(r);
    // Soft-wait for the load event; a timeout here is a signal (warn), not H1.
    try {
      await page.waitForLoadState("load", { timeout: LOAD_CAP_MS });
      loadMs = Date.now() - navStart;
    } catch {
      timedOut = true;
    }
  }

  // ── Network-quiet window (only meaningful if navigation produced a document) ──
  let settledMs: number | null = null;
  if (navigationError === undefined) {
    if (opts.dismissCookieBanners && !crashed) await dismissCookieBanner(page);
    const quietResult = await waitForNetworkQuiet(() => inFlight, () => elapsed(started) > opts.perPageVisitMs);
    trace({
      kind: quietResult === "quiet" ? "network-quiet" : "network-quiet-timeout",
      atMs: atNavigation(),
      detail: quietResult === "budget" ? "page visit budget reached" : undefined,
    });
    let domResult = "disabled";
    if (opts.domStabilityWait && !crashed) {
      domResult = await waitForDomStable(page, () => elapsed(started) > opts.perPageVisitMs, (fingerprint) => {
        if (timelineFingerprints >= MAX_TIMELINE_FINGERPRINTS) return;
        timelineFingerprints++;
        trace({ kind: "fingerprint", atMs: atNavigation(), inFlight, ...fingerprint });
      });
      if (domResult === "stable") trace({ kind: "dom-stable", atMs: atNavigation() });
    }
    trace({ kind: "capture-decision", atMs: atNavigation(), detail: `network=${quietResult}; dom=${domResult}` });
    await page.waitForTimeout(PAINT_GRACE_MS);
    settledMs = Date.now() - navStart;
    if (elapsed(started) > opts.perPageVisitMs) timedOut = true;
  }
  settledAt = Date.now();

  // ── Capture render heuristics + screenshot ──
  const allMarkers = [...BUILTIN_MARKERS, ...opts.errorMarkers];
  let render: Signals["render"] = {
    textLength: 0,
    title: "",
    h1: null,
    textSample: "",
    errorMarkersFound: [],
    spinnerStuck: false,
    screenshotLooksBlank: true,
    missingSelectors: [],
    notFoundMarkersFound: [],
  };
  let finalUrl = url;
  if (navigationError === undefined && !crashed) {
    finalUrl = page.url();
    try {
      const dom = await page.evaluate(({ selectors, spinnerSel }) => {
        const text = document.body ? document.body.innerText : "";
        const h1 = document.querySelector("h1");
        const spinnerVisible = Array.from(document.querySelectorAll(spinnerSel)).some((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const style = getComputedStyle(el as HTMLElement);
          return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        });
        // Cheap "blank screen" proxy: no meaningful visible media and near-zero text.
        const media = Array.from(document.querySelectorAll("img,svg,canvas,video,picture")).some((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        });
        const visibleEls = Array.from(document.body?.querySelectorAll("*") ?? []).filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 4 && r.height > 4;
        }).length;
        const missing = selectors.filter((sel) => {
          try {
            return document.querySelector(sel) === null;
          } catch {
            return false; // an invalid selector shouldn't itself be reported as "missing"
          }
        });
        return {
          text,
          title: document.title,
          h1: h1 ? h1.textContent?.trim() || null : null,
          spinnerVisible,
          hasMedia: media,
          visibleEls,
          missingSelectors: missing,
        };
      }, { selectors: opts.requiredSelectors, spinnerSel: SPINNER_SELECTOR });
      const found = allMarkers.filter((re) => re.test(dom.text)).map((re) => re.source);
      const notFoundFound = opts.notFoundMarkers.filter((re) => re.test(dom.text)).map((re) => re.source);
      render = {
        textLength: dom.text.trim().length,
        title: dom.title,
        h1: dom.h1,
        textSample: dom.text.trim().slice(0, MAX_TEXT_SAMPLE),
        errorMarkersFound: found,
        spinnerStuck: dom.spinnerVisible,
        screenshotLooksBlank: dom.text.trim().length < 40 && !dom.hasMedia && dom.visibleEls < 3,
        missingSelectors: dom.missingSelectors,
        notFoundMarkersFound: notFoundFound,
      };
    } catch {
      /* leave render defaults (blank) — evaluation failing is itself broken-ish */
    }
    try {
      // Bound the screenshot to the remaining per-page budget so a hanging page
      // (fonts never ready) can't stall the whole visit on its 30s default.
      const remaining = opts.perPageVisitMs - elapsed(started);
      const timeout = Math.max(2000, Math.min(SCREENSHOT_CAP_MS, remaining));
      trace({ kind: "capture", atMs: atNavigation(), detail: `screenshot timeout ${timeout}ms` });
      await page.screenshot({ path: opts.screenshotPath, timeout, animations: "disabled" });
    } catch {
      /* screenshot best-effort — a page too broken to snapshot is already flagged */
    }
  }

  await context.close();

  return {
    url,
    finalUrl,
    document: {
      status,
      redirects,
      navigationError,
      loadMs,
      settledMs,
    },
    requests,
    captureTimeline,
    console: [...consoleMap.values()],
    pageErrors,
    crashed,
    render,
    contentFields,
    apiMatchedCount,
    flows: [],
    screenshotPath: opts.screenshotPath,
    timedOut,
  };
}

function collectRedirectChain(response: import("playwright").Response): string[] {
  const chain: string[] = [];
  let req: import("playwright").Request | null = response.request();
  while (req) {
    const from = req.redirectedFrom();
    if (from) chain.unshift(from.url());
    req = from;
  }
  return chain;
}

/**
 * A small, cheap render fingerprint — deliberately not a single scalar.
 * `textLength` alone misses plenty of real UI changes (a skeleton swapped
 * for real cards of similar length, a spinner replaced by an SVG, CSS
 * revealing a hidden section) that don't move the character count but very
 * much change what's on screen. `childElementCount` and `spinnerVisible`
 * catch most of those without a full DOM diff; `visibleHeadingCount` and
 * `readyState` are two more free signals from the same round trip.
 */
interface DomFingerprint {
  textLength: number;
  childElementCount: number;
  spinnerVisible: boolean;
  visibleHeadingCount: number;
  readyState: string;
}

async function readDomFingerprint(page: import("playwright").Page, spinnerSelector: string): Promise<DomFingerprint> {
  return page.evaluate((spinnerSel) => {
    return {
      textLength: (document.body?.innerText ?? "").trim().length,
      childElementCount: document.body?.getElementsByTagName("*").length ?? 0,
      spinnerVisible: Array.from(document.querySelectorAll(spinnerSel)).some((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }),
      visibleHeadingCount: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }).length,
      readyState: document.readyState,
    };
  }, spinnerSelector);
}

/**
 * Is this fingerprint consistent with "the app hasn't rendered yet" rather
 * than "the app settled and this is genuinely the page"? A client-rendered
 * app serves a static empty shell first, and that shell is *perfectly stable*
 * — the stability window alone happily declares it settled, which is the
 * heuristic's blind spot (it can't tell "done" from "not started"). Weighting
 * an empty/spinner state as not-yet-rendered resolves that ambiguity in the
 * safe direction: keep waiting up to the cap instead of capturing a shell.
 *
 * A page that really is blank still hard-fails (H4) — it just takes the full
 * DOM_STABLE_MAX_MS to say so, which is the right trade: a false BROKEN on a
 * healthy slow app costs far more than a few seconds on an actually-dead one.
 */
function looksUnrendered(fp: DomFingerprint): boolean {
  return fp.spinnerVisible || fp.textLength < MIN_RENDERED_TEXT;
}

function fingerprintsEqual(a: DomFingerprint, b: DomFingerprint): boolean {
  return (
    a.textLength === b.textLength &&
    a.childElementCount === b.childElementCount &&
    a.spinnerVisible === b.spinnerVisible &&
    a.visibleHeadingCount === b.visibleHeadingCount &&
    a.readyState === b.readyState
  );
}

/**
 * Poll the render fingerprint until it has held unchanged for a continuous
 * DOM_STABLE_WINDOW_MS (mirrors waitForNetworkQuiet's own quiet-window
 * pattern below — any change resets the window), or the cap / remaining page
 * budget is hit. Best-effort: any evaluation failure (page navigating away,
 * closing) just ends the wait — there's nothing more to wait for at that
 * point.
 *
 * This is a heuristic, not a guarantee: it cannot distinguish "settled,
 * nothing left to render" from "hasn't started rendering yet" for content
 * that changes only once, long after an otherwise-static initial paint — no
 * passive observation can, without knowing the future. What it reliably
 * catches is the common real case: content still actively mounting/changing
 * right as network-quiet fires.
 */
type DomStabilityResult = "stable" | "max-wait" | "budget" | "unavailable";

async function waitForDomStable(
  page: import("playwright").Page,
  budgetExceeded: () => boolean,
  onFingerprint: (fingerprint: DomFingerprint) => void
): Promise<DomStabilityResult> {
  const start = Date.now();
  let last: DomFingerprint | null = null;
  let unchangedSince: number | null = null;
  while (Date.now() - start < DOM_STABLE_MAX_MS) {
    if (budgetExceeded()) return "budget";
    let current: DomFingerprint;
    try {
      current = await readDomFingerprint(page, SPINNER_SELECTOR);
    } catch {
      return "unavailable";
    }
    onFingerprint(current);
    if (last && fingerprintsEqual(current, last)) {
      if (unchangedSince === null) unchangedSince = Date.now();
      // Stable AND actually rendered → settled. Stable but still empty or
      // spinning → treat as not-yet-rendered and keep waiting to the cap.
      else if (Date.now() - unchangedSince >= DOM_STABLE_WINDOW_MS && !looksUnrendered(current)) return "stable";
    } else {
      last = current;
      unchangedSince = null;
    }
    await new Promise((r) => setTimeout(r, DOM_STABLE_POLL_MS));
  }
  return "max-wait";
}

type NetworkQuietResult = "quiet" | "max-wait" | "budget";

async function waitForNetworkQuiet(inFlight: () => number, budgetExceeded: () => boolean): Promise<NetworkQuietResult> {
  const start = Date.now();
  let quietSince: number | null = null;
  while (Date.now() - start < QUIET_MAX_MS) {
    if (budgetExceeded()) return "budget";
    if (inFlight() <= QUIET_INFLIGHT_MAX) {
      if (quietSince === null) quietSince = Date.now();
      else if (Date.now() - quietSince >= QUIET_WINDOW_MS) return "quiet";
    } else {
      quietSince = null;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return "max-wait";
}

const elapsed = (since: number) => Date.now() - since;
const firstLine = (s: string) => s.split("\n")[0]!.trim();
