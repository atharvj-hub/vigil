// Configuration — typed, zod-validated, and entirely optional.
// `url` (CLI-suppliable) is the only thing Phase 1 truly needs.
// Surface mirrors documentation/07-library-api.md.
//
// Phase-1 scope: `auth`, `flows`, and `model` are accepted and validated but not
// yet acted on (no browser login, no AI). They are in the schema now so config
// files written today keep working when Phase 2/3 land.

import { z } from "zod";
import type { Page } from "playwright";

// Regexes can't be expressed cleanly in zod's JSON world; accept instanceof.
const regex = z.instanceof(RegExp);

const DiscoverySchema = z
  .object({
    routes: z.array(z.string()).default([]),
    sitemap: z.boolean().default(true),
    crawl: z
      .object({
        enabled: z.boolean().default(true),
        depth: z.number().int().min(0).default(2),
        maxPages: z.number().int().min(0).default(100),
        politenessMs: z.number().int().min(0).default(0),
      })
      .default({}),
    include: z.array(z.string()).default(["/**"]),
    exclude: z.array(z.string()).default([]),
    samplesPerPattern: z.number().int().min(1).default(2),
    allowSubdomains: z.boolean().default(false),
  })
  .default({});

const AuthSchema = z
  .object({
    // The one function a vigil user may write — optional. Not run in Phase 1.
    login: z.custom<(page: Page) => Promise<void>>((v) => typeof v === "function").optional(),
    probeRoute: z.string().optional(),
    persistState: z.boolean().default(false),
  })
  .optional();

const FlowSchema = z.object({
  page: z.string(),
  name: z.string(),
  steps: z.array(z.string()).min(1),
});

const BudgetsSchema = z
  .object({
    maxPages: z.number().int().min(1).default(150),
    maxRunMinutes: z.number().min(0.1).default(10),
    maxModelCostUsd: z.number().min(0).default(2.0),
    concurrency: z.number().int().min(1).default(5),
    perPageVisitMs: z.number().int().min(1000).default(30_000),
  })
  .default({});

const ChecksSchema = z
  .object({
    latencyBudgetMs: z.number().int().min(0).default(5000),
    consoleErrorAllowlist: z.array(regex).default([]),
    errorMarkers: z.array(regex).default([]), // additions to the built-ins
    viewport: z
      .object({ width: z.number().int().default(1280), height: z.number().int().default(720) })
      .default({}),
    browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
  })
  .default({});

const SafetySchema = z
  .object({
    allowDestructive: z.boolean().default(false),
    denylistExtra: z.array(regex).default([]),
  })
  .default({});

const ReportSchema = z
  .object({
    dir: z.string().default("vigil-report"),
    keepRuns: z.number().int().min(1).default(10),
    // Reporter plugins are objects; "cli" is implicit. Kept loose for Phase 1.
    reporters: z.array(z.any()).default([]),
    failOn: z.enum(["broken", "degraded"]).default("broken"),
  })
  .default({});

export const ConfigSchema = z.object({
  url: z.string().url().optional(), // may come from CLI --url instead
  deployRef: z.string().optional(), // git SHA, shown in the report
  discovery: DiscoverySchema,
  auth: AuthSchema,
  flows: z.array(FlowSchema).default([]),
  // `model` accepts any AI SDK LanguageModel in Phase 2+. Loose for now.
  model: z.any().optional(),
  budgets: BudgetsSchema,
  checks: ChecksSchema,
  safety: SafetySchema,
  report: ReportSchema,
});

// The user-facing config type (all-optional). Input side of the schema.
export type VigilConfig = z.input<typeof ConfigSchema>;
// The fully-resolved config with all defaults applied. Output side.
export type ResolvedConfig = z.output<typeof ConfigSchema>;

/** Identity helper for type-checked config files: `export default defineConfig({...})`. */
export function defineConfig(config: VigilConfig): VigilConfig {
  return config;
}

/**
 * Validate + apply defaults. Throws a readable error (operational failure) on a
 * bad config. `url` may be supplied here to override/fill the config's own.
 */
export function resolveConfig(config: VigilConfig = {}, url?: string): ResolvedConfig {
  const merged = url ? { ...config, url } : config;
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid vigil config:\n${issues}`);
  }
  if (!parsed.data.url) {
    throw new Error("No target URL. Pass --url <url> or set `url` in vigil.config.ts.");
  }
  return parsed.data;
}
