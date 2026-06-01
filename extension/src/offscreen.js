import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import JSZip from 'jszip';
import {
  buildZipName,
  parsePageRange,
} from './shared.js';

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
    const sourceSlug = slugify(imageIdentifier);
    const imageBaseName = `Med_${sourceType}_${sourceSlug}`;
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

    emitStatus('Gerando ZIP das imagens...', 88, `${pages.length} JPG`);
    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'STORE',
    });
    await downloadBlob(zipBlob, buildZipName(imageBaseName));

    emitStatus('Montando prompts...', 94, 'Texto final');
    const prompts = buildPrompts({
      sourceName,
      sourceSlug,
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
      message: 'Prompts prontos e imagens baixadas.',
      progress: 100,
      progressText: 'Concluido',
      payload: prompts,
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

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  pendingDownloadUrls.add(url);
  const response = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'DOWNLOAD_FILE',
    payload: {
      filename,
      downloadUrl: url,
    },
  });

  if (!response?.ok) {
    revokeDownloadUrl(url);
    throw new Error(response?.message || 'Nao foi possivel baixar o ZIP de imagens.');
  }

  setTimeout(() => {
    revokeDownloadUrl(url);
  }, 60_000);
}

function revokeDownloadUrl(downloadUrl) {
  if (!downloadUrl || !pendingDownloadUrls.delete(downloadUrl)) {
    return;
  }

  URL.revokeObjectURL(downloadUrl);
}

