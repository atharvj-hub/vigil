// A tiny controlled fixture app for exercising vigil end to end.
// Serves clean pages + the Phase-1 breakages we assert on:
//   /boom      → document 500                    (hard rule H2)
//   /blank     → 200 with an empty body          (hard rule H4)
//   /chunk404  → 200 shell + a script that 404s  (hard rule H4)
//   /apifail   → renders, but a first-party API call 500s   (deterministic warn)
//   /slowload  → renders fine, but the load event never fires (warn, NOT a red)
//   /dashboard?variant=clean|typo|brokenwidget   → the Phase-1-vs-Phase-2 probe:
//     clean         → three widgets render, all labels correct
//     typo          → same DOM shape, no errors, no failed requests — just a
//                     mislabeled widget heading ("Title" → "Heading"). Nothing
//                     in Signals changes; this is the class of bug that has no
//                     hard rule and no console/network trace — semantic-only,
//                     the reason Phase 2's judge exists.
//     brokenwidget  → the "Related Items" widget silently fails to mount: no
//                     console.error, no failed request, page settles clean.
//                     Everything else renders. Same story — no signal fires.
//   /product-api?variant=clean|renamed → the data-fidelity probe:
//     /api/product?variant=clean    → {"title": "..."}    (frontend reads d.title)
//     /api/product?variant=renamed  → {"heading": "..."}  (backend renamed the
//                     field; frontend was never updated — still reads d.title,
//                     gets undefined, renders an empty slot). No console error,
//                     no failed request, 200 all the way — checks.dataFidelity
//                     (configured with fields:["title"]) looks up contentFields
//                     BY THAT NAME, finds no "title" key in the renamed response,
//                     and treats it as "nothing to check" rather than a mismatch.
//
//   /products/old-slug-hard  → the old product route was fully removed after a
//                     slug rename (/products/1 → /products/wireless-headphones);
//                     hitting the old slug is a real HTTP 404. (H5 territory.)
//   /products/old-slug-soft  → same rename, but the app is an SPA with a
//                     catch-all route: unmatched paths still return 200 and
//                     render a "not found" UI client-side. Real text, no
//                     console error, no failed request — just a 200 that
//                     happens to say "not found".
//   /product-value?variant=clean|stale|wrongvalue → same field NAME, different
//                     VALUE problems, two very different flavors:
//     clean       → API returns {"price":99}, frontend renders 99. Match.
//     stale       → API returns {"price":99} (live, correct), but the
//                     frontend has a caching/race bug and displays a
//                     hardcoded stale "79" instead. This IS what
//                     checks.dataFidelity is built to catch: what the live
//                     API said vs what actually rendered, mismatched.
//     wrongvalue  → API itself returns bad data ({"price":79000}), and the
//                     frontend faithfully renders exactly what it was given
//                     ("79000"). No mismatch between API and render — the
//                     data itself is wrong, which is a business-logic /
//                     regression-testing question vigil has no ground truth
//                     to answer. Included to prove dataFidelity does NOT
//                     false-positive here.
//
// Port-agnostic: absolute URLs in the sitemap use the request's Host header, so
// it works on any port. Importable for tests via startFixture(); runnable via
//   node test/fixtures/app.mjs [port]
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

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
  // A genuinely healthy SPA page: the doc loads with an empty shell, network
  // goes quiet almost immediately (nothing else was fetched yet — the initial
  // network-quiet window fires in well under a second on a local server),
  // and only *after* that (calibrated to land between the pre-fix capture
  // point and the point the DOM-stability wait itself would time out on a
  // static shell) does a lazily-started fetch bring the real content in —
  // mirroring what afterSettle showed on a real site (requests that land
  // after the network-quiet window already fired). Reproduces the settle-gap
  // that motivated collector.ts's DOM-stability wait: a capture keyed on
  // network-quiet alone lands on the empty shell.
  "/spa-slow-render": html(
    "SPA",
    `<div id="root">Loading…</div>${nav}
     <script>
       setTimeout(() => {
         fetch('/api/spa-data').then((r) => r.json()).then((d) => {
           document.getElementById('root').textContent = d.text;
         });
       }, 1400);
     </script>`
  ),
  // The production bug found on a real client-rendered site: the shell is
  // COMPLETELY empty (0 chars) and perfectly static while the framework
  // bootstraps, then content appears well after the stability window would
  // otherwise have declared it settled. Without the looksUnrendered guard in
  // collector.ts the empty shell reads as "stable" and gets captured at ~2s,
  // producing a false H4 blank-render fail on a page that is entirely healthy.
  "/spa-empty-shell": html("SPA", `<div id="root"></div>
     <script>
       setTimeout(() => {
         document.getElementById('root').textContent =
           'The application finally finished bootstrapping and rendered its real content here.';
       }, 3000);
     </script>`),
  // Same idea, but the "before" and "after" text are the SAME length (both
  // exactly 28 chars, verified) — the exact class of change plain
  // text-length stability would miss: a spinner (class="spinner") is
  // swapped for real content of equal length, with nothing else in the DOM
  // changing size. Only the fingerprint's spinnerVisible field catches this.
  "/spa-same-length-swap": html(
    "SPA",
    `<div id="root" class="spinner">Loading placeholder text now</div>${nav}
     <script>
       setTimeout(() => {
         var el = document.getElementById('root');
         el.className = '';
         el.textContent = 'Real content has now mounted';
       }, 1400);
     </script>`
  ),
  // A genuinely healthy page, but a fresh browser context has no consent
  // state, so a first-visit cookie banner covers most of the viewport — the
  // exact real-world confound that motivated collector.ts's dismiss step.
  "/cookiegate": html(
    "Cookie-gated",
    `<h1>Welcome</h1><p>This page is completely healthy once the banner is gone.</p>${nav}
     <div id="consent" style="position:fixed;inset:0;background:#fff;z-index:999">
       <p>We use cookies.</p>
       <button aria-label="Accept all">Accept all</button>
     </div>
     <script>
       document.querySelector('#consent button').addEventListener('click', () => {
         document.getElementById('consent').remove();
       });
     </script>`
  ),
};

