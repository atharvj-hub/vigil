// Proves the actual mechanism end to end: a GraphQL endpoint (introspection +
// a list query) and an OpenAPI doc (spec + a list endpoint) each expose a page
// that is neither linked anywhere nor in any sitemap — plus one "poison" slug
// each source returns that has NO real page behind it, proving the HEAD/GET
// confirmation step silently drops unconfirmed guesses instead of trusting them.
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { discoverViaSchema } from "../../src/discovery/schemaProbe.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const GRAPHQL_SCHEMA = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      types: [
        {
          name: "Query",
          kind: "OBJECT",
          fields: [
            {
              name: "movies",
              args: [{ name: "first", type: { kind: "SCALAR", ofType: null } }],
              type: {
                name: null,
                kind: "NON_NULL",
                ofType: { name: null, kind: "LIST", ofType: { name: null, kind: "NON_NULL", ofType: { name: "Movie", kind: "OBJECT" } } },
              },
            },
          ],
        },
        {
          name: "Movie",
          kind: "OBJECT",
          fields: [
            { name: "slug", type: { name: "String", kind: "SCALAR", ofType: null } },
            { name: "title", type: { name: "String", kind: "SCALAR", ofType: null } },
          ],
        },
      ],
    },
  },
};

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "POST" && url === "/graphql") {
      const body = await readBody(req);
      if (body.includes("__schema")) return json(res, 200, GRAPHQL_SCHEMA);
      if (body.includes("movies")) {
        // one real slug the app actually serves, one "poison" slug it does not.
        return json(res, 200, { data: { movies: [{ slug: "hidden-gem-1" }, { slug: "poison-gql" }] } });
      }
      return json(res, 400, { errors: [{ message: "unexpected query" }] });
    }

    if (req.method === "GET" && url === "/openapi.json") {
      return json(res, 200, { openapi: "3.0.0", paths: { "/api/movies": { get: {} } } });
    }
    if (req.method === "GET" && url === "/api/movies") {
      return json(res, 200, [{ slug: "rest-hidden-1" }, { slug: "poison-rest" }]);
    }

    // Real pages the "app" happens to serve — some linked/known, some only
    // discoverable via the two API sources above, and the poison ones 404.
    const realPages = new Set(["/movies/known-movie", "/movies/hidden-gem-1", "/movies/rest-hidden-1"]);
    if (req.method === "GET" || req.method === "HEAD") {
      if (realPages.has(url)) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<h1>a real movie page</h1>");
      }
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("discoverViaSchema — GraphQL + OpenAPI hybrid", () => {
  let server: Server;
  afterAll(() => server?.close());

  it("finds pages via both sources and drops unconfirmed guesses silently", async () => {
    const started = await startServer();
    server = started.server;

    // Seed knowledge with one already-discovered page — this is what teaches
    // the module the "/movies/:slug" template. Short slug ("known-movie", 11
    // chars) deliberately mirrors real short content slugs like "a-common-man".
    const known = [`${started.base}/movies/known-movie`];

    const result = await discoverViaSchema(started.base, known, { maxCandidates: 40, timeoutMs: 5000 });

    expect(result.graphqlEndpoint).toBe(`${started.base}/graphql`);
    expect(result.openapiEndpoint).toBe(`${started.base}/openapi.json`);

    const urls = result.pages.map((p) => p.url);
    expect(urls).toContain(`${started.base}/movies/hidden-gem-1`); // via GraphQL
    expect(urls).toContain(`${started.base}/movies/rest-hidden-1`); // via OpenAPI
    expect(urls).not.toContain(`${started.base}/movies/poison-gql`); // guessed, never confirmed
    expect(urls).not.toContain(`${started.base}/movies/poison-rest`);

    // Exactly the two real pages were confirmed, out of the (up to) four guesses.
    expect(result.candidatesConfirmed).toBe(2);
    expect(result.pages.every((p) => p.source === "api")).toBe(true);
    expect(result.pages.find((p) => p.url.endsWith("hidden-gem-1"))?.patternGroup).toBe("/movies/:slug");
  });

  it("returns nulls and no pages when neither endpoint exists", async () => {
    const empty = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => empty.listen(0, "127.0.0.1", r));
    const addr = empty.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    const result = await discoverViaSchema(base, [`${base}/movies/known-movie`], { maxCandidates: 40, timeoutMs: 2000 });
    expect(result.graphqlEndpoint).toBeNull();
    expect(result.openapiEndpoint).toBeNull();
    expect(result.pages).toEqual([]);

    await new Promise<void>((r) => empty.close(() => r()));
  });
});
