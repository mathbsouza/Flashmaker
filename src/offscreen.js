import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import JSZip from 'jszip';
import {
  buildImageName,
  buildZipName,
  getPaddingWidth,
  parsePageRange,
  sanitizeBaseName,
} from './shared.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

const MAX_CANVAS_PIXELS = 90_000_000;
const pendingDownloadUrls = new Set();
let activeJobId = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'offscreen') {
    return;
  }

  if (message.type === 'PROCESS_PDF') {
    void processPdf(message.payload);
  }

  if (message.type === 'REVOKE_DOWNLOAD_URL') {
    revokeDownloadUrl(message.payload?.downloadUrl);
  }
});

async function processPdf(payload) {
  let loadingTask = null;
  let pdf = null;

  if (activeJobId) {
    emitError(payload?.jobId, 'Ja existe um processamento em andamento.');
    return;
  }

  activeJobId = payload?.jobId ?? crypto.randomUUID();

  try {
    const pdfUrl = payload?.pdfUrl;
    if (!pdfUrl) {
      throw new Error('URL do PDF nao encontrada.');
    }

    emitStatus('Abrindo PDF...', 8, 'PDF.js');
    ({ loadingTask, pdf } = await openPdf(pdfUrl));

    const totalPages = pdf.numPages;
    const selectedPages = parsePageRange(payload.pageStart, payload.pageEnd, totalPages);
    const baseName = sanitizeBaseName(payload.baseName);
    const dpi = normalizeDpi(payload.dpi);
    const scale = dpi / 72;
    const paddingWidth = getPaddingWidth(totalPages);
    const zip = new JSZip();

    for (let index = 0; index < selectedPages.length; index += 1) {
      const pageNumber = selectedPages[index];
      const progress = 12 + Math.round((index / selectedPages.length) * 76);
      const countText = `${index + 1} de ${selectedPages.length}`;

      emitStatus(`Renderizando pagina ${pageNumber}...`, progress, countText);
      await yieldToBrowser();

      const imageBytes = await renderPageToJpeg(pdf, pageNumber, scale, {
        progress,
        countText,
      });
      zip.file(buildImageName(baseName, pageNumber, paddingWidth), imageBytes);

      await yieldToBrowser();
    }

    emitStatus('Montando ZIP...', 92, 'ZIP');
    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'STORE',
    });

    const downloadName = buildZipName(baseName);
    const downloadUrl = URL.createObjectURL(zipBlob);
    pendingDownloadUrls.add(downloadUrl);

    chrome.runtime.sendMessage({
      target: 'background',
      type: 'DOWNLOAD_ZIP',
      payload: {
        jobId: activeJobId,
        downloadName,
        downloadUrl,
      },
    });
  } catch (error) {
    emitError(activeJobId, getErrorMessage(error));
  } finally {
    await cleanupPdf(pdf, loadingTask);
    activeJobId = null;
  }
}

async function openPdf(pdfUrl) {
  if (isFileUrl(pdfUrl)) {
    return openPdfFromArrayBuffer(pdfUrl, 'Arquivo local');
  }

  const loadingTask = pdfjsLib.getDocument({
    url: pdfUrl,
    withCredentials: true,
    rangeChunkSize: 1024 * 1024,
    useWorkerFetch: true,
    isOffscreenCanvasSupported: true,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
  });

  loadingTask.onProgress = ({ loaded, total }) => {
    emitStatus('Lendo PDF...', mapLoadProgress(loaded, total), formatLoadProgress(loaded, total));
  };

  try {
    return {
      loadingTask,
      pdf: await loadingTask.promise,
    };
  } catch {
    await loadingTask.destroy().catch(() => {});
    return openPdfFromArrayBuffer(pdfUrl, 'Fallback completo');
  }
}

