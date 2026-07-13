// Schema-driven discovery — the fourth discovery source (documentation/03).
//
// Problem: SPA "card" UIs (catalog grids, browse tiles) are often rendered from
// API data and navigated to via onClick handlers, not real <a href> links, so
// neither the sitemap nor the anchor-following crawler ever sees those pages.
//
// Instead of guessing at page structure from observed traffic, this asks the
// app's own API directly: probe for a GraphQL endpoint (introspection) and an
// OpenAPI/Swagger doc, and if either is exposed, call the specific "list this
// content type" operation each declares — a deliberate, documented, read-only
// call, not a heuristic. Slugs/ids that come back are matched against a URL
// pattern already confirmed real by the sitemap or crawl (e.g.
// "/ar/detail/movies/:slug"), and — as a last safety net — every generated
// candidate is confirmed with a cheap HEAD/GET before it's trusted. An
// unconfirmed guess is dropped silently, never reported as a page, so this can
// only ever ADD real pages, never invent a false "404 that must be a bug".
//
// Never mutates: GraphQL calls are always `query`, never `mutation`; REST calls
// are always GET. Both probes are best-effort and time-bounded — a missing or
// slow endpoint just means this source contributes nothing.

import type { DiscoveredPage } from "../types.js";
import { UUID, HEX_HASH } from "./normalize.js";

const SLUG_KEYS = /^(slug|permalink|urlSlug|seoSlug|contentSlug)$/i;
const ID_KEYS = /^(id|contentId|itemId|movieId|episodeId|assetId)$/i;
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+){1,8}$/; // "a-common-man" — not "true", "1", a bare word
const MAX_JSON_BYTES = 2_000_000;

export interface Identifiers {
  slugs: Set<string>;
  ids: Set<string>;
}

function emptyIdentifiers(): Identifiers {
  return { slugs: new Set(), ids: new Set() };
}

/** Recursively pull slug/id-shaped string or number values out of a parsed JSON value. */
function extractIdentifiers(node: unknown, out: Identifiers, depth = 0): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) extractIdentifiers(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (SLUG_KEYS.test(key) && SLUG_SHAPE.test(value)) out.slugs.add(value);
      else if (ID_KEYS.test(key) && /^[a-zA-Z0-9_-]{1,40}$/.test(value)) out.ids.add(value);
    } else if (typeof value === "number" && Number.isFinite(value) && ID_KEYS.test(key)) {
      out.ids.add(String(Math.trunc(value)));
    } else if (value && typeof value === "object") {
      extractIdentifiers(value, out, depth + 1);
    }
  }
}

async function fetchJson(url: string, opts: { timeoutMs: number; method?: string; body?: string }): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── GraphQL ──────────────────────────────────────────────────────────────────

const GRAPHQL_PATHS = ["/graphql", "/api/graphql", "/v1/graphql", "/graphql/v1"];

// "Lite" introspection: enough to find list-shaped Query fields and the
// scalar fields of what they return, without pulling the entire schema.
const INTROSPECTION_QUERY = `query VigilIntrospect {
  __schema {
    queryType { name }
    types {
      name
      kind
      fields {
        name
        args { name type { kind ofType { kind } } }
        type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      }
    }
  }
}`;

interface GqlTypeRef {
  name: string | null;
  kind: string;
  ofType: GqlTypeRef | null;
}
interface GqlField {
  name: string;
  args: { name: string; type: { kind: string; ofType: { kind: string } | null } }[];
  type: GqlTypeRef;
}
interface GqlNamedType {
  name: string;
  kind: string;
  fields: GqlField[] | null;
}

/** Unwrap NON_NULL/LIST wrappers to the named type underneath, noting if a LIST was seen. */
function unwrapType(ref: GqlTypeRef): { name: string | null; sawList: boolean } {
  let cur: GqlTypeRef | null = ref;
  let sawList = false;
  while (cur) {
    if (cur.kind === "LIST") sawList = true;
    if (cur.name) return { name: cur.name, sawList };
    cur = cur.ofType;
  }
  return { name: null, sawList };
}

