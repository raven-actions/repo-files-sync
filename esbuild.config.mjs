import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const outdir = 'dist';

// Clean dist directory
if (fs.existsSync(outdir)) {
  fs.rmSync(outdir, { recursive: true });
}

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: path.join(outdir, 'index.mjs'),
  minify: true,
  sourcemap: true,
  // Keep names for better error stack traces
  keepNames: true,
  // Banner to ensure proper ESM handling
  banner: {
    js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`.trim()
  },
  // External packages that should not be bundled (none for GitHub Actions - we want everything bundled)
  external: [],
  // Generate metadata for license information
  metafile: true,
  // Log level
  logLevel: 'info'
});

console.log('Build complete!');