async function openPdfFromArrayBuffer(pdfUrl, label) {
  emitStatus('Carregando PDF...', 8, label);
  const data = await fetchPdfBytes(pdfUrl);
  emitStatus('Abrindo PDF...', 12, formatBytes(data.byteLength));

  const loadingTask = pdfjsLib.getDocument({
    data,
    isOffscreenCanvasSupported: true,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
  });

  return {
    loadingTask,
    pdf: await loadingTask.promise,
  };
}

async function fetchPdfBytes(pdfUrl) {
  const response = await fetch(pdfUrl, { credentials: 'include' });
  if (!response.ok && response.status !== 0) {
    throw new Error(`Nao foi possivel abrir o PDF (${response.status}).`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    emitStatus('Carregando PDF...', 12, formatLoadProgress(data.byteLength, total));
    return data;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    loaded += value.byteLength;
    emitStatus('Carregando PDF...', mapLoadProgress(loaded, total), formatLoadProgress(loaded, total));
    await yieldToBrowser();
  }

  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return data;
}

async function renderPageToJpeg(pdf, pageNumber, scale, details) {
  let page = null;
  let canvas = null;
  let renderTask = null;
  let renderTicker = null;

  try {
    emitStatus(`Abrindo pagina ${pageNumber}...`, details.progress, details.countText);
    page = await pdf.getPage(pageNumber);

    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);

    if (width * height > MAX_CANVAS_PIXELS) {
      throw new Error('Pagina grande demais para esse DPI. Reduza o DPI.');
    }

    emitStatus(`Preparando pagina ${pageNumber}...`, details.progress, `${width}x${height}`);
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Nao foi possivel criar canvas.');
    }

    canvas.width = width;
    canvas.height = height;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);

    emitStatus(`Renderizando pagina ${pageNumber}...`, details.progress, details.countText);
    const startedAt = performance.now();
    renderTicker = setInterval(() => {
      const elapsed = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
      emitStatus(`Renderizando pagina ${pageNumber}...`, details.progress, `${details.countText} - ${elapsed}s`);
    }, 2500);

    renderTask = page.render({
      canvasContext: context,
      viewport,
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      intent: 'print',
    });

    renderTask.onContinue = (continueRender) => {
      setTimeout(continueRender, 0);
    };

    await renderTask.promise;

    emitStatus(`Convertendo pagina ${pageNumber}...`, details.progress, details.countText);
    const imageBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    return await imageBlob.arrayBuffer();
  } catch (error) {
    renderTask?.cancel?.();
    throw error;
  } finally {
    if (renderTicker) {
      clearInterval(renderTicker);
    }

    page?.cleanup?.();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Falha ao converter pagina em JPG.'));
        return;
      }

      resolve(blob);
    }, type, quality);
  });
}

function normalizeDpi(value) {
  const dpi = Number(value);
  if (!Number.isInteger(dpi) || dpi < 1) {
    return 150;
  }

  return dpi;
}

function isFileUrl(value) {
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
}

async function cleanupPdf(pdf, loadingTask) {
  if (pdf?.cleanup) {
    await pdf.cleanup().catch(() => {});
  }

  if (loadingTask?.destroy) {
    await loadingTask.destroy().catch(() => {});
  }
}

function revokeDownloadUrl(downloadUrl) {
  if (!downloadUrl || !pendingDownloadUrls.delete(downloadUrl)) {
    return;
  }

  URL.revokeObjectURL(downloadUrl);
}

function emitStatus(message, progress, progressText) {
  chrome.runtime.sendMessage({
    type: 'CROPPDF_STATUS',
    jobId: activeJobId,
    message,
    progress,
    progressText,
  });
}

function emitError(jobId, message) {
  chrome.runtime.sendMessage({
    type: 'CROPPDF_ERROR',
    jobId,
    message,
  });
}

function mapLoadProgress(loaded, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return 10;
  }

  return 8 + Math.round(Math.max(0, Math.min(1, loaded / total)) * 4);
}

function formatLoadProgress(loaded, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return 'Lendo';
  }

  return `${formatBytes(loaded)} / ${formatBytes(total)}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Erro inesperado.';
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
