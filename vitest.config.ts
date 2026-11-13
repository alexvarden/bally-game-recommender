import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    // Agent worktrees live under .claude/worktrees; their tests belong to their own branches.
    exclude: ["node_modules/**", "coverage/**", ".claude/worktrees/**"],
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
