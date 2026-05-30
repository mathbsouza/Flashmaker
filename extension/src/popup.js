import {
  deriveBaseNameFromPdfUrl,
  deriveBaseNameFromTitle,
  extractPdfUrlFromTabUrl,
  isLikelyPdfTab,
  safeDecodeURIComponent,
} from './shared.js';

const DEFAULT_DPI = 150;
const SOURCE_TYPES = ['Livro', 'Capitulo', 'Artigos', 'Guidelines', 'FRMW2026', 'AMW2026', 'UTD'];

const elements = {
  pdfState: document.getElementById('pdfState'),
  pdfHint: document.getElementById('pdfHint'),
  sourceName: document.getElementById('sourceName'),
  theme: document.getElementById('theme'),
  sourceType: document.getElementById('sourceType'),
  dpi: document.getElementById('dpi'),
  sourceAuthors: document.getElementById('sourceAuthors'),
  sourceYear: document.getElementById('sourceYear'),
  sourceTitle: document.getElementById('sourceTitle'),
  sourceContainer: document.getElementById('sourceContainer'),
  pageStart: document.getElementById('pageStart'),
  pageEnd: document.getElementById('pageEnd'),
  runButton: document.getElementById('runButton'),
  copyPromptButton: document.getElementById('copyPromptButton'),
  sourcePreview: document.getElementById('sourcePreview'),
  promptOutput: document.getElementById('promptOutput'),
  statusText: document.getElementById('statusText'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
};

let currentPdfUrl = '';
let currentTabId = null;
let currentJobId = null;
let promptText = '';

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

  elements.copyPromptButton.addEventListener('click', () => {
    void copyPrompt();
  });

  for (const input of [
    elements.sourceName,
    elements.theme,
    elements.sourceType,
    elements.dpi,
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
      promptText = message.payload?.prompt ?? '';
      elements.promptOutput.value = promptText;
      setStatus(message.message ?? 'Prompt pronto.');
      setProgress(100, message.progressText ?? 'Concluido');
      setBusy(false);
      currentJobId = null;
      void persistPrompt(promptText);
      void refreshActivePdf();
    }
  });
}

function fillSourceTypes() {
  elements.sourceType.innerHTML = SOURCE_TYPES
    .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)
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
    elements.pdfState.textContent = safeDecodeURIComponent(fileName);
    elements.pdfHint.textContent = pdfUrl.startsWith('file:') ? 'PDF local' : 'PDF remoto';

    if (!elements.sourceName.value.trim()) {
      const inferredSourceName = humanizeBaseName(fileName);
      const inferredType = inferSourceType(fileName);
      applyInferredValues(inferredSourceName, inferredType);
    }
  } catch (error) {
    currentPdfUrl = '';
    currentTabId = null;
    elements.runButton.disabled = true;
    elements.pdfState.textContent = 'Nenhum PDF selecionado';
    elements.pdfHint.textContent = getErrorMessage(error);
    setStatus('Pronto.');
    setProgress(0, '');
  }
}

function applyInferredValues(sourceName, sourceType) {
  elements.sourceName.value = sourceName;
  elements.theme.value = sourceName;
  elements.sourceType.value = sourceType;
  elements.sourceAuthors.value = defaultAuthors(sourceType);
  elements.sourceYear.value = defaultYear(sourceType);
  elements.sourceTitle.value = defaultTitle(sourceType, sourceName);
  elements.sourceContainer.value = defaultContainer(sourceType);
  updateSourcePreview();
}

