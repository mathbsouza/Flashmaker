import {
  deriveBaseNameFromPdfUrl,
  deriveBaseNameFromTitle,
  extractPdfUrlFromTabUrl,
  isLikelyPdfTab,
  safeDecodeURIComponent,
} from './shared.js';
import {
  buildSourceTemplateContext,
  getSourceTemplate,
  renderSourceTemplate,
  SOURCE_TYPE_OPTIONS,
} from './source-templates.js';

const DEFAULT_DPI = 150;
const SOURCE_TYPES = SOURCE_TYPE_OPTIONS.concat({ value: 'Outros', label: 'Outros' });

const elements = {
  pdfState: document.getElementById('pdfState'),
  pdfHint: document.getElementById('pdfHint'),
  sourceType: document.getElementById('sourceType'),
  dpi: document.getElementById('dpi'),
  sourceName: document.getElementById('sourceName'),
  imageIdentifier: document.getElementById('imageIdentifier'),
  sourceAuthors: document.getElementById('sourceAuthors'),
  sourceYear: document.getElementById('sourceYear'),
  sourceTitle: document.getElementById('sourceTitle'),
  sourceContainer: document.getElementById('sourceContainer'),
  pageStart: document.getElementById('pageStart'),
  pageEnd: document.getElementById('pageEnd'),
  allPages: document.getElementById('allPages'),
  runButton: document.getElementById('runButton'),
  downloadImagesButton: document.getElementById('downloadImagesButton'),
  copyInstructionPromptButton: document.getElementById('copyInstructionPromptButton'),
  copyContentPromptButton: document.getElementById('copyContentPromptButton'),
  sourcePreview: document.getElementById('sourcePreview'),
  instructionPromptOutput: document.getElementById('instructionPromptOutput'),
  contentPromptOutput: document.getElementById('contentPromptOutput'),
  statusText: document.getElementById('statusText'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
};

let currentPdfUrl = '';
let currentTabId = null;
let currentJobId = null;
let currentPdfBaseName = '';
let lastSettingsPdfBaseName = '';
let instructionPromptText = '';
let contentPromptText = '';
let promptData = null;
let imageZip = null;

document.addEventListener('DOMContentLoaded', () => {
  void initialize();
});

async function initialize() {
  fillSourceTypes();
  bindEvents();
  applySettings(await loadSettings());
  await refreshActivePdf();
}

function bindEvents() {
  elements.runButton.addEventListener('click', () => {
    void startPromptGeneration();
  });

  elements.copyInstructionPromptButton.addEventListener('click', () => {
    void copyPrompt(instructionPromptText, 'Gere o prompt de instrucoes antes de copiar.');
  });

  elements.copyContentPromptButton.addEventListener('click', () => {
    void copyPrompt(contentPromptText, 'Gere o prompt com conteudo antes de copiar.');
  });

  elements.downloadImagesButton.addEventListener('click', () => {
    void downloadImages();
  });

  elements.sourceType.addEventListener('change', () => {
    handleSourceTypeChange();
    syncDerivedSourceFields();
    persistSettings();
    updateSourcePreview();
  });

  elements.allPages.addEventListener('change', () => {
    syncPageRangeState();
    persistSettings();
  });

  for (const input of [
    elements.dpi,
    elements.imageIdentifier,
    elements.sourceAuthors,
    elements.sourceYear,
    elements.sourceTitle,
    elements.sourceContainer,
    elements.pageStart,
    elements.pageEnd,
  ]) {
    input.addEventListener('input', (event) => {
      syncDerivedSourceFields(event.target);
      persistSettings();
      updateSourcePreview();
      refreshGeneratedPrompts();
    });
    input.addEventListener('change', (event) => {
      syncDerivedSourceFields(event.target);
      persistSettings();
      updateSourcePreview();
      refreshGeneratedPrompts();
    });
  }

  chrome.tabs.onActivated.addListener(() => {
    void refreshActivePdf();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (currentJobId || !tab.active) {
      return;
    }

    if (
      tabId === currentTabId ||
      typeof changeInfo.url === 'string' ||
      typeof changeInfo.title === 'string' ||
      changeInfo.status === 'complete'
    ) {
      void refreshActivePdf();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.jobId && message.jobId !== currentJobId) {
      return;
    }

    if (message?.type === 'FLASHMARKER_STATUS') {
      setStatus(message.message ?? 'Processando...');
      setProgress(message.progress, message.progressText ?? '');
    }

    if (message?.type === 'FLASHMARKER_ERROR') {
      setStatus(message.message ?? 'Falha.');
      setProgress(0, '');
      setBusy(false);
      currentJobId = null;
    }

    if (message?.type === 'FLASHMARKER_DONE') {
      instructionPromptText = message.payload?.instructionPrompt ?? '';
      contentPromptText = message.payload?.contentPrompt ?? '';
      promptData = message.payload?.promptData ?? null;
      imageZip = message.payload?.imageZip ?? null;
      elements.instructionPromptOutput.value = instructionPromptText;
      elements.contentPromptOutput.value = contentPromptText;
      updateDownloadImagesButton();
      setStatus(message.message ?? 'Prompts prontos.');
      setProgress(100, message.progressText ?? 'Concluido');
      setBusy(false);
      currentJobId = null;
      void persistPrompts();
      void refreshActivePdf();
    }
  });
}

function fillSourceTypes() {
  elements.sourceType.innerHTML = SOURCE_TYPES
    .map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join('');
}

async function refreshActivePdf() {
  if (currentJobId) {
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !isLikelyPdfTab(tab.url)) {
      throw new Error('Abra um PDF.');
    }

    const pdfUrl = extractPdfUrlFromTabUrl(tab.url);
    if (!pdfUrl || pdfUrl.startsWith('chrome-extension://')) {
      throw new Error('URL do PDF nao encontrada.');
    }

    if (pdfUrl.startsWith('blob:')) {
      throw new Error('Blob PDF nao suportado. Abra o arquivo direto.');
    }

    currentPdfUrl = pdfUrl;
    currentTabId = tab.id ?? null;
    elements.runButton.disabled = false;

    const fileName = deriveBaseNameFromPdfUrl(pdfUrl) || deriveBaseNameFromTitle(tab.title) || 'PDF aberto';
    const inferredSourceType = inferSourceType(fileName);
    const inferredSourceName = humanizeBaseName(fileName);
    const shouldRefreshDerivedFields =
      lastSettingsPdfBaseName !== fileName ||
      currentPdfBaseName !== fileName;
    currentPdfBaseName = fileName;
    elements.pdfState.textContent = safeDecodeURIComponent(fileName);
    elements.pdfHint.textContent = pdfUrl.startsWith('file:') ? 'PDF local' : 'PDF remoto';

    if (shouldRefreshDerivedFields) {
      applyDefaults(inferredSourceType, inferredSourceName);
      instructionPromptText = '';
      contentPromptText = '';
      promptData = null;
      imageZip = null;
      elements.instructionPromptOutput.value = '';
      elements.contentPromptOutput.value = '';
      updateDownloadImagesButton();
      persistSettings();
      return;
    }

    if (!elements.imageIdentifier.value.trim()) {
      elements.imageIdentifier.value = inferImageIdentifier(fileName);
    }

    if (!getDocumentName()) {
      applyDefaults(inferSourceType(fileName), humanizeBaseName(fileName));
    }
  } catch (error) {
    currentPdfUrl = '';
    currentTabId = null;
    currentPdfBaseName = '';
    elements.runButton.disabled = true;
    elements.pdfState.textContent = 'Nenhum PDF selecionado';
    elements.pdfHint.textContent = getErrorMessage(error);
    setStatus('Pronto.');
    setProgress(0, '');
  }
}

