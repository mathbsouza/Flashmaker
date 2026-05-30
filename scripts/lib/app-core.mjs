import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const SOURCE_TYPES = ['Livro', 'Capitulo', 'Artigos', 'Guidelines', 'FRMW2026', 'AMW2026', 'UTD'];
export const DEFAULT_OUTPUT_DIR_NAME = 'flashmaker';

export async function discoverPdfFiles(projectRoot) {
  const searchRoots = [projectRoot, path.resolve(projectRoot, '..')];
  const seen = new Set();
  const found = [];

  for (const root of searchRoots) {
    await walkPdfFiles(root, 2, seen, found);
  }

  return found.sort((left, right) => left.localeCompare(right));
}

async function walkPdfFiles(root, depth, seen, found) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (['node_modules', 'output', '.git'].includes(entry.name)) {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) {
        await walkPdfFiles(fullPath, depth - 1, seen, found);
      }
      continue;
    }

    if (entry.isFile() && /\.pdf$/i.test(entry.name) && !seen.has(fullPath)) {
      seen.add(fullPath);
      found.push(fullPath);
    }
  }
}

export async function validatePdfPath(value) {
  const resolved = path.resolve(value);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    throw new Error('O caminho informado nao e um arquivo.');
  }
  if (!/\.pdf$/i.test(resolved)) {
    throw new Error('O arquivo precisa ser um PDF.');
  }
  return resolved;
}

export async function readPdfPageCount(pdfPath) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fileBytes = await readFile(pdfPath);
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(fileBytes),
    disableWorker: true,
    isOffscreenCanvasSupported: false,
  });

  try {
    const pdf = await loadingTask.promise;
    return pdf.numPages;
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export function deriveSourceNameFromFile(pdfPath) {
  return path.basename(pdfPath, path.extname(pdfPath))
    .replace(/^Med_[^_]+_/i, '')
    .replace(/-/g, ' ')
    .trim();
}

export function inferSourceType(fileName) {
  if (/^Med_FRMW2026_/i.test(fileName)) {
    return 'FRMW2026';
  }
  if (/^Med_AMW2026_/i.test(fileName)) {
    return 'AMW2026';
  }
  if (/^Med_UTD_/i.test(fileName)) {
    return 'UTD';
  }
  if (/^Med_Livro_/i.test(fileName) || /^Med_Livros_/i.test(fileName)) {
    return 'Livro';
  }
  if (/^Med_Capitulo_/i.test(fileName)) {
    return 'Capitulo';
  }
  if (/^Med_Guideline_/i.test(fileName) || /^Med_Guidelines_/i.test(fileName)) {
    return 'Guidelines';
  }
  return 'Artigos';
}

export function buildRunDirectoryName(sourceName) {
  return DEFAULT_OUTPUT_DIR_NAME;
}
