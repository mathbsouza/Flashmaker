import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import {
  parsePageRange,
} from './shared.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

let activeJobId = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'offscreen') {
    return;
  }

  if (message.type === 'GENERATE_PROMPT') {
    void generatePrompt(message.payload);
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
    const selectedPages = parsePageRange(payload.pageStart, payload.pageEnd, totalPages);
    const sourceName = String(payload.sourceName ?? '').trim();
    const sourceType = String(payload.sourceType ?? '').trim() || 'Artigos';
    const sourceSlug = slugify(sourceName);
    const pagePadding = Math.max(2, String(totalPages).length);
    const pages = [];

    for (let index = 0; index < selectedPages.length; index += 1) {
      const pageNumber = selectedPages[index];
      const progress = 12 + Math.round((index / selectedPages.length) * 76);
      const countText = `${index + 1} de ${selectedPages.length}`;

      emitStatus(`Extraindo pagina ${pageNumber}...`, progress, countText);
      const page = await pdf.getPage(pageNumber);
      try {
        const text = await extractPageText(page);
        pages.push({
          pageNumber,
          visualPage: String(pageNumber).padStart(pagePadding, '0'),
          imageFileName: `Med_${sourceType}_${sourceSlug}-${String(pageNumber).padStart(pagePadding, '0')}.jpg`,
          text,
        });
      } finally {
        page.cleanup?.();
      }
    }

    emitStatus('Montando prompt...', 94, 'Texto final');
    const prompt = buildPrompt({
      theme: String(payload.theme ?? '').trim(),
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
      message: 'Prompt pronto.',
      progress: 100,
      progressText: 'Concluido',
      payload: {
        prompt,
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

  return {
    loadingTask,
    pdf: await loadingTask.promise,
  };
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

function buildPrompt({
  theme,
  sourceName,
  sourceSlug,
  sourceType,
  bibliography,
  totalPages,
  pageStart,
  pageEnd,
  pages,
}) {
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

  return `
Você é um especialista em educação médica e criação de flashcards para provas de residência médica/R3.

Vou enviar um artigo, guideline, capítulo, resumo, ficha-resumo, apostila ou material de estudo em PDF ou texto. Sua tarefa é gerar um arquivo CSV com poucos flashcards do tipo BASIC, voltados exclusivamente para MEMORIZAÇÃO intensiva de itens high-yield.

TEMA DO DECK:
${theme}

OBJETIVO:
Criar flashcards apenas sobre informações que precisam ser decoradas para prova e que não seriam facilmente aprendidas apenas pela resolução de questões. Priorize dados objetivos, cortes, critérios, tempos, exceções, indicações formais, contraindicações, sequências terapêuticas, testes preferenciais, definições operacionais e detalhes fáceis de esquecer.

CONTEXTO DE ENTRADA:
- Tipo da fonte já determinado: ${sourceType}
- Source name obrigatório definido pelo usuário: ${sourceName}
- Identificador obrigatório para o nome das imagens: ${sourceSlug}
- Referência bibliográfica base definida pelo usuário:
  - Autores/sociedade: ${bibliography.authors || '[Autor não informado]'}
  - Ano: ${bibliography.year || '[Ano não informado]'}
  - Título completo: ${bibliography.title || sourceName}
  - Periódico/livro/instituição: ${bibliography.container || '[Fonte não informada]'}
- Páginas visuais selecionadas do PDF: ${pageStart}-${pageEnd}
- Total de páginas do PDF: ${totalPages}

REGRA ADICIONAL OBRIGATÓRIA SOBRE SOURCE NAME:
- Use o source name definido pelo usuário como base obrigatória do título padronizado da fonte e do identificador [TituloOuIdentificador].
- Não substitua esse nome por outro mais curto.
- Preserve o source name como referência principal mesmo se o PDF trouxer outro título interno, exceto quando as regras especiais de FRMW2026, AMW2026 ou UTD exigirem prefixos específicos.
- Para o campo <img src="">, use obrigatoriamente o identificador ${sourceSlug}.

FORMATO OBRIGATÓRIO DO CSV:
PERGUNTA,DICA,RESPOSTA,EXPLICAÇÃO,FONTE

REGRAS GERAIS:
- Gere poucos flashcards.
- Cada flashcard deve testar uma única informação principal.
- Os flashcards devem ser do tipo BASIC.
- A pergunta deve ser direta.
- A dica deve ajudar sem entregar a resposta.
- A resposta deve ser objetiva e curta.
- A explicação deve ser breve, focada no motivo pelo qual o item é relevante para prova.
- Use linguagem médica precisa.
- Evite cards de raciocínio clínico amplo.
- Evite perguntas vagas como “qual a conduta?” sem cenário específico.
- Não crie cards sobre informações óbvias, intuitivas ou facilmente dedutíveis.
- Não crie cards excessivamente longos.
- Não invente informações que não estejam no material enviado.
- Não misture múltiplos conceitos independentes no mesmo card.
- Não gere cards apenas para aumentar volume.
- Se o material tiver pouca coisa realmente memorizável dentro do tema definido, gere poucos cards ou até nenhum.
- Restrinja os flashcards ao TEMA DO DECK. Ignore informações fora do tema, mesmo que sejam high-yield.

REGRAS DE HTML:
- Todos os campos do CSV podem conter HTML.
- A RESPOSTA deve estar sempre em HTML.
- A RESPOSTA pode usar <p> ou <ul>, mas deve ser sempre direta.
- Use <p> para respostas curtas.
- Use <ul><li>...</li></ul> apenas quando a resposta exigir lista.
- A EXPLICAÇÃO também deve estar em HTML, preferencialmente em <p>.
- A FONTE deve estar obrigatoriamente em HTML.
- Escape aspas duplas internas conforme necessário para manter o CSV válido.

MODELO OBRIGATÓRIO DA FONTE:
<div class="quote">
    <div class="title">
        [Título padronizado da fonte]
    </div>
    <hr>
    <div class="reference">
        <img src="Med_[TipoDaFonte]_[TituloOuIdentificador]-[PaginaVisual].jpg">
    </div>
    <hr>
    <div class="source">
        [Autores ou sociedade responsável]. ([Ano]). <i>[Título completo]</i>. [Periódico, livro, guideline, sociedade, editora ou instituição, se disponível].
    </div>
</div>

REGRAS PARA PREENCHER A FONTE:
- Cite a fonte em todos os flashcards.
- Use como base prioritária os dados bibliográficos definidos pelo usuário acima.
- Não coloque página no texto da referência bibliográfica.

SAÍDA:
- Gere um arquivo .csv válido.
- Use codificação UTF-8.
- A primeira linha deve ser o cabeçalho:
PERGUNTA,DICA,RESPOSTA,EXPLICAÇÃO,FONTE
- Cada flashcard deve ocupar uma linha.
- Coloque todos os campos entre aspas duplas.
- Escape aspas duplas internas duplicando-as.
- Não escreva comentários fora do CSV.
- Não explique o que você fez; entregue apenas o CSV.

Agora gere o CSV a partir do material abaixo. Use somente informações presentes nas páginas fornecidas.

${pageBlocks}
`.trim();
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

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Erro inesperado.';
}
