import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

const pdfPath = process.argv[2] ?? 'Med_Livros_Harrisons-Principles-of-Internal-Medicine.pdf';
const pageNumber = Number.parseInt(process.argv[3] ?? '2979', 10);
const dpi = Number.parseInt(process.argv[4] ?? '150', 10);
const intent = process.argv[5] ?? 'print';
const scale = dpi / 72;

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const timeMarks = [];

function mark(label) {
  const now = performance.now();
  const previous = timeMarks.at(-1)?.time ?? now;
  timeMarks.push({ label, time: now });
  console.log(`${label}: ${((now - previous) / 1000).toFixed(2)}s`);
}

function startTicker(label) {
  const startedAt = performance.now();
  return setInterval(() => {
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    console.log(`${label}: ainda rodando (${elapsed}s)`);
  }, 5000);
}

console.log(`PDF: ${pdfPath}`);
console.log(`Pagina: ${pageNumber}`);
console.log(`DPI: ${dpi}`);
console.log(`Intent: ${intent}`);

mark('Inicio');
const data = new Uint8Array(await readFile(pdfPath));
mark(`Leitura do arquivo (${(data.byteLength / 1024 / 1024).toFixed(1)} MB)`);

const loadingTask = pdfjsLib.getDocument({
  data,
  CanvasFactory: NodeCanvasFactory,
  disableWorker: true,
  isOffscreenCanvasSupported: false,
  canvasMaxAreaInBytes: 32 * 1024 * 1024,
});

const pdf = await loadingTask.promise;
mark(`PDF aberto (${pdf.numPages} paginas)`);

const page = await pdf.getPage(pageNumber);
mark('Pagina carregada');

const viewport = page.getViewport({ scale });
const width = Math.ceil(viewport.width);
const height = Math.ceil(viewport.height);
const megapixels = ((width * height) / 1_000_000).toFixed(2);
console.log(`Canvas: ${width}x${height} (${megapixels} MP)`);

const canvasFactory = new NodeCanvasFactory();
const canvasAndContext = canvasFactory.create(width, height);
canvasAndContext.context.fillStyle = '#ffffff';
canvasAndContext.context.fillRect(0, 0, width, height);
mark('Canvas criado');

const ticker = startTicker('Render');
const renderTask = page.render({
  canvasContext: canvasAndContext.context,
  viewport,
  canvasFactory,
  annotationMode: pdfjsLib.AnnotationMode.DISABLE,
  intent,
});

let continueCount = 0;
renderTask.onContinue = (continueRender) => {
  continueCount += 1;
  setTimeout(continueRender, 0);
};

await renderTask.promise;
clearInterval(ticker);
mark(`Render concluido (${continueCount} pausas)`);

const jpg = canvasAndContext.canvas.toBuffer('image/jpeg', 0.92);
mark(`JPEG gerado (${(jpg.byteLength / 1024 / 1024).toFixed(2)} MB)`);

page.cleanup?.();
await pdf.cleanup?.();
await loadingTask.destroy?.();
canvasFactory.destroy(canvasAndContext);
mark('Limpeza');
