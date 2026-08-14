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
  const imageIdentifier = inferImageIdentifier(currentPdfBaseName || sourceName);
  elements.sourceType.value = sourceType;
  setDocumentName(resolveDocumentNameForTemplate(sourceType, sourceName, imageIdentifier));
  elements.imageIdentifier.value = imageIdentifier;
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
  const sourceType = normalizeSavedSourceType(
    settings.sourceType ?? 'FRMW2026',
    documentName,
    settings.imageIdentifier ?? '',
    settings.pdfBaseName ?? '',
  );
  lastSettingsPdfBaseName = settings.pdfBaseName ?? '';
  elements.dpi.value = settings.dpi ?? DEFAULT_DPI;
  elements.pageStart.value = settings.pageStart ?? 1;
  elements.pageEnd.value = settings.pageEnd ?? 1;
  elements.allPages.checked = Boolean(settings.allPages);
  elements.sourceType.value = sourceType;
  elements.imageIdentifier.value = settings.imageIdentifier ?? '';
  setDocumentName(resolveDocumentNameForTemplate(sourceType, documentName, elements.imageIdentifier.value));
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
  if (isHarrison22ndReference(fileName)) {
    return 'Harrison22nd';
  }
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

function normalizeSavedSourceType(sourceType, documentName, imageIdentifier, pdfBaseName) {
  if (
    sourceType === 'Livro' &&
    isHarrison22ndReference(`${documentName} ${imageIdentifier} ${pdfBaseName}`)
  ) {
    return 'Harrison22nd';
  }

  return sourceType;
}

