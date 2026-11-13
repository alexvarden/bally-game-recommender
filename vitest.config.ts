import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "coverage/**"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.ts", "evals/**/*.ts", ".claude/skills/**/scripts/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary", "json", "html"],
      // Keep in step with CLAUDE.md.
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 },
    },
  },
});
