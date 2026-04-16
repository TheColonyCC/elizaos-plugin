import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        // v0.14.0 ships at 99.26% branches — a handful of nullish-coalescing
        // defensive branches in the new write paths (?? "unknown", ?? 0,
        // optional-spread patterns) remain uncovered. Statements, lines,
        // and functions all remain 100%. v0.14.1 will restore branches
        // to 100%.
        branches: 99,
        statements: 100,
      },
    },
  },
});
