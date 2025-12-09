import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // Entry point with side effects
        'src/git.ts', // Heavy GitHub API/git dependencies, needs integration tests
        'src/config.ts', // Initializes at module load time
        'src/types.ts' // Pure type definitions, no runtime code
      ]
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