function dashboardHtml(variant) {
  const titleLabel = variant === "typo" ? "Heading" : "Title";
  const reviewsWidget = `<div class="widget widget-reviews"><h2>Reviews</h2><p>128 reviews · 4.6 average</p></div>`;
  const stockWidget = `<div class="widget widget-stock"><h2>Stock</h2><p>42 in stock</p></div>`;
  const relatedWidget = `<div class="widget widget-related"><h2>Related items</h2><p>3 related products</p></div>`;
  const widgets = variant === "brokenwidget" ? [reviewsWidget, stockWidget] : [reviewsWidget, stockWidget, relatedWidget];
  return html(
    "Dashboard",
    `<h1>Product Dashboard</h1><p>${titleLabel}: Wireless Headphones</p>
     <div class="widgets">${widgets.join("\n")}</div>${nav}`
  );
}

function productApiJson(variant) {
  return variant === "renamed"
    ? `{"heading":"Wireless Headphones","price":79}`
    : `{"title":"Wireless Headphones","price":79}`;
}

function productApiHtml(variant) {
  // Frontend was written against the original field name ("title") and never
  // updated — a realistic backend-renamed-the-field-and-frontend-lagged bug.
  // The script only ever reads d.title, so on the renamed variant the slot
  // renders empty: no exception (optional chaining-free but title is just
  // undefined -> textContent = "" is legal), no failed request, 200 status.
  return html(
    "Product",
    `<h1>Product</h1><div id="title-slot">(loading)</div><p>Price: $79</p>
     <script>
       fetch('/api/product?variant=${variant}')
         .then(r => r.json())
         .then(d => { document.getElementById('title-slot').textContent = d.title || ''; });
     </script>${nav}`
  );
}

function productValueJson(variant) {
  return variant === "wrongvalue" ? `{"price":79000}` : `{"price":99}`;
}

function productValueHtml(variant) {
  // "stale" ignores whatever the live API returned and renders a hardcoded
  // old value — simulating a cache/race bug where display desyncs from data.
  const script =
    variant === "stale"
      ? `document.getElementById('price-slot').textContent = '79';
         fetch('/api/product-value?variant=${variant}');` // still fetched (so it shows up as a matched response), just ignored
      : `fetch('/api/product-value?variant=${variant}')
           .then(r => r.json())
           .then(d => { document.getElementById('price-slot').textContent = String(d.price); });`;
  return html("Product", `<h1>Product</h1><p>Price: $<span id="price-slot">…</span></p><script>${script}</script>${nav}`);
}

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
    const fullUrl = new URL(req.url ?? "/", base);
    const url = fullUrl.pathname;
    if (url === "/robots.txt") return send(res, 200, "text/plain", `Sitemap: ${base}/sitemap.xml\n`);
    if (url === "/sitemap.xml") return send(res, 200, "application/xml", sitemapXml(base));
    if (url === "/hang") return; // never respond — the load event never fires
    if (url === "/missing-chunk.js") return send(res, 404, "text/plain", "not found");
    if (url === "/api/broken") return send(res, 500, "application/json", `{"error":"payment failed"}`);
    if (url === "/api/spa-data") {
      return send(
        res,
        200,
        "application/json",
        `{"text":"Real content has finally rendered here with plenty of text to prove the page is genuinely healthy."}`
      );
    }
    if (url === "/boom") return send(res, 500, "text/html", html("Error", "<h1>Internal Server Error</h1>"));
    if (url === "/dashboard") {
      const variant = fullUrl.searchParams.get("variant") ?? "clean";
      return send(res, 200, "text/html", dashboardHtml(variant));
    }
    if (url === "/product-api") {
      const variant = fullUrl.searchParams.get("variant") ?? "clean";
      return send(res, 200, "text/html", productApiHtml(variant));
    }
    if (url === "/api/product") {
      const variant = fullUrl.searchParams.get("variant") ?? "clean";
      return send(res, 200, "application/json", productApiJson(variant));
    }
    if (url === "/products/old-slug-hard") {
      return send(res, 404, "text/html", html("Not found", "<h1>404</h1>"));
    }
    if (url === "/product-value") {
      const variant = fullUrl.searchParams.get("variant") ?? "clean";
      return send(res, 200, "text/html", productValueHtml(variant));
    }
    if (url === "/api/product-value") {
      const variant = fullUrl.searchParams.get("variant") ?? "clean";
      return send(res, 200, "application/json", productValueJson(variant));
    }
    if (url === "/products/old-slug-soft") {
      return send(
        res,
        200,
        "text/html",
        html(
          "Product",
          `<h1>Product</h1><p>Sorry, we couldn't find that product. It may have been renamed or removed.</p>${nav}`
        )
      );
    }
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
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8787);
  startFixture(port).then(({ url }) => console.log(`fixture app on ${url}`));
}
