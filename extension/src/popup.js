import {
  deriveBaseNameFromPdfUrl,
  deriveBaseNameFromTitle,
  extractPdfUrlFromTabUrl,
  isLikelyPdfTab,
  safeDecodeURIComponent,
} from './shared.js';

const DEFAULT_DPI = 150;
const SOURCE_TYPES = [
  { value: 'FRMW2026', label: 'Ficha Resumo da Medway' },
  { value: 'AMW2026', label: 'Apostila da Medway' },
  { value: 'Livro', label: 'Livro' },
  { value: 'Artigos', label: 'Artigo' },
  { value: 'Guidelines', label: 'Guideline' },
  { value: 'UTD', label: 'UpToDate' },
  { value: 'Outros', label: 'Outros' },
];

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
let instructionPromptText = '';
let contentPromptText = '';

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

  elements.sourceType.addEventListener('change', () => {
    handleSourceTypeChange();
    persistSettings();
    updateSourcePreview();
  });

  elements.allPages.addEventListener('change', () => {
    syncPageRangeState();
    persistSettings();
  });

  for (const input of [
    elements.dpi,
    elements.sourceName,
    elements.imageIdentifier,
    elements.sourceAuthors,
    elements.sourceYear,
    elements.sourceTitle,
    elements.sourceContainer,
    elements.pageStart,
    elements.pageEnd,
  ]) {
    input.addEventListener('input', () => {
      persistSettings();
      updateSourcePreview();
    });
    input.addEventListener('change', () => {
      persistSettings();
      updateSourcePreview();
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
      elements.instructionPromptOutput.value = instructionPromptText;
      elements.contentPromptOutput.value = contentPromptText;
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
    currentPdfBaseName = fileName;
    elements.pdfState.textContent = safeDecodeURIComponent(fileName);
    elements.pdfHint.textContent = pdfUrl.startsWith('file:') ? 'PDF local' : 'PDF remoto';

    if (!elements.imageIdentifier.value.trim()) {
      elements.imageIdentifier.value = inferImageIdentifier(fileName);
    }

    if (!elements.sourceName.value.trim()) {
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

  applyDefaults(elements.sourceType.value, elements.sourceName.value.trim());
}

function applyDefaults(sourceType, sourceName) {
  elements.sourceType.value = sourceType;
  elements.sourceName.value = sourceName;
  if (!elements.imageIdentifier.value.trim()) {
    elements.imageIdentifier.value = inferImageIdentifier(currentPdfBaseName || sourceName);
  }
  elements.sourceAuthors.value = defaultAuthors(sourceType);
  elements.sourceYear.value = defaultYear(sourceType);
  elements.sourceTitle.value = defaultTitle(sourceType, sourceName);
  elements.sourceContainer.value = defaultContainer(sourceType);
  updateSourcePreview();
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
      sourceName: elements.sourceName.value.trim(),
      sourceAuthors: elements.sourceAuthors.value.trim(),
      sourceYear: elements.sourceYear.value.trim(),
      sourceTitle: elements.sourceTitle.value.trim(),
      sourceContainer: elements.sourceContainer.value.trim(),
      pageStart: parsePositiveInt(elements.pageStart.value, 'Pagina inicial'),
      pageEnd: parsePositiveInt(elements.pageEnd.value, 'Pagina final'),
      allPages: elements.allPages.checked,
    };

    if (!payload.sourceName) {
      throw new Error('Preencha Source name.');
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
    elements.instructionPromptOutput.value = '';
    elements.contentPromptOutput.value = '';
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

function updateSourcePreview() {
  const sourceName = elements.sourceName.value.trim() || '[Source name]';
  const sourceType = elements.sourceType.value || 'Outros';
  const pageValue = normalizePreviewPage(elements.pageStart.value || '1');
  const sourceSlug = slugify(elements.imageIdentifier.value.trim() || inferImageIdentifier(currentPdfBaseName || sourceName));
  const title = buildSourceTitle(sourceType, sourceName);
  const sourceLine = buildSourceLine({
    sourceType,
    sourceName,
    authors: elements.sourceAuthors.value.trim(),
    year: elements.sourceYear.value.trim(),
    title: elements.sourceTitle.value.trim(),
    container: elements.sourceContainer.value.trim(),
  });

  elements.sourcePreview.textContent = `<div class="quote">
    <div class="title">
        ${title}
    </div>
    <hr>
    <div class="reference">
        <img src="Med_${sourceType}_${sourceSlug}-${pageValue}.jpg">
    </div>
    <hr>
    <div class="source">
        ${sourceLine}
    </div>
</div>`;
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
  elements.copyInstructionPromptButton.disabled = isBusy;
  elements.copyContentPromptButton.disabled = isBusy;
  for (const input of [
    elements.sourceType,
    elements.dpi,
    elements.sourceName,
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
  elements.dpi.value = settings.dpi ?? DEFAULT_DPI;
  elements.pageStart.value = settings.pageStart ?? 1;
  elements.pageEnd.value = settings.pageEnd ?? 1;
  elements.allPages.checked = Boolean(settings.allPages);
  elements.sourceType.value = settings.sourceType ?? 'FRMW2026';
  elements.sourceName.value = settings.sourceName ?? '';
  elements.imageIdentifier.value = settings.imageIdentifier ?? '';
  elements.sourceAuthors.value = settings.sourceAuthors ?? '';
  elements.sourceYear.value = settings.sourceYear ?? '';
  elements.sourceTitle.value = settings.sourceTitle ?? '';
  elements.sourceContainer.value = settings.sourceContainer ?? '';
  elements.instructionPromptOutput.value = settings.instructionPromptText ?? '';
  elements.contentPromptOutput.value = settings.contentPromptText ?? '';
  instructionPromptText = settings.instructionPromptText ?? '';
  contentPromptText = settings.contentPromptText ?? '';
  syncPageRangeState();
  updateSourcePreview();
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['flashmaker_extension_settings']);
  return result.flashmaker_extension_settings ?? {};
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ flashmaker_extension_settings: settings });
}

function persistSettings() {
  void saveSettings({
    dpi: elements.dpi.value,
    pageStart: elements.pageStart.value,
    pageEnd: elements.pageEnd.value,
    allPages: elements.allPages.checked,
    sourceType: elements.sourceType.value,
    sourceName: elements.sourceName.value,
    imageIdentifier: elements.imageIdentifier.value,
    sourceAuthors: elements.sourceAuthors.value,
    sourceYear: elements.sourceYear.value,
    sourceTitle: elements.sourceTitle.value,
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
  if (sourceType === 'FRMW2026') {
    return `Ficha Resumo da Medway 2026: ${sourceName}`;
  }
  if (sourceType === 'AMW2026') {
    return `Apostila da Medway 2026: ${sourceName}`;
  }
  return sourceName;
}

function buildSourceLine({ sourceType, sourceName, authors, year, title, container }) {
  const finalAuthors = authors || defaultAuthors(sourceType);
  const finalYear = year || defaultYear(sourceType);
  const finalTitle = title || defaultTitle(sourceType, sourceName);
  const finalContainer = container.trim();
  const containerSuffix = finalContainer ? ` ${finalContainer}.` : '';
  return `${finalAuthors}. (${finalYear}). <i>${finalTitle}</i>.${containerSuffix}`;
}

function defaultAuthors(sourceType) {
  if (sourceType === 'FRMW2026' || sourceType === 'AMW2026') {
    return 'Medway';
  }
  return '';
}

function defaultYear(sourceType) {
  if (sourceType === 'FRMW2026' || sourceType === 'AMW2026') {
    return '2026';
  }
  return '';
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

function defaultContainer(sourceType) {
  if (sourceType === 'UTD') {
    return 'UpToDate';
  }
  return '';
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
