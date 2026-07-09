import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests drive a real browser; give hooks/tests room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Unit tests run in test/unit; integration in test/integration (see scripts).
    include: ["test/**/*.test.ts"],
  },
});