/** A field vigil is willing to call: returns a list, and has no required (NON_NULL) args. */
function isSafeListField(field: GqlField): { name: string | null; sawList: boolean; pageArg: string | null } {
  const hasRequiredArg = field.args.some((a) => a.type?.kind === "NON_NULL");
  if (hasRequiredArg) return { name: null, sawList: false, pageArg: null };
  const { name, sawList } = unwrapType(field.type);
  const pageArg = field.args.find((a) => /^(first|limit|take|pageSize)$/i.test(a.name))?.name ?? null;
  return { name, sawList, pageArg };
}

export interface GraphqlProbeResult {
  endpoint: string;
  identifiers: Identifiers;
}

/** Probe common paths for an introspectable GraphQL endpoint and pull list-query data from it. */
export async function probeGraphQL(origin: string, timeoutMs: number): Promise<GraphqlProbeResult | null> {
  for (const path of GRAPHQL_PATHS) {
    const endpoint = new URL(path, origin).toString();
    const introspection = await fetchJson(endpoint, {
      timeoutMs,
      method: "POST",
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    });
    const schema = introspection?.data?.__schema;
    if (!schema?.queryType?.name) continue; // not GraphQL here, or introspection disabled

    const types: GqlNamedType[] = schema.types ?? [];
    const queryType = types.find((t) => t.name === schema.queryType.name);
    if (!queryType?.fields) continue;

    const identifiers = emptyIdentifiers();
    for (const field of queryType.fields) {
      const { name: typeName, sawList, pageArg } = isSafeListField(field);
      if (!typeName || !sawList) continue; // only flat lists of a named object type — Relay connections are a known gap
      const itemType = types.find((t) => t.name === typeName);
      const itemFields = itemType?.fields ?? [];
      const slugField = itemFields.find((f) => SLUG_KEYS.test(f.name));
      const idField = itemFields.find((f) => ID_KEYS.test(f.name) || f.name === "id");
      const pickField = slugField ?? idField;
      if (!pickField) continue; // this list type has nothing we could turn into a URL

      const args = pageArg ? `(${pageArg}: 50)` : "";
      const query = `query VigilList { ${field.name}${args} { ${pickField.name} } }`;
      const result = await fetchJson(endpoint, { timeoutMs, method: "POST", body: JSON.stringify({ query }) });
      const items = result?.data?.[field.name];
      if (Array.isArray(items)) extractIdentifiers(items, identifiers);
    }
    if (identifiers.slugs.size > 0 || identifiers.ids.size > 0) return { endpoint, identifiers };
    return { endpoint, identifiers }; // schema found, even if nothing usable came back — still worth reporting
  }
  return null;
}

// ── OpenAPI ──────────────────────────────────────────────────────────────────

const OPENAPI_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/v2/api-docs",
  "/v3/api-docs",
  "/api-docs",
  "/api/openapi.json",
  "/api/swagger.json",
];
const MAX_LIST_ENDPOINTS = 15;

export interface OpenapiProbeResult {
  endpoint: string;
  identifiers: Identifiers;
}

