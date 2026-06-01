import { build } from 'esbuild';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceTemplates } from '../scripts/lib/source-templates.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');
const generatedDir = path.join(srcDir, 'generated');

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
await mkdir(generatedDir, { recursive: true });

const sourceTemplates = await loadSourceTemplates(projectRoot);
await writeFile(
  path.join(generatedDir, 'source-templates.js'),
  `export const SOURCE_TEMPLATES = ${JSON.stringify(sourceTemplates, null, 2)};\n`,
  'utf8',
);

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
  path.join(projectRoot, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
  path.join(distDir, 'pdf.worker.min.mjs'),
);

console.log(`Build concluido em ${distDir}`);
