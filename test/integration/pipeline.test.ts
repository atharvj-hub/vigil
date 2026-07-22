// End-to-end: start the fixture app, run the REAL pipeline (real Chromium),
// and assert the verdicts. This is the test that proves vigil actually works
// against a live target — not just that the pure logic is correct.
//
// Requires Chromium: `npx playwright install chromium`. Run with `npm run test:e2e`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs fixture, no type declarations needed
import { startFixture } from "../fixtures/app.mjs";
import { Vigil, runSanity } from "../../src/index.js";
import type { PageResult, RunResult } from "../../src/types.js";

let server: { close: (cb?: () => void) => void };
let base: string;
let reportDir: string;

beforeAll(async () => {
  const fx = await startFixture(0); // random free port
  server = fx.server;
  base = fx.url;
  reportDir = mkdtempSync(join(tmpdir(), "vigil-e2e-"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(reportDir, { recursive: true, force: true });
});

const byPath = (r: RunResult, path: string): PageResult | undefined =>
  r.pages.find((p) => new URL(p.url).pathname === path);

describe("full run against the fixture app", () => {
  let result: RunResult;

  beforeAll(async () => {
    result = await runSanity({
      url: base,
      discovery: { crawl: { depth: 2, maxPages: 50 } },
      model: { judge: false }, // Phase 1 deterministic-pipeline test — no AI judge
      report: { dir: reportDir },
    });
  });

  it("returns BROKEN because real breakages were injected", () => {
    expect(result.verdict).toBe("BROKEN");
  });

  it("discovers the linked pages and collapses the product family", () => {
    // 3 product URLs are linked, but parametric collapsing samples only 2 of them.
    const products = result.pages.filter((p) => /^\/products\/\d+$/.test(new URL(p.url).pathname));
    expect(products.length).toBe(2);
    expect(byPath(result, "/about")).toBeDefined();
  });

  it("H2 — the 500 route is a hard fail", () => {
    const boom = byPath(result, "/boom");
    expect(boom?.status).toBe("fail");
    expect(boom?.hardRule).toBe("H2");
    expect(boom?.retried).toBe(true);
  });

  it("H4 — the blank and chunk-404 pages are hard fails", () => {
    expect(byPath(result, "/blank")?.hardRule).toBe("H4");
    expect(byPath(result, "/chunk404")?.hardRule).toBe("H4");
  });

  it("a first-party API 500 is a warn, not a red", () => {
    expect(byPath(result, "/apifail")?.status).toBe("warn");
  });

  it("clean pages pass (no false reds)", () => {
    expect(byPath(result, "/")?.status).toBe("pass");
    expect(byPath(result, "/about")?.status).toBe("pass");
    expect(byPath(result, "/pricing")?.status).toBe("pass");
  });

  it("writes the artifacts a human/CI consumes", () => {
    expect(result.artifactsDir).toContain("vigil-e2e-");
    expect(result.counts.fail).toBeGreaterThanOrEqual(3);
  });
});

describe("targeted single-page checks", () => {
  it("checkPage flags the 500 route", async () => {
    const vigil = await Vigil.create({ report: { dir: reportDir }, model: { judge: false } }, base);
    const p = await vigil.checkPage("/boom");
    expect(p.status).toBe("fail");
    expect(p.hardRule).toBe("H2");
  });

  it("a healthy page whose load event hangs is a warn, never H1", async () => {
    const vigil = await Vigil.create({ report: { dir: reportDir }, model: { judge: false } }, base);
    const p = await vigil.checkPage("/slowload");
    expect(p.status).toBe("warn");
    expect(p.hardRule).toBeUndefined();
  });

  it("dismisses a first-visit cookie banner before capture — content isn't blank/broken", async () => {
    const vigil = await Vigil.create({ report: { dir: reportDir }, model: { judge: false } }, base);
    const p = await vigil.checkPage("/cookiegate");
    expect(p.status).toBe("pass");
    expect(p.signals.render.h1).toBe("Welcome");
    expect(p.signals.render.textSample).not.toContain("We use cookies");
  });

  it("checks.dismissCookieBanners: false leaves the banner up (opt-out honored)", async () => {
    const vigil = await Vigil.create(
      { report: { dir: reportDir }, model: { judge: false }, checks: { dismissCookieBanners: false } },
      base
    );
    const p = await vigil.checkPage("/cookiegate");
    // The banner's own text is still present in the DOM — proves the dismiss
    // step actually ran in the default-on case above, rather than the click
    // handler firing regardless of the option.
    expect(p.signals.render.textSample).toContain("We use cookies");
  });

  it("waits for the DOM to stop changing before capturing — catches content that mounts after network goes quiet", async () => {
    const vigil = await Vigil.create({ report: { dir: reportDir }, model: { judge: false } }, base);
    const p = await vigil.checkPage("/spa-slow-render");
    expect(p.signals.render.textSample).toContain("Real content has finally rendered here");
  });

  it("checks.domStabilityWait: false captures before the delayed content mounts (opt-out honored)", async () => {
    const vigil = await Vigil.create(
      { report: { dir: reportDir }, model: { judge: false }, checks: { domStabilityWait: false } },
      base
    );
    const p = await vigil.checkPage("/spa-slow-render");
    // Network goes quiet almost immediately on this page (nothing was ever
    // fetched), so with the stability wait off, capture happens well before
    // the 1400ms timer — proves the wait above is what caught the content,
    // not some other unrelated delay in the pipeline.
    expect(p.signals.render.textSample).not.toContain("Real content has finally rendered here");
  });

  it("a static empty shell is treated as not-yet-rendered, not settled — no false blank-render fail", async () => {
    // Regression test for a false BROKEN found dogfooding a real SPA: the
    // empty pre-bootstrap shell is perfectly stable, so the stability window
    // alone declared it settled and captured 0 chars → H4 blank-render fail
    // on a completely healthy page.
    const vigil = await Vigil.create({ report: { dir: reportDir }, model: { judge: false } }, base);
    const p = await vigil.checkPage("/spa-empty-shell");
    expect(p.status).toBe("pass");
    expect(p.hardRule).toBeUndefined();
    expect(p.signals.render.textSample).toContain("finally finished bootstrapping");
  });

  it("a genuinely blank page still hard-fails H4 (the guard delays the verdict, never suppresses it)", async () => {
    const vigil = await Vigil.create({ report: { dir: reportDir }, model: { judge: false } }, base);
    const p = await vigil.checkPage("/blank");
    expect(p.status).toBe("fail");
    expect(p.hardRule).toBe("H4");
  });

  it("the stability fingerprint catches a same-length spinner→content swap that text length alone would miss", async () => {
    const vigil = await Vigil.create({ report: { dir: reportDir }, model: { judge: false } }, base);
    const p = await vigil.checkPage("/spa-same-length-swap");
    expect(p.signals.render.textSample).toContain("Real content has now mounted");
    expect(p.signals.render.spinnerStuck).toBe(false);
  });
});

describe("a clean subset is HEALTHY", () => {
  it("only clean routes → HEALTHY, zero fails", async () => {
    const r = await runSanity({
      url: base,
      discovery: { routes: ["/about", "/pricing"], sitemap: false, crawl: { enabled: false } },
      model: { judge: false },
      report: { dir: reportDir },
    });
    expect(r.verdict).toBe("HEALTHY");
    expect(r.counts.fail).toBe(0);
  });
});