/** Find a top-level array in a parsed REST response, however it's wrapped. */
function findArray(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

/** Probe common paths for an OpenAPI/Swagger doc and call its documented list (collection) endpoints. */
export async function probeOpenApi(origin: string, timeoutMs: number): Promise<OpenapiProbeResult | null> {
  for (const path of OPENAPI_PATHS) {
    const endpoint = new URL(path, origin).toString();
    const spec = await fetchJson(endpoint, { timeoutMs });
    const paths = spec?.paths;
    if (!spec || (!spec.openapi && !spec.swagger) || !paths || typeof paths !== "object") continue;

    const identifiers = emptyIdentifiers();
    const listPaths = Object.keys(paths)
      .filter((p) => paths[p]?.get && !p.includes("{"))
      .slice(0, MAX_LIST_ENDPOINTS);

    for (const p of listPaths) {
      const body = await fetchJson(new URL(p, origin).toString(), { timeoutMs });
      const arr = findArray(body);
      if (arr) extractIdentifiers(arr, identifiers);
    }
    return { endpoint, identifiers };
  }
  return null;
}

// ── Shared: identifiers → confirmed page URLs ───────────────────────────────

type PlaceholderKind = "slug" | "n" | "id" | "hash";

// Deliberately NOT reusing normalize.ts's pathPattern here: that function only
// treats a segment as a slug once it's over 24 chars (correct for its own job
// — collapseParametric mustn't mistake unrelated short static pages like
// "/about-us" for a parametric family). Real content slugs are often much
// shorter ("a-common-man"), so this module classifies purely by shape.
function classifySegmentKind(segment: string): PlaceholderKind | null {
  if (/^\d+$/.test(segment)) return "n";
  if (UUID.test(segment)) return "id";
  if (HEX_HASH.test(segment)) return "hash";
  if (SLUG_SHAPE.test(segment)) return "slug";
  return null;
}

/**
 * Learn "/prefix/:kind" templates from known URLs whose *last* path segment
 * looks like a slug/id — the common single-parameter detail-page shape.
 * Deliberately skips anything more structurally ambiguous than that.
 */
function singlePlaceholderPatterns(urls: string[]): Map<PlaceholderKind, Set<string>> {
  const byKind = new Map<PlaceholderKind, Set<string>>();
  for (const raw of urls) {
    let pathname: string;
    try {
      pathname = new URL(raw).pathname;
    } catch {
      continue;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    const last = segments[segments.length - 1]!;
    const kind = classifySegmentKind(last);
    if (!kind) continue;
    const pattern = "/" + [...segments.slice(0, -1), `:${kind}`].join("/");
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    byKind.get(kind)!.add(pattern);
  }
  return byKind;
}

/** Same classification, applied to a full URL — for labeling a confirmed candidate. */
function patternOf(url: string): string | undefined {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  const kind = classifySegmentKind(segments[segments.length - 1]!);
  if (!kind) return undefined;
  return "/" + [...segments.slice(0, -1), `:${kind}`].join("/");
}

async function confirmAlive(url: string, timeoutMs: number): Promise<boolean> {
  const tryOnce = async (method: "HEAD" | "GET"): Promise<number | null> => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { method, redirect: "follow", signal: ctrl.signal });
      clearTimeout(t);
      return res.status;
    } catch {
      return null;
    }
  };
  let status = await tryOnce("HEAD");
  if (status === null || status === 404 || status === 405 || status === 501) status = await tryOnce("GET");
  return status !== null && status < 400;
}

export interface SchemaDiscoveryResult {
  pages: DiscoveredPage[]; // confirmed-live only, source: "api"
  candidatesGenerated: number;
  candidatesConfirmed: number;
  graphqlEndpoint: string | null;
  openapiEndpoint: string | null;
}

/**
 * Run both probes, turn whatever identifiers they find into candidate page
 * URLs against patterns already confirmed by the sitemap/crawl, and confirm
 * each candidate is real before returning it.
 */
export async function discoverViaSchema(
  origin: string,
  knownUrls: string[],
  opts: { maxCandidates: number; timeoutMs: number }
): Promise<SchemaDiscoveryResult> {
  const [gql, rest] = await Promise.all([
    probeGraphQL(origin, opts.timeoutMs).catch(() => null),
    probeOpenApi(origin, opts.timeoutMs).catch(() => null),
  ]);

  const byKind = singlePlaceholderPatterns(knownUrls);
  const known = new Set(knownUrls);
  const toTry: string[] = [];
  const tryValue = (value: string) => {
    const kind = classifySegmentKind(value);
    if (!kind) return;
    for (const pattern of byKind.get(kind) ?? []) {
      const url = origin + pattern.replace(`:${kind}`, encodeURIComponent(value));
      if (!known.has(url) && !toTry.includes(url)) toTry.push(url);
    }
  };
  for (const result of [gql?.identifiers, rest?.identifiers]) {
    if (!result) continue;
    for (const s of result.slugs) tryValue(s);
    for (const id of result.ids) tryValue(id);
  }

  const capped = toTry.slice(0, opts.maxCandidates);
  const pages: DiscoveredPage[] = [];
  const CONCURRENCY = 5;
  let next = 0;
  const worker = async () => {
    while (next < capped.length) {
      const i = next++;
      const url = capped[i]!;
      if (await confirmAlive(url, opts.timeoutMs)) {
        pages.push({ url, source: "api", patternGroup: patternOf(url) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, capped.length) }, worker));

  return {
    pages,
    candidatesGenerated: capped.length,
    candidatesConfirmed: pages.length,
    graphqlEndpoint: gql?.endpoint ?? null,
    openapiEndpoint: rest?.endpoint ?? null,
  };
}