function isHarrison22ndReference(value) {
  return /harrisons?-principles-of-internal-medicine-22nd-edition/i.test(String(value))
    || /harrisons?\s+principles\s+of\s+internal\s+medicine\s+22nd\s+edition/i.test(String(value))
    || /harrison's\s+principles\s+of\s+internal\s+medicine\s+\(22nd\s+edition\)/i.test(String(value));
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

function resolveDocumentNameForTemplate(sourceType, sourceName, imageIdentifier = '') {
  const template = getSourceTemplate(sourceType);
  const documentNameTemplate = String(template.documentNameTemplate ?? '').trim();
  if (!documentNameTemplate || usesDocumentNamePlaceholder(documentNameTemplate)) {
    return String(sourceName ?? '').trim();
  }

  return defaultTitle(sourceType, sourceName, imageIdentifier);
}

function usesDocumentNamePlaceholder(template) {
  return [
    '{{sourceName}}',
    '{Title do material}',
    '{Nome do Documento}',
  ].some((token) => template.includes(token));
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
Você é um professor experiente de medicina criando flashcards BASIC para provas de residência médica/R3.

Quando eu enviar o material, gere poucos flashcards em CSV, selecionando apenas informações high-yield que merecem memorização ativa. Adote estilo didático, formal e explicativo, com perguntas claras e conceituais. Priorize definições, mecanismos, fatores associados, consequências fisiológicas, distinções entre conceitos próximos, critérios, exceções, indicações, contraindicações, sequências e detalhes clássicos de prova.

Cada card deve cobrar uma única pergunta. A pergunta deve ser autocontida, precisa e formulada de modo que o aluno entenda exatamente qual conceito está sendo testado. Evite perguntas vagas, duplas, excessivamente amplas ou dependentes de contexto oculto.

As respostas devem ser diretas, completas e em linguagem médica precisa. Prefira respostas de uma linha quando a resposta não envolver lista; use lista apenas quando houver vários itens indispensáveis. Não use respostas telegráficas demais, abreviações simbólicas ou frases que pareçam apenas palavras soltas.

As explicações devem desenvolver de maneira substancial o raciocínio subjacente, conectando o conceito à fisiopatologia, interpretação clínica ou forma como costuma ser cobrado em prova. O texto deve soar como um professor explicando um ponto relevante: tecnicamente rigoroso, pedagógico, seguro e relativamente detalhado, sem se limitar a repetir a resposta mínima.

Quando pertinente, destaque erros clássicos, inversões conceituais e associações de prova. Use encadeamento causal explícito e contextualização suficiente para evitar memorização mecânica.

Evite:
- inventar dados ausentes;
- misturar vários conceitos no mesmo card;
- criar cards sobre informações óbvias ou dedutíveis;
- usar raciocínio clínico amplo quando o material só sustenta um conceito específico;
- exagerar no uso de negrito.

Formato do CSV:
\`PERGUNTA,DICA,RESPOSTA,EXPLICAÇÃO,FONTE,SUBDECK\`

Regras dos campos:
- PERGUNTA, DICA, RESPOSTA, EXPLICAÇÃO e FONTE devem conter HTML.
- PERGUNTA: clara, conceitual, autocontida e testando uma única informação, em HTML.
- DICA: curta, sem entregar a resposta, em HTML.
- RESPOSTA: direta, completa e preferencialmente em uma linha, em HTML, usando \`<p>\` ou \`<ul><li>\`.
- Em listas HTML, cada item deve começar com letra maiúscula após \`<li>\`; use ponto e vírgula ao fim dos itens intermediários e ponto final no último item.
- Use \`<strong>\` raramente e apenas quando o realce for realmente necessário; não coloque negrito por hábito.
- EXPLICAÇÃO: em HTML, preferencialmente \`<p>\`, com explicação didática, formal e detalhada, contendo no mínimo 5 frases completas ou cerca de 120 a 180 palavras, sem quebrar a linha do CSV.
- Na EXPLICAÇÃO, vá além de repetir o material: desenvolva o raciocínio com encadeamento causal, contextualizando com conhecimento médico consolidado, fisiopatologia, implicação prática, erro clássico ou motivo de prova. Não use explicações curtas de uma ou duas frases.
- Não comece a EXPLICAÇÃO com frases como "No material", "O material diz", "Segundo o texto", "Segundo o material", "Segundo a fonte" ou equivalentes.
- Evite em qualquer campo formulações metalinguísticas como "segundo a fonte", "segundo o material", "de acordo com o texto" ou "conforme a fonte"; escreva a informação diretamente, como conhecimento médico.
- A resposta cobrada deve estar presente no material; o conhecimento externo deve apenas explicar e contextualizar.
- FONTE: sempre HTML, gerada pela função fonte(paginaVisual).
- SUBDECK: sugestão curta de subdeck, sem HTML, baseada no tema principal do card. Use hierarquia com :: quando útil, por exemplo: Clínica Médica::Infectologia::Meningites.

Use este template uma única vez para gerar a coluna FONTE:
~~~html
${sourceHtmlTemplate}
~~~

Defina mentalmente ou em código:
fonte(paginaVisual) = template acima com [PaginaVisual] substituído por paginaVisual.

Regras da fonte:
- A única parte variável da fonte entre flashcards é [PaginaVisual].
- Use página visual do PDF/material, como 01, 02, 03.
- Não coloque página no texto bibliográfico da \`<div class="source">\`.
- O src da imagem deve ficar exatamente: ${imageBaseName}-[PaginaVisual].jpg.

Saída:
- Se tiver ferramenta de arquivos/Python disponível, gere um arquivo chamado flashcards.csv e forneça o link para download.
- Para criar o arquivo, use uma lista de linhas e uma função fonte(paginaVisual), em vez de reescrever manualmente o HTML da fonte em cada linha.
- Use o módulo csv ou equivalente para escapar aspas corretamente.
- Se não puder criar arquivo para download, entregue somente o CSV puro, sem comentários.
- Cabeçalho obrigatório: \`PERGUNTA,DICA,RESPOSTA,EXPLICAÇÃO,FONTE,SUBDECK\`
`.trim();
}

function buildContentPrompt(pageBlocks) {
  return `
Gere agora o CSV a partir do material abaixo. Use somente informações presentes nas páginas fornecidas. Para cada card, escolha a página visual correspondente, gere FONTE com fonte(paginaVisual) e sugira um SUBDECK coerente.

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
