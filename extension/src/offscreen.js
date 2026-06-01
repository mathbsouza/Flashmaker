import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import JSZip from 'jszip';
import {
  buildZipName,
  parsePageRange,
} from './shared.js';
import {
  buildSourceTemplateContext,
  getSourceTemplate,
  renderSourceTemplate,
} from './source-templates.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

let activeJobId = null;
const MAX_CANVAS_PIXELS = 90_000_000;
const pendingDownloadUrls = new Set();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'offscreen') {
    return;
  }

  if (message.type === 'GENERATE_PROMPT') {
    void generatePrompt(message.payload);
  }

  if (message.type === 'REVOKE_DOWNLOAD_URL') {
    revokeDownloadUrl(message.payload?.downloadUrl);
  }
});

async function generatePrompt(payload) {
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
    const selectedPages = payload.allPages
      ? Array.from({ length: totalPages }, (_, index) => index + 1)
      : parsePageRange(payload.pageStart, payload.pageEnd, totalPages);
    const sourceName = String(payload.sourceName ?? '').trim();
    const sourceType = String(payload.sourceType ?? '').trim() || 'Outros';
    const imageIdentifier = String(payload.imageIdentifier ?? '').trim() || sourceName;
    const imageBaseName = buildTemplateImageBaseName(sourceType, sourceName, imageIdentifier);
    const pagePadding = Math.max(2, String(totalPages).length);
    const dpi = Number.isInteger(Number(payload.dpi)) && Number(payload.dpi) > 0
      ? Number(payload.dpi)
      : 150;
    const scale = dpi / 72;
    const pages = [];
    const zip = new JSZip();

    for (let index = 0; index < selectedPages.length; index += 1) {
      const pageNumber = selectedPages[index];
      const progress = 12 + Math.round((index / selectedPages.length) * 72);
      const countText = `${index + 1} de ${selectedPages.length}`;

      emitStatus(`Abrindo pagina ${pageNumber}...`, progress, countText);
      const page = await pdf.getPage(pageNumber);
      try {
        const visualPage = String(pageNumber).padStart(pagePadding, '0');
        const imageFileName = `${imageBaseName}-${visualPage}.jpg`;

        emitStatus(`Extraindo texto da pagina ${pageNumber}...`, progress + 1, countText);
        const text = await extractPageText(page);
        page.cleanup?.();

        await yieldToBrowser();
        emitStatus(`Renderizando pagina ${pageNumber}...`, progress + 3, `${countText} - ${dpi} DPI`);
        const imageBytes = await renderPageToJpeg(pdf, pageNumber, scale, {
          progress: progress + 3,
          countText,
        });

        emitStatus(`Adicionando imagem da pagina ${pageNumber} ao ZIP...`, progress + 5, imageFileName);
        zip.file(imageFileName, imageBytes);
        pages.push({
          pageNumber,
          visualPage,
          imageFileName,
          text,
        });
      } finally {
        page.cleanup?.();
      }
      await yieldToBrowser();
    }

    emitStatus('Preparando ZIP das imagens...', 88, `${pages.length} JPG`);
    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'STORE',
    });
    const imageZip = createDownloadBlob(zipBlob, buildZipName(imageBaseName));

    emitStatus('Montando prompts...', 94, 'Texto final');
    const prompts = buildPrompts({
      sourceName,
      imageBaseName,
      imageIdentifier,
      sourceType,
      bibliography: {
        authors: String(payload.sourceAuthors ?? '').trim(),
        year: String(payload.sourceYear ?? '').trim(),
        title: String(payload.sourceTitle ?? '').trim(),
        container: String(payload.sourceContainer ?? '').trim(),
      },
      totalPages,
      pageStart: selectedPages[0],
      pageEnd: selectedPages.at(-1),
      pages,
    });

    chrome.runtime.sendMessage({
      type: 'FLASHMARKER_DONE',
      jobId: activeJobId,
      message: 'Prompts prontos.',
      progress: 100,
      progressText: 'Concluido',
      payload: {
        ...prompts,
        promptData: {
          totalPages,
          pageStart: selectedPages[0],
          pageEnd: selectedPages.at(-1),
          pages,
        },
        imageZip,
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

async function extractPageText(page) {
  const textContent = await page.getTextContent();
  const rows = new Map();

  for (const item of textContent.items ?? []) {
    if (!('str' in item)) {
      continue;
    }

    const raw = String(item.str ?? '');
    const value = raw.replace(/\s+/g, ' ').trim();
    if (!value) {
      continue;
    }

    const x = Number(item.transform?.[4] ?? 0);
    const y = Number(item.transform?.[5] ?? 0);
    const key = String(Math.round(y / 2) * 2);
    const row = rows.get(key) ?? [];
    row.push({ x, value });
    rows.set(key, row);
  }

  const sortedRows = [...rows.entries()]
    .map(([key, row]) => ({ y: Number(key), row }))
    .sort((left, right) => right.y - left.y);

  const lines = sortedRows.map(({ row }) =>
    row
      .sort((left, right) => left.x - right.x)
      .map((part) => part.value)
      .join(' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim(),
  );

  return lines.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function renderPageToJpeg(pdf, pageNumber, scale, details) {
  let page = null;
  let canvas = null;
  let renderTask = null;
  let renderTicker = null;

  try {
    emitStatus(`Abrindo pagina ${pageNumber} para imagem...`, details.progress, details.countText);
    page = await pdf.getPage(pageNumber);

    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);

    if (width * height > MAX_CANVAS_PIXELS) {
      throw new Error('Pagina grande demais para esse DPI. Reduza a qualidade da imagem.');
    }

    emitStatus(`Preparando imagem da pagina ${pageNumber}...`, details.progress, `${width}x${height}`);
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
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error('Nao foi possivel gerar a imagem JPG.'));
    }, type, quality);
  });
}

function createDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  pendingDownloadUrls.add(url);
  return { filename, downloadUrl: url };
}

function revokeDownloadUrl(downloadUrl) {
  if (!downloadUrl || !pendingDownloadUrls.delete(downloadUrl)) {
    return;
  }

  URL.revokeObjectURL(downloadUrl);
}

function buildPrompts({
  sourceName,
  imageBaseName,
  imageIdentifier,
  sourceType,
  bibliography,
  totalPages,
  pageStart,
  pageEnd,
  pages,
}) {
  const sourceTitle = buildSourceTitle(sourceType, sourceName);
  const sourceLine = buildSourceLine({
    sourceType,
    sourceName,
    imageIdentifier,
    authors: bibliography.authors,
    year: bibliography.year,
    title: bibliography.title,
    container: bibliography.container,
  });
  const sourceHtmlTemplate = `<div class="quote">
    <div class="title">
        ${sourceTitle}
    </div>
    <hr>
    <div class="reference">
        <img src="${imageBaseName}-[PaginaVisual].jpg">
    </div>
    <hr>
    <div class="source">
        ${sourceLine}
    </div>
</div>`;
  const pageBlocks = pages
    .map((page) => {
      const excerpt = page.text.trim() || '[Sem texto extraido desta pagina]';
      return [
        `### PAGINA_VISUAL_${page.visualPage}`,
        `ARQUIVO_IMAGEM: ${page.imageFileName}`,
        'TEXTO_EXTRAIDO:',
        excerpt,
      ].join('\n');
    })
    .join('\n\n');

  const instructionPrompt = `
Voce e um especialista em flashcards para provas de residencia medica/R3.

Quando eu enviar o material, gere poucos flashcards BASIC em CSV, apenas com informacoes high-yield que precisem ser memorizadas. Priorize cortes, criterios, tempos, excecoes, indicacoes, contraindicoes, sequencias, testes de escolha, definicoes operacionais e detalhes literais de prova.

Evite:
- raciocinio clinico amplo;
- perguntas vagas;
- informacoes obvias ou dedutiveis;
- cards longos;
- inventar dados ausentes;
- misturar varios conceitos no mesmo card.

Formato do CSV:
PERGUNTA,DICA,RESPOSTA,EXPLICACAO,FONTE

Regras dos campos:
- Todos os campos devem conter HTML.
- PERGUNTA: direta, testando uma unica informacao, em HTML.
- DICA: curta, sem entregar a resposta, em HTML.
- RESPOSTA: em HTML, usando <p> ou <ul><li>.
- Em listas HTML, use ponto e virgula ao fim dos itens intermediarios e ponto final no ultimo item.
- EXPLICACAO: em HTML, preferencialmente <p>, com explicacao densa de cerca de 5 linhas.
- Na EXPLICACAO, va alem de repetir o material: contextualize com conhecimento medico consolidado, fisiopatologia, implicacao pratica ou motivo de prova.
- Nao comece a EXPLICACAO com frases como "No material", "O material diz", "Segundo o texto" ou equivalentes.
- A resposta cobrada deve estar presente no material; o conhecimento externo deve apenas explicar e contextualizar.
- FONTE: sempre HTML, gerada pela funcao fonte(paginaVisual).

Use este template uma unica vez para gerar a coluna FONTE:
${sourceHtmlTemplate}

Defina mentalmente ou em codigo:
fonte(paginaVisual) = template acima com [PaginaVisual] substituido por paginaVisual.

Regras da fonte:
- A unica parte variavel da fonte entre flashcards e [PaginaVisual].
- Use pagina visual do PDF/material, como 01, 02, 03.
- Nao coloque pagina no texto bibliografico da <div class="source">.
- O src da imagem deve ficar exatamente: ${imageBaseName}-[PaginaVisual].jpg.

Saida:
- Se tiver ferramenta de arquivos/Python disponivel, gere um arquivo chamado flashcards.csv e forneca o link para download.
- Para criar o arquivo, use uma lista de linhas e uma funcao fonte(paginaVisual), em vez de reescrever manualmente o HTML da fonte em cada linha.
- Use o modulo csv ou equivalente para escapar aspas corretamente.
- Se nao puder criar arquivo para download, entregue somente o CSV puro, sem comentarios.
- Cabecalho obrigatorio: PERGUNTA,DICA,RESPOSTA,EXPLICACAO,FONTE
`.trim();

  const contentPrompt = `
Gere agora o CSV a partir do material abaixo. Use somente informacoes presentes nas paginas fornecidas. Para cada card, escolha a pagina visual correspondente e gere FONTE com fonte(paginaVisual).

${pageBlocks}
`.trim();

  return {
    instructionPrompt,
    contentPrompt,
  };
}

