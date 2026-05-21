import {
  deriveBaseNameFromPdfUrl,
  deriveBaseNameFromTitle,
  extractPdfUrlFromTabUrl,
  isLikelyPdfTab,
  sanitizeBaseName,
} from './shared.js';

const DEFAULT_DPI = 150;

const elements = {
  pdfState: document.getElementById('pdfState'),
  pdfHint: document.getElementById('pdfHint'),
  form: document.getElementById('cropForm'),
  baseName: document.getElementById('baseName'),
  pageStart: document.getElementById('pageStart'),
  pageEnd: document.getElementById('pageEnd'),
  dpi: document.getElementById('dpi'),
  submitBtn: document.getElementById('submitBtn'),
  statusText: document.getElementById('statusText'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
};

let currentPdfUrl = '';
let currentTabId = null;
let currentJobId = null;

document.addEventListener('DOMContentLoaded', () => {
  void initialize();
});

async function initialize() {
  bindEvents();
  applySettings(await loadSettings());
  await refreshActivePdf();
}

function bindEvents() {
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void startExport();
  });

  for (const input of [elements.pageStart, elements.pageEnd, elements.dpi]) {
    input.addEventListener('input', persistSettings);
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

    if (message?.type === 'CROPPDF_STATUS') {
      setStatus(message.message ?? 'Processando...');
      setProgress(message.progress, message.progressText ?? '');
    }

    if (message?.type === 'CROPPDF_ERROR') {
      setStatus(message.message ?? 'Falha.');
      setProgress(0, '');
      setBusy(false);
      currentJobId = null;
    }

    if (message?.type === 'CROPPDF_DONE') {
      setStatus(message.message ?? 'ZIP pronto.');
      setProgress(100, message.progressText ?? 'Concluido');
      setBusy(false);
      currentJobId = null;
      void refreshActivePdf();
    }
  });
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

    const changedPdf = pdfUrl !== currentPdfUrl;
    currentPdfUrl = pdfUrl;
    currentTabId = tab.id ?? null;
    elements.submitBtn.disabled = false;
    elements.pdfState.textContent = tab.title || deriveBaseNameFromPdfUrl(pdfUrl) || 'PDF aberto';
    elements.pdfHint.textContent = pdfUrl.startsWith('file:') ? 'PDF local' : 'PDF remoto';

    if (changedPdf || !elements.baseName.value.trim()) {
      elements.baseName.value =
        deriveBaseNameFromPdfUrl(pdfUrl) ||
        deriveBaseNameFromTitle(tab.title);
    }
  } catch (error) {
    currentPdfUrl = '';
    currentTabId = null;
    elements.submitBtn.disabled = true;
    elements.pdfState.textContent = 'Nenhum PDF';
    elements.pdfHint.textContent = getErrorMessage(error);
    setStatus('Pronto.');
    setProgress(0, '');
  }
}

async function startExport() {
  try {
    if (!currentPdfUrl) {
      throw new Error('Abra um PDF antes de gerar.');
    }

    const baseName = sanitizeBaseName(elements.baseName.value);
    const pageStart = parsePositiveInt(elements.pageStart.value, 'Pagina inicial');
    const pageEnd = parsePositiveInt(elements.pageEnd.value, 'Pagina final');
    const dpi = parsePositiveInt(elements.dpi.value || DEFAULT_DPI, 'DPI');

    if (pageStart > pageEnd) {
      throw new Error('Inicial precisa ser menor ou igual a final.');
    }

    const payload = {
      jobId: crypto.randomUUID(),
      pdfUrl: currentPdfUrl,
      baseName,
      pageStart,
      pageEnd,
      dpi,
    };

    currentJobId = payload.jobId;
    setBusy(true);
    setStatus('Preparando...');
    setProgress(4, '');
    await saveSettings({ pageStart, pageEnd, dpi });

    chrome.runtime.sendMessage({
      target: 'background',
      type: 'START_EXPORT',
      payload,
    });
  } catch (error) {
    setStatus(getErrorMessage(error));
    setProgress(0, '');
    setBusy(false);
    currentJobId = null;
  }
}

function parsePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} invalido.`);
  }

  return number;
}

function setBusy(isBusy) {
  elements.submitBtn.disabled = isBusy || !currentPdfUrl;
  elements.baseName.disabled = isBusy;
  elements.pageStart.disabled = isBusy;
  elements.pageEnd.disabled = isBusy;
  elements.dpi.disabled = isBusy;
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
  elements.pageStart.value = settings.pageStart ?? 1;
  elements.pageEnd.value = settings.pageEnd ?? 1;
  elements.dpi.value = settings.dpi ?? DEFAULT_DPI;
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['croppdf_settings']);
  return result.croppdf_settings ?? {};
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ croppdf_settings: settings });
}

function persistSettings() {
  void saveSettings({
    pageStart: elements.pageStart.value,
    pageEnd: elements.pageEnd.value,
    dpi: elements.dpi.value,
  }).catch(() => {});
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
