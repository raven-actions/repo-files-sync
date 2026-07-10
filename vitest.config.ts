import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // JUnit is a test-results reporter (not a coverage reporter); emit it to a
    // file so Codecov Test Analytics can ingest it via report_type: test_results.
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './junit.xml'
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // Entry point with side effects
        'src/types.ts' // Pure type definitions, no runtime code
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