async function startPromptGeneration() {
  try {
    if (!currentPdfUrl) {
      throw new Error('Abra um PDF antes de gerar.');
    }

    const payload = {
      jobId: crypto.randomUUID(),
      pdfUrl: currentPdfUrl,
      sourceName: elements.sourceName.value.trim(),
      theme: elements.theme.value.trim(),
      sourceType: elements.sourceType.value,
      dpi: parsePositiveInt(elements.dpi.value || DEFAULT_DPI, 'Qualidade da imagem'),
      sourceAuthors: elements.sourceAuthors.value.trim(),
      sourceYear: elements.sourceYear.value.trim(),
      sourceTitle: elements.sourceTitle.value.trim(),
      sourceContainer: elements.sourceContainer.value.trim(),
      pageStart: parsePositiveInt(elements.pageStart.value, 'Pagina inicial'),
      pageEnd: parsePositiveInt(elements.pageEnd.value, 'Pagina final'),
    };

    if (!payload.sourceName) {
      throw new Error('Preencha Source name.');
    }

    if (!payload.theme) {
      throw new Error('Preencha Tema do deck.');
    }

    if (payload.pageStart > payload.pageEnd) {
      throw new Error('Pagina inicial precisa ser menor ou igual a final.');
    }

    currentJobId = payload.jobId;
    promptText = '';
    elements.promptOutput.value = '';
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

async function copyPrompt() {
  if (!promptText.trim()) {
    setStatus('Gere o prompt antes de copiar.');
    return;
  }

  await navigator.clipboard.writeText(promptText);
  setStatus('Prompt copiado.');
}

function updateSourcePreview() {
  const sourceName = elements.sourceName.value.trim() || '[Source name]';
  const sourceType = elements.sourceType.value || 'Artigos';
  const pageValue = normalizePreviewPage(elements.pageStart.value || '1');
  const sourceSlug = slugify(sourceName);
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
  elements.copyPromptButton.disabled = isBusy;
  for (const input of [
    elements.sourceName,
    elements.theme,
    elements.sourceType,
    elements.dpi,
    elements.sourceAuthors,
    elements.sourceYear,
    elements.sourceTitle,
    elements.sourceContainer,
    elements.pageStart,
    elements.pageEnd,
  ]) {
    input.disabled = isBusy;
  }
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
  elements.sourceName.value = settings.sourceName ?? '';
  elements.theme.value = settings.theme ?? '';
  elements.sourceType.value = settings.sourceType ?? 'Artigos';
  elements.sourceAuthors.value = settings.sourceAuthors ?? '';
  elements.sourceYear.value = settings.sourceYear ?? '';
  elements.sourceTitle.value = settings.sourceTitle ?? '';
  elements.sourceContainer.value = settings.sourceContainer ?? '';
  elements.promptOutput.value = settings.promptText ?? '';
  promptText = settings.promptText ?? '';
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
    sourceName: elements.sourceName.value,
    theme: elements.theme.value,
    sourceType: elements.sourceType.value,
    sourceAuthors: elements.sourceAuthors.value,
    sourceYear: elements.sourceYear.value,
    sourceTitle: elements.sourceTitle.value,
    sourceContainer: elements.sourceContainer.value,
    promptText,
  }).catch(() => {});
}

async function persistPrompt(value) {
  const settings = await loadSettings();
  await saveSettings({
    ...settings,
    promptText: value,
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
  if (/^Med_Capitulo_/i.test(fileName)) {
    return 'Capitulo';
  }
  if (/^Med_Guideline_/i.test(fileName) || /^Med_Guidelines_/i.test(fileName)) {
    return 'Guidelines';
  }
  return 'Artigos';
}

function humanizeBaseName(fileName) {
  return String(fileName)
    .replace(/^Med_[^_]+_/i, '')
    .replace(/-/g, ' ')
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
  const finalContainer = container || defaultContainer(sourceType);
  return `${finalAuthors}. (${finalYear}). <i>${finalTitle}</i>. ${finalContainer}.`;
}

function defaultAuthors(sourceType) {
  if (sourceType === 'FRMW2026' || sourceType === 'AMW2026') {
    return 'Medway';
  }
  return '[Autor não informado]';
}

function defaultYear(sourceType) {
  if (sourceType === 'FRMW2026' || sourceType === 'AMW2026') {
    return '2026';
  }
  return '[Ano não informado]';
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
  if (sourceType === 'FRMW2026' || sourceType === 'AMW2026') {
    return 'Medway';
  }
  if (sourceType === 'UTD') {
    return 'UpToDate';
  }
  return '[Fonte não informada]';
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
