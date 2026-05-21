import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

const sharedBuildOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome109'],
  sourcemap: false,
  logLevel: 'info',
};

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await Promise.all([
  build({
    ...sharedBuildOptions,
    entryPoints: [path.join(srcDir, 'background.js')],
    outfile: path.join(distDir, 'background.js'),
  }),
  build({
    ...sharedBuildOptions,
    entryPoints: [path.join(srcDir, 'popup.js')],
    outfile: path.join(distDir, 'popup.js'),
  }),
  build({
    ...sharedBuildOptions,
    entryPoints: [path.join(srcDir, 'offscreen.js')],
    outfile: path.join(distDir, 'offscreen.js'),
  }),
]);

for (const file of ['manifest.json', 'popup.html', 'offscreen.html', 'styles.css']) {
  await copyFile(path.join(srcDir, file), path.join(distDir, file));
}

await copyFile(
  path.join(rootDir, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
  path.join(distDir, 'pdf.worker.min.mjs'),
);

console.log(`Build concluido em ${distDir}`);
