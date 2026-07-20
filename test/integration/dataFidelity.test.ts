// End-to-end proof for the data-fidelity check: a real content-API endpoint
// plus two pages that both fetch it — one renders the fetched title correctly,
// one has the exact bug this check exists to catch (fetches the real data but
// renders a stale/broken placeholder instead of using it). Runs the REAL
// pipeline (collector → hardRules → dataFidelity → verdict), not just the
// pure evaluateDataFidelity logic already covered in test/unit/dataFidelity.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { runSanity } from "../../src/index.js";
import type { PageResult, RunResult } from "../../src/types.js";

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (url === "/") return send(200, "text/html", html("<h1>Home</h1><p>Nothing to see here.</p>"));
    if (url === "/api/movie") return send(200, "application/json", JSON.stringify({ title: "A Common Man" }));
    // Padded with a paragraph + nav so textLength/visibleEls clear the H4
    // "blank render" hard-rule thresholds — this test is about data fidelity,
    // not blank-page detection, so the fixture needs enough real content that
    // H4 never fires and masks the check being tested.
    const filler = `<p>Watch the full movie now, only on our platform.</p><nav><a href="/">Home</a> <a href="/movies/correct">This film</a></nav>`;
    if (url === "/movies/correct") {
      return send(
        200,
        "text/html",
        html(`<h1 id="t">Loading…</h1>${filler}
          <script>fetch('/api/movie').then(r=>r.json()).then(d=>{document.getElementById('t').textContent=d.title;});</script>`)
      );
    }
    if (url === "/movies/broken") {
      // The bug this check exists to catch: fetches the real API data (so it's
      // captured), but renders a hardcoded/stale placeholder instead of it.
      return send(
        200,
        "text/html",
        html(`<h1 id="t">movie.title.missing</h1>${filler}<script>fetch('/api/movie');</script>`)
      );
    }
    return send(404, "text/html", html("<h1>404</h1>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

const byPath = (r: RunResult, path: string): PageResult | undefined =>
  r.pages.find((p) => new URL(p.url).pathname === path);

describe("data-fidelity check — full pipeline", () => {
  let server: Server;
  let base: string;
  let result: RunResult;

  beforeAll(async () => {
    const started = await startServer();
    server = started.server;
    base = started.base;
    result = await runSanity({
      url: base,
      discovery: { routes: ["/movies/correct", "/movies/broken"], sitemap: false, crawl: { enabled: false } },
      checks: { dataFidelity: { enabled: true, apiPathPatterns: [/\/api\/movie/], fields: ["title"] } },
      model: { judge: false }, // deterministic-pipeline test — no AI judge
      report: { dir: `vigil-report-test-${Date.now()}` },
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("flags the page that fetched real data but rendered a stale placeholder", () => {
    const broken = byPath(result, "/movies/broken");
    expect(broken?.status).toBe("warn");
    expect(broken?.fidelityWarnings).toBeDefined();
    expect(broken?.fidelityWarnings?.[0]).toContain("title");
    expect(broken?.fidelityWarnings?.[0]).toContain("A Common Man");
  });

  it("leaves the correctly-rendering page clean", () => {
    const correct = byPath(result, "/movies/correct");
    expect(correct?.status).toBe("pass");
    expect(correct?.fidelityWarnings).toBeUndefined();
  });
}, 40_000);