async function cleanupPdf(pdf, loadingTask) {
  if (pdf?.cleanup) {
    await pdf.cleanup().catch(() => {});
  }

  if (loadingTask?.destroy) {
    await loadingTask.destroy().catch(() => {});
  }
}

function emitStatus(message, progress, progressText) {
  chrome.runtime.sendMessage({
    type: 'FLASHMARKER_STATUS',
    jobId: activeJobId,
    message,
    progress,
    progressText,
  });
}

function emitError(jobId, message) {
  chrome.runtime.sendMessage({
    type: 'FLASHMARKER_ERROR',
    jobId,
    message,
  });
}

function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'Fonte';
}

function buildSourceTitle(sourceType, sourceName) {
  const template = getSourceTemplate(sourceType);
  const context = buildSourceTemplateContext({ sourceType, sourceName });
  return renderSourceTemplate(template.materialTitleTemplate, context) || sourceName;
}

function buildSourceLine({ sourceType, sourceName, imageIdentifier, authors, year, title, container }) {
  const finalAuthors = String(authors ?? '').trim() || defaultAuthors(sourceType);
  const finalYear = String(year ?? '').trim() || defaultYear(sourceType);
  const finalTitle = defaultTitle(
    sourceType,
    String(title ?? '').trim() || sourceName,
    imageIdentifier,
  );
  const finalContainer = String(container ?? '').trim();
  const containerSuffix = finalContainer ? ` ${finalContainer}.` : '';
  return `${finalAuthors} (${finalYear}). <i>${finalTitle}</i>.${containerSuffix}`;
}

function defaultAuthors(sourceType) {
  const template = getSourceTemplate(sourceType);
  const context = buildSourceTemplateContext({ sourceType, sourceName: '' });
  return renderSourceTemplate(template.authorTemplate, context) || '[Autor nao informado]';
}

function defaultYear(sourceType) {
  return getSourceTemplate(sourceType).year || '[Ano nao informado]';
}

function defaultTitle(sourceType, sourceName, imageIdentifier = '') {
  const template = getSourceTemplate(sourceType);
  const context = buildSourceTemplateContext({ sourceType, sourceName, imageIdentifier });
  return renderSourceTemplate(template.documentNameTemplate, context) || sourceName;
}

function buildTemplateImageBaseName(sourceType, sourceName, imageIdentifier) {
  const template = getSourceTemplate(sourceType);
  const context = buildSourceTemplateContext({ sourceType, sourceName, imageIdentifier });
  const tag = renderSourceTemplate(template.tagTemplate, context) || `Med_${sourceType}`;
  const referenceImage = renderSourceTemplate(template.referenceImageTemplate, context) || imageIdentifier || sourceName;
  return `${tag}_${slugify(referenceImage)}`;
}

function mapLoadProgress(loaded, total) {
  if (!total) {
    return 10;
  }

  return Math.max(8, Math.min(26, Math.round((loaded / total) * 24)));
}

function formatLoadProgress(loaded, total) {
  if (!total) {
    return formatBytes(loaded);
  }

  return `${formatBytes(loaded)} / ${formatBytes(total)}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function isFileUrl(value) {
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
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
