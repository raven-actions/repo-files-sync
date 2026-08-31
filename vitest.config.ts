import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The release scripts under .github/scripts are plain ESM JavaScript, so
    // their suites are .mjs too - that keeps them out of the TypeScript project
    // and avoids needing `allowJs` just to import them.
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.mjs'
    ],
    // JUnit is a test-results reporter (not a coverage reporter); emit it to a
    // file so Codecov Test Analytics can ingest it via report_type: test_results.
    reporters: [
      'default',
      'junit'
    ],
    outputFile: {
      junit: './junit.xml'
    },
    coverage: {
      provider: 'v8',
      reporter: [
        'text',
        'json',
        'html',
        'lcov'
      ],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // Thin bootstrap; the orchestration it calls lives in run.ts
        'src/types.ts' // Pure type definitions, no runtime code
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