function handleSourceTypeChange() {
  if (elements.sourceType.value === 'Outros') {
    clearSourceFields();
    return;
  }

  applyDefaults(elements.sourceType.value, getDocumentName());
}

function applyDefaults(sourceType, sourceName) {
  elements.sourceType.value = sourceType;
  setDocumentName(sourceName);
  elements.imageIdentifier.value = inferImageIdentifier(currentPdfBaseName || sourceName);
  elements.sourceAuthors.value = defaultAuthors(sourceType);
  elements.sourceYear.value = defaultYear(sourceType);
  elements.sourceContainer.value = defaultContainer(sourceType);
  updateSourcePreview();
}

function syncDerivedSourceFields(changedElement = null) {
  if (changedElement === elements.sourceTitle) {
    elements.sourceName.value = elements.sourceTitle.value.trim();
    return;
  }
  if (!elements.sourceTitle.value.trim() && elements.sourceName.value.trim()) {
    elements.sourceTitle.value = elements.sourceName.value.trim();
  }
  elements.sourceName.value = elements.sourceTitle.value.trim();
}

function getDocumentName() {
  return elements.sourceTitle.value.trim() || elements.sourceName.value.trim();
}

function setDocumentName(value) {
  const documentName = String(value ?? '').trim();
  elements.sourceName.value = documentName;
  elements.sourceTitle.value = documentName;
}

