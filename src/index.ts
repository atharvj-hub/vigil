// Public API — what vigil promises to keep stable (documentation/07-library-api.md).

import { Vigil } from "./orchestrator.js";
import type { VigilConfig } from "./config.js";
import type { RunResult } from "./types.js";

export { Vigil } from "./orchestrator.js";
export { defineConfig, resolveConfig } from "./config.js";
export type { VigilConfig, ResolvedConfig } from "./config.js";
export * from "./types.js";

/**
 * The 90% case: discover, check, and report on a target in one call.
 *
 * ```ts
 * const result = await runSanity({ url: "https://app.example.com" });
 * if (result.verdict === "BROKEN") process.exit(1);
 * ```
 */
export async function runSanity(config: VigilConfig = {}): Promise<RunResult> {
  const vigil = await Vigil.create(config);
  return vigil.run();
}
