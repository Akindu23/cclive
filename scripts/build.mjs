import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// The chart bundle is built first and inlined into the CLI as a string, so the page never loads it from a CDN.
const chart = await build({
  entryPoints: ['src/chart-entry.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
});
const chartJs = chart.outputFiles[0].text;

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  loader: { '.html': 'text' },
  banner: { js: '#!/usr/bin/env node' },
  define: { __CCLIVE_VERSION__: JSON.stringify(pkg.version), __CCLIVE_CHART_JS__: JSON.stringify(chartJs) },
  logLevel: 'info',
});