function clearSourceFields() {
  elements.sourceName.value = '';
  elements.imageIdentifier.value = '';
  elements.sourceAuthors.value = '';
  elements.sourceYear.value = '';
  elements.sourceTitle.value = '';
  elements.sourceContainer.value = '';
}

async function startPromptGeneration() {
  try {
    if (!currentPdfUrl) {
      throw new Error('Abra um PDF antes de gerar.');
    }

    const payload = {
      jobId: crypto.randomUUID(),
      pdfUrl: currentPdfUrl,
      imageIdentifier: elements.imageIdentifier.value.trim(),
      sourceType: elements.sourceType.value,
      dpi: parsePositiveInt(elements.dpi.value || DEFAULT_DPI, 'Qualidade da imagem'),
      sourceName: getDocumentName(),
      sourceAuthors: elements.sourceAuthors.value.trim(),
      sourceYear: elements.sourceYear.value.trim(),
      sourceTitle: getDocumentName(),
      sourceContainer: elements.sourceContainer.value.trim(),
      pageStart: parsePositiveInt(elements.pageStart.value, 'Pagina inicial'),
      pageEnd: parsePositiveInt(elements.pageEnd.value, 'Pagina final'),
      allPages: elements.allPages.checked,
    };

    if (!payload.sourceName) {
      throw new Error('Preencha Nome do Documento.');
    }

    if (!payload.imageIdentifier) {
      throw new Error('Preencha Identificador da imagem.');
    }

    if (!payload.allPages && payload.pageStart > payload.pageEnd) {
      throw new Error('Pagina inicial precisa ser menor ou igual a final.');
    }

    currentJobId = payload.jobId;
    instructionPromptText = '';
    contentPromptText = '';
    promptData = null;
    imageZip = null;
    elements.instructionPromptOutput.value = '';
    elements.contentPromptOutput.value = '';
    updateDownloadImagesButton();
    setBusy(true);
    setStatus('Preparando...');
    setProgress(4, '');
    await persistSettings();

    chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_PROMPT',
      payload,
    });
  } catch (error) {
    setStatus(getErrorMessage(error));
    setProgress(0, '');
    setBusy(false);
    currentJobId = null;
  }
}

async function copyPrompt(value, emptyMessage) {
  if (!value.trim()) {
    setStatus(emptyMessage);
    return;
  }

  await navigator.clipboard.writeText(value);
  setStatus('Prompt copiado.');
}

async function downloadImages() {
  if (!imageZip?.downloadUrl || !imageZip?.filename) {
    setStatus('Gere as imagens antes de baixar.');
    return;
  }

  const response = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'DOWNLOAD_FILE',
    payload: imageZip,
  });

  if (!response?.ok) {
    setStatus(response?.message || 'Nao foi possivel baixar as imagens.');
    return;
  }

  setStatus('Download das imagens iniciado.');
}

function updateSourcePreview() {
  const sourceName = getDocumentName() || '[Nome do Documento]';
  const sourceType = elements.sourceType.value || 'Outros';
  const pageValue = normalizePreviewPage(elements.pageStart.value || '1');
  const imageIdentifier = elements.imageIdentifier.value.trim() || inferImageIdentifier(currentPdfBaseName || sourceName);
  const imageBaseName = buildTemplateImageBaseName(sourceType, sourceName, imageIdentifier);
  const title = buildSourceTitle(sourceType, sourceName);
  const sourceLine = buildSourceLine({
    sourceType,
    sourceName,
    imageIdentifier,
    authors: elements.sourceAuthors.value.trim(),
    year: elements.sourceYear.value.trim(),
    title: getDocumentName(),
    container: elements.sourceContainer.value.trim(),
  });

  elements.sourcePreview.textContent = `<div class="quote">
    <div class="title">
        ${title}
    </div>
    <hr>
    <div class="reference">
        <img src="${imageBaseName}-${pageValue}.jpg">
    </div>
    <hr>
    <div class="source">
        ${sourceLine}
    </div>
</div>`;
}

function refreshGeneratedPrompts() {
  if (!promptData) {
    return;
  }

  const prompts = buildPromptsFromCurrentFields(promptData);
  instructionPromptText = prompts.instructionPrompt;
  contentPromptText = prompts.contentPrompt;
  elements.instructionPromptOutput.value = instructionPromptText;
  elements.contentPromptOutput.value = contentPromptText;
  persistSettings();
}

function parsePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} invalido.`);
  }

  return number;
}

function setBusy(isBusy) {
  elements.runButton.disabled = isBusy || !currentPdfUrl;
  elements.downloadImagesButton.disabled = isBusy || !imageZip?.downloadUrl;
  elements.copyInstructionPromptButton.disabled = isBusy;
  elements.copyContentPromptButton.disabled = isBusy;
  for (const input of [
    elements.sourceType,
    elements.dpi,
    elements.imageIdentifier,
    elements.sourceAuthors,
    elements.sourceYear,
    elements.sourceTitle,
    elements.sourceContainer,
    elements.pageStart,
    elements.pageEnd,
    elements.allPages,
  ]) {
    input.disabled = isBusy;
  }
  if (!isBusy) {
    syncPageRangeState();
  }
}

function syncPageRangeState() {
  const useAllPages = elements.allPages.checked;
  elements.pageStart.disabled = useAllPages || Boolean(currentJobId);
  elements.pageEnd.disabled = useAllPages || Boolean(currentJobId);
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function setProgress(value, label) {
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  elements.progressBar.style.width = `${progress}%`;
  elements.progressText.textContent = label || '';
}

function applySettings(settings) {
  const documentName = String(settings.sourceTitle ?? '').trim() || String(settings.sourceName ?? '').trim();
  lastSettingsPdfBaseName = settings.pdfBaseName ?? '';
  elements.dpi.value = settings.dpi ?? DEFAULT_DPI;
  elements.pageStart.value = settings.pageStart ?? 1;
  elements.pageEnd.value = settings.pageEnd ?? 1;
  elements.allPages.checked = Boolean(settings.allPages);
  elements.sourceType.value = settings.sourceType ?? 'FRMW2026';
  setDocumentName(documentName);
  elements.imageIdentifier.value = settings.imageIdentifier ?? '';
  elements.sourceAuthors.value = settings.sourceAuthors ?? '';
  elements.sourceYear.value = settings.sourceYear ?? '';
  elements.sourceContainer.value = settings.sourceContainer ?? '';
  elements.instructionPromptOutput.value = settings.instructionPromptText ?? '';
  elements.contentPromptOutput.value = settings.contentPromptText ?? '';
  instructionPromptText = settings.instructionPromptText ?? '';
  contentPromptText = settings.contentPromptText ?? '';
  syncDerivedSourceFields();
  syncPageRangeState();
  updateSourcePreview();
  updateDownloadImagesButton();
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['flashmaker_extension_settings']);
  return result.flashmaker_extension_settings ?? {};
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ flashmaker_extension_settings: settings });
}

function persistSettings() {
  lastSettingsPdfBaseName = currentPdfBaseName;
  void saveSettings({
    pdfBaseName: currentPdfBaseName,
    dpi: elements.dpi.value,
    pageStart: elements.pageStart.value,
    pageEnd: elements.pageEnd.value,
    allPages: elements.allPages.checked,
    sourceType: elements.sourceType.value,
    sourceName: getDocumentName(),
    imageIdentifier: elements.imageIdentifier.value,
    sourceAuthors: elements.sourceAuthors.value,
    sourceYear: elements.sourceYear.value,
    sourceTitle: getDocumentName(),
    sourceContainer: elements.sourceContainer.value,
    instructionPromptText,
    contentPromptText,
  }).catch(() => {});
}

async function persistPrompts() {
  const settings = await loadSettings();
  await saveSettings({
    ...settings,
    instructionPromptText,
    contentPromptText,
  });
}

function inferSourceType(fileName) {
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
  if (/^Med_Guideline_/i.test(fileName) || /^Med_Guidelines_/i.test(fileName)) {
    return 'Guidelines';
  }
  if (/^Med_Artigo_/i.test(fileName) || /^Med_Artigos_/i.test(fileName)) {
    return 'Artigos';
  }
  return 'FRMW2026';
}

function humanizeBaseName(fileName) {
  return String(fileName)
    .replace(/\.pdf$/i, '')
    .replace(/^Med_[^_]+_/i, '')
    .replace(/-/g, ' ')
    .trim();
}

function inferImageIdentifier(fileName) {
  const matched = String(fileName).match(/^Med_[^_]+_(.+)$/i);
  if (matched?.[1]) {
    return matched[1];
  }

  return String(fileName)
    .replace(/\.pdf$/i, '')
    .trim();
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

function normalizePreviewPage(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return '01';
  }

  return String(parsed).padStart(2, '0');
}

function buildSourceTitle(sourceType, sourceName) {
  const template = getSourceTemplate(sourceType);
  const context = buildSourceTemplateContext({
    sourceType,
    sourceName,
    imageIdentifier: elements.imageIdentifier.value.trim(),
  });
  return renderSourceTemplate(template.materialTitleTemplate, context) || sourceName;
}

function buildSourceLine({ sourceType, sourceName, imageIdentifier, authors, year, title, container }) {
  const finalAuthors = authors || defaultAuthors(sourceType);
  const finalYear = year || defaultYear(sourceType);
  const finalTitle = defaultTitle(sourceType, title || sourceName, imageIdentifier);
  const finalContainer = container.trim();
  const containerSuffix = finalContainer ? ` ${finalContainer}.` : '';
  return `${finalAuthors} (${finalYear}). <i>${finalTitle}</i>.${containerSuffix}`;
}

function defaultAuthors(sourceType) {
  const template = getSourceTemplate(sourceType);
  const context = buildSourceTemplateContext({
    sourceType,
    sourceName: getDocumentName(),
    imageIdentifier: elements.imageIdentifier.value.trim(),
  });
  return renderSourceTemplate(template.authorTemplate, context);
}

function defaultYear(sourceType) {
  return getSourceTemplate(sourceType).year;
}

function defaultTitle(sourceType, sourceName, imageIdentifier = elements.imageIdentifier.value.trim()) {
  const template = getSourceTemplate(sourceType);
  const context = buildSourceTemplateContext({ sourceType, sourceName, imageIdentifier });
  return renderSourceTemplate(template.documentNameTemplate, context) || sourceName;
}

function defaultContainer(sourceType) {
  return getSourceTemplate(sourceType).container;
}

function buildTemplateImageBaseName(sourceType, sourceName, imageIdentifier) {
  const template = getSourceTemplate(sourceType);
  const context = buildSourceTemplateContext({ sourceType, sourceName, imageIdentifier });
  const tag = renderSourceTemplate(template.tagTemplate, context) || `Med_${sourceType}`;
  const referenceImage = renderSourceTemplate(template.referenceImageTemplate, context) || imageIdentifier || sourceName;
  return `${tag}_${slugify(referenceImage)}`;
}

function buildPromptsFromCurrentFields(data) {
  const sourceName = getDocumentName();
  const sourceType = elements.sourceType.value || 'Outros';
  const imageIdentifier = elements.imageIdentifier.value.trim() || inferImageIdentifier(currentPdfBaseName || sourceName);
  const imageBaseName = buildTemplateImageBaseName(sourceType, sourceName, imageIdentifier);
  const sourceTitle = buildSourceTitle(sourceType, sourceName);
  const sourceLine = buildSourceLine({
    sourceType,
    sourceName,
    imageIdentifier,
    authors: elements.sourceAuthors.value.trim(),
    year: elements.sourceYear.value.trim(),
    title: getDocumentName(),
    container: elements.sourceContainer.value.trim(),
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
  const pageBlocks = (data.pages ?? [])
    .map((page) => {
      const excerpt = String(page.text ?? '').trim() || '[Sem texto extraido desta pagina]';
      return [
        `### PAGINA_VISUAL_${page.visualPage}`,
        `ARQUIVO_IMAGEM: ${imageBaseName}-${page.visualPage}.jpg`,
        'TEXTO_EXTRAIDO:',
        excerpt,
      ].join('\n');
    })
    .join('\n\n');

  return {
    instructionPrompt: buildInstructionPrompt({ sourceHtmlTemplate, imageBaseName }),
    contentPrompt: buildContentPrompt(pageBlocks),
  };
}

function buildInstructionPrompt({ sourceHtmlTemplate, imageBaseName }) {
  return `
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
}

function buildContentPrompt(pageBlocks) {
  return `
Gere agora o CSV a partir do material abaixo. Use somente informacoes presentes nas paginas fornecidas. Para cada card, escolha a pagina visual correspondente e gere FONTE com fonte(paginaVisual).

${pageBlocks}
`.trim();
}

function updateDownloadImagesButton() {
  elements.downloadImagesButton.disabled = Boolean(currentJobId) || !imageZip?.downloadUrl;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
