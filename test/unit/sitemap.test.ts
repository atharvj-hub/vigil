// Covers the two things sitemap.ts was recently fixed to handle on real sites:
// literal .gz sitemap files, and sitemap-index nesting deeper than one level.
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { discoverFromSitemap } from "../../src/discovery/sitemap.js";

function urlset(locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `<url><loc>${l}</loc></url>`).join("\n")}
</urlset>`;
}

function sitemapIndex(locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("\n")}
</sitemapindex>`;
}

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const base = `http://${req.headers.host}`;

    if (url === "/sitemap.xml") {
      // Root is an index pointing at a plain child AND a gzipped, deeper child.
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(sitemapIndex([`${base}/sitemaps/level1-plain.xml`, `${base}/sitemaps/level1-gz.xml.gz`]));
    }
    if (url === "/sitemaps/level1-plain.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(urlset([`${base}/about`, `${base}/pricing`]));
    }
    if (url === "/sitemaps/level1-gz.xml.gz") {
      // A level-2 index, itself gzipped — must recurse past depth 1 AND decompress.
      const body = gzipSync(Buffer.from(sitemapIndex([`${base}/sitemaps/level2.xml.gz`]), "utf8"));
      res.writeHead(200, { "content-type": "application/gzip" }); // no Content-Encoding header on purpose
      return res.end(body);
    }
    if (url === "/sitemaps/level2.xml.gz") {
      const body = gzipSync(Buffer.from(urlset([`${base}/products/1`, `${base}/products/2`]), "utf8"));
      res.writeHead(200, { "content-type": "application/gzip" });
      return res.end(body);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("discoverFromSitemap — gzip + nested indexes", () => {
  let server: Server;

  afterAll(() => {
    server?.close();
  });

  it("decompresses literal .gz sitemaps and follows indexes past one level deep", async () => {
    const started = await startServer();
    server = started.server;

    const result = await discoverFromSitemap(started.base);

    // Plain child's URLs
    expect(result.urls).toContain(`${started.base}/about`);
    expect(result.urls).toContain(`${started.base}/pricing`);
    // Gzipped level-1 child pointing at a gzipped level-2 child — both must be reached.
    expect(result.urls).toContain(`${started.base}/products/1`);
    expect(result.urls).toContain(`${started.base}/products/2`);
    // root index + plain child + gz child + gz grandchild = 4 documents fetched
    expect(result.sitemapsFetched).toBe(4);
  });
});