function buildPrompts({
  sourceName,
  sourceSlug,
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
        <img src="Med_${sourceType}_${sourceSlug}-[PaginaVisual].jpg">
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
Voce e um especialista em educacao medica e criacao de flashcards para provas de residencia medica/R3.

Vou enviar um artigo, guideline, capitulo, resumo, ficha-resumo, apostila ou material de estudo em PDF ou texto. Sua tarefa e gerar um arquivo CSV com poucos flashcards do tipo BASIC, voltados exclusivamente para MEMORIZACAO intensiva de itens high-yield.

OBJETIVO:
Criar flashcards apenas sobre informacoes que precisam ser decoradas para prova e que nao seriam facilmente aprendidas apenas pela resolucao de questoes. Priorize dados objetivos, cortes, criterios, tempos, excecoes, indicacoes formais, contraindicacoes, sequencias terapeuticas, testes preferenciais, definicoes operacionais e detalhes faceis de esquecer.

CONTEXTO DE ENTRADA:
- Tipo da fonte ja determinado: ${sourceType}
- Source name obrigatorio definido pelo usuario: ${sourceName}
- Identificador obrigatorio para o nome das imagens: ${sourceSlug}
- Referencia bibliografica base definida pelo usuario:
  - Autores/sociedade: ${bibliography.authors || '[Autor nao informado]'}
  - Ano: ${bibliography.year || '[Ano nao informado]'}
  - Titulo do livro/artigo: ${bibliography.title || sourceName}
  - Periodico/Editora/Instituicao: ${bibliography.container || '[em branco]'}
- Paginas visuais selecionadas do PDF: ${pageStart}-${pageEnd}
- Total de paginas do PDF: ${totalPages}

REGRA ADICIONAL OBRIGATORIA SOBRE SOURCE NAME:
- Use o source name definido pelo usuario como base obrigatoria do titulo padronizado da fonte e do identificador [TituloOuIdentificador].
- Nao substitua esse nome por outro mais curto.
- Preserve o source name como referencia principal mesmo se o PDF trouxer outro titulo interno, exceto quando as regras especiais de FRMW2026, AMW2026 ou UTD exigirem prefixos especificos.
- Para o campo <img src="">, use obrigatoriamente o identificador ${sourceSlug}.

FORMATO OBRIGATORIO DO CSV:
PERGUNTA,DICA,RESPOSTA,EXPLICACAO,FONTE

REGRAS GERAIS:
- Gere poucos flashcards.
- Cada flashcard deve testar uma unica informacao principal.
- Os flashcards devem ser do tipo BASIC.
- A pergunta deve ser direta.
- A dica deve ajudar sem entregar a resposta.
- A resposta deve ser objetiva e curta.
- A explicacao deve ser breve, focada no motivo pelo qual o item e relevante para prova.
- Use linguagem medica precisa.
- Evite cards de raciocinio clinico amplo.
- Evite perguntas vagas como "qual a conduta?" sem cenario especifico.
- Nao crie cards sobre informacoes obvias, intuitivas ou facilmente dedutiveis.
- Nao crie cards excessivamente longos.
- Nao invente informacoes que nao estejam no material enviado.
- Nao misture multiplos conceitos independentes no mesmo card.
- Nao gere cards apenas para aumentar volume.
- Se o material tiver pouca coisa realmente memorizavel, gere poucos cards ou ate nenhum.

REGRAS DE HTML:
- Todos os campos do CSV podem conter HTML.
- A RESPOSTA deve estar sempre em HTML.
- A RESPOSTA pode usar <p> ou <ul>, mas deve ser sempre direta.
- Use <p> para respostas curtas.
- Use <ul><li>...</li></ul> apenas quando a resposta exigir lista.
- A EXPLICACAO tambem deve estar em HTML, preferencialmente em <p>.
- A FONTE deve estar obrigatoriamente em HTML.
- Escape aspas duplas internas conforme necessario para manter o CSV valido.

MODELO OBRIGATORIO DA FONTE:
${sourceHtmlTemplate}

REGRAS PARA PREENCHER A FONTE:
- Cite a fonte em todos os flashcards.
- Use como base prioritaria os dados bibliograficos definidos pelo usuario acima.
- Nao coloque pagina no texto da referencia bibliografica.
- Se Periodico/Editora/Instituicao estiver em branco, termine a fonte logo apos </i>. Nao invente nem repita a instituicao.
- Use exatamente o HTML acima como modelo base da FONTE.
- Nao reescreva titulo, autores, ano, titulo completo, instituicao, tipo da fonte nem identificador da imagem.
- A unica parte que deve mudar em cada flashcard e [PaginaVisual] dentro de <img src="">, trocando pelo numero visual correto da pagina, como 01, 02, 03.
- O valor dentro de <img src=""> deve ficar exatamente no formato Med_${sourceType}_${sourceSlug}-[PaginaVisual].jpg, alterando apenas [PaginaVisual].

SAIDA:
- Gere um arquivo .csv valido.
- Use codificacao UTF-8.
- A primeira linha deve ser o cabecalho:
PERGUNTA,DICA,RESPOSTA,EXPLICACAO,FONTE
- Cada flashcard deve ocupar uma linha.
- Coloque todos os campos entre aspas duplas.
- Escape aspas duplas internas duplicando-as.
- Nao escreva comentarios fora do CSV.
- Nao explique o que voce fez; entregue apenas o CSV.
`.trim();

  const contentPrompt = `
Agora gere o CSV a partir do material abaixo. Use somente informacoes presentes nas paginas fornecidas.

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
  if (sourceType === 'FRMW2026') {
    return `Ficha Resumo da Medway 2026: ${sourceName}`;
  }
  if (sourceType === 'AMW2026') {
    return `Apostila da Medway 2026: ${sourceName}`;
  }
  return sourceName;
}

function buildSourceLine({ sourceType, sourceName, authors, year, title, container }) {
  const finalAuthors = String(authors ?? '').trim() || defaultAuthors(sourceType);
  const finalYear = String(year ?? '').trim() || defaultYear(sourceType);
  const finalTitle = String(title ?? '').trim() || defaultTitle(sourceType, sourceName);
  const finalContainer = String(container ?? '').trim();
  const containerSuffix = finalContainer ? ` ${finalContainer}.` : '';
  return `${finalAuthors}. (${finalYear}). <i>${finalTitle}</i>.${containerSuffix}`;
}

function defaultAuthors(sourceType) {
  if (sourceType === 'FRMW2026' || sourceType === 'AMW2026') {
    return 'Medway';
  }
  return '[Autor nao informado]';
}

function defaultYear(sourceType) {
  if (sourceType === 'FRMW2026' || sourceType === 'AMW2026') {
    return '2026';
  }
  return '[Ano nao informado]';
}

function defaultTitle(sourceType, sourceName) {
  if (sourceType === 'FRMW2026') {
    return `Ficha Resumo da Medway 2026: ${sourceName}`;
  }
  if (sourceType === 'AMW2026') {
    return `Apostila da Medway 2026: ${sourceName}`;
  }
  return sourceName;
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
