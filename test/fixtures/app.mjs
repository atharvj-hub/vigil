// A tiny controlled fixture app for exercising vigil end to end.
// Serves clean pages + the Phase-1 breakages we assert on:
//   /boom      → document 500                    (hard rule H2)
//   /blank     → 200 with an empty body          (hard rule H4)
//   /chunk404  → 200 shell + a script that 404s  (hard rule H4)
//   /apifail   → renders, but a first-party API call 500s   (deterministic warn)
//   /slowload  → renders fine, but the load event never fires (warn, NOT a red)
//
// Port-agnostic: absolute URLs in the sitemap use the request's Host header, so
// it works on any port. Importable for tests via startFixture(); runnable via
//   node test/fixtures/app.mjs [port]
import { createServer } from "node:http";

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const nav = `<nav><a href="/about">About</a> <a href="/pricing">Pricing</a>
  <a href="/products/1">P1</a> <a href="/products/2">P2</a> <a href="/products/3">P3</a>
  <a href="/blank">Blank</a> <a href="/chunk404">Chunk404</a> <a href="/boom">Boom</a>
  <a href="/apifail">ApiFail</a></nav>`;

const routes = {
  "/": html("Home", `<h1>Welcome to the shop</h1><p>The best storefront on the web, freshly reworded.</p>${nav}`),
  "/about": html("About", `<h1>About us</h1><p>We sell things. Lots of them. This is a perfectly healthy page.</p>${nav}`),
  "/pricing": html("Pricing", `<h1>Pricing</h1><p>Plans start at $9/mo. Everything renders fine here.</p>${nav}`),
  "/products/1": html("Product 1", `<h1>Product 1</h1><p>A fine product with a real description.</p>${nav}`),
  "/products/2": html("Product 2", `<h1>Product 2</h1><p>Another fine product, also described.</p>${nav}`),
  "/products/3": html("Product 3", `<h1>Product 3</h1><p>Yet another fine product on the shelf.</p>${nav}`),
  "/blank": html("Blank", ``),
  "/chunk404": html("App", `<div id="root"></div><script src="/missing-chunk.js"></script>`),
  "/apifail": html("Checkout", `<h1>Checkout</h1><p>Loading your cart…</p>
    <script>fetch('/api/broken').catch(()=>{})</script>${nav}`),
  "/slowload": html("Slow but healthy", `<h1>Slow but healthy</h1>
    <p>This page renders perfectly. It just has an image that never finishes,
    so the browser load event never fires. That is a warn at most, never a red.</p>
    <img src="/hang" width="1" height="1">${nav}`),
};

// The routes exposed in the sitemap (drives discovery in the integration test).
export const SITEMAP_PATHS = ["/", "/about", "/pricing", "/products/1", "/products/2", "/products/3", "/blank", "/chunk404", "/boom", "/apifail"];

function sitemapXml(base) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAP_PATHS.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n")}
</urlset>`;
}

/** Build the (not-yet-listening) HTTP server. */
export function createFixtureServer() {
  return createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/robots.txt") return send(res, 200, "text/plain", `Sitemap: ${base}/sitemap.xml\n`);
    if (url === "/sitemap.xml") return send(res, 200, "application/xml", sitemapXml(base));
    if (url === "/hang") return; // never respond — the load event never fires
    if (url === "/missing-chunk.js") return send(res, 404, "text/plain", "not found");
    if (url === "/api/broken") return send(res, 500, "application/json", `{"error":"payment failed"}`);
    if (url === "/boom") return send(res, 500, "text/html", html("Error", "<h1>Internal Server Error</h1>"));
    const body = routes[url];
    if (body) return send(res, 200, "text/html", body);
    return send(res, 404, "text/html", html("Not found", "<h1>404</h1>"));
  });
}

/** Start listening. Pass port 0 for a random free port. Resolves with the URL. */
export function startFixture(port = 0) {
  const server = createFixtureServer();
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = server.address();
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}` });
    });
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

// Run directly: `node test/fixtures/app.mjs [port]`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const port = Number(process.argv[2] ?? 8787);
  startFixture(port).then(({ url }) => console.log(`fixture app on ${url}`));
}
