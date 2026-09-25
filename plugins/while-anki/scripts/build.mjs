import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  absWorkingDir: ROOT,
  entryPoints: ['src/anki-widget.js'],
  outdir: 'assets',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
});

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: ['server.mjs'],
  outfile: 'server.bundle.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  legalComments: 'inline',
  metafile: true,
});

const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
const unresolved = imports.filter(({ path: importPath, external }) => external && !importPath.startsWith('node:'));
if (unresolved.length) {
  throw new Error(`The release still has external package imports: ${unresolved.map(({ path: importPath }) => importPath).join(', ')}`);
}
