import { buildZipName } from './shared.js';

const OFFSCREEN_PATH = 'offscreen.html';
let creatingOffscreen = null;

void configureSidePanel();
chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanel();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'background') {
    return;
  }

  if (message.type === 'START_EXPORT') {
    void startExport(message.payload);
  }

  if (message.type === 'DOWNLOAD_ZIP') {
    void downloadZip(message.payload);
  }
});

async function startExport(payload) {
  try {
    await ensureOffscreenDocument();
    postRuntimeMessage({
      type: 'CROPPDF_STATUS',
      jobId: payload.jobId,
      message: `Processando ${buildZipName(payload.baseName || 'CropPDF')}...`,
      progress: 6,
      progressText: 'Abrindo PDF',
    });

    postRuntimeMessage({
      target: 'offscreen',
      type: 'PROCESS_PDF',
      payload,
    });
  } catch (error) {
    postRuntimeMessage({
      type: 'CROPPDF_ERROR',
      jobId: payload?.jobId,
      message: getErrorMessage(error),
    });
  }
}

async function downloadZip(payload) {
  try {
    await chrome.downloads.download({
      url: payload.downloadUrl,
      filename: payload.downloadName,
      saveAs: false,
      conflictAction: 'uniquify',
    });

    postRuntimeMessage({
      type: 'CROPPDF_DONE',
      jobId: payload.jobId,
      message: `ZIP pronto: ${payload.downloadName}`,
      progress: 100,
      progressText: 'Download iniciado',
    });
  } catch (error) {
    postRuntimeMessage({
      type: 'CROPPDF_ERROR',
      jobId: payload?.jobId,
      message: getErrorMessage(error),
    });
  } finally {
    setTimeout(() => {
      postRuntimeMessage({
        target: 'offscreen',
        type: 'REVOKE_DOWNLOAD_URL',
        payload: {
          downloadUrl: payload?.downloadUrl,
        },
      });
    }, 60_000);
  }
}

async function configureSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Chrome sem sidePanel ainda pode abrir a pagina da extensao manualmente.
  }
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Renderizar PDFs e montar ZIPs em JavaScript fora da sidebar.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }

  await creatingOffscreen;
}

async function hasOffscreenDocument() {
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }

  if (typeof clients !== 'undefined' && clients.matchAll) {
    const matchedClients = await clients.matchAll();
    return matchedClients.some((client) => client.url.includes(chrome.runtime.id));
  }

  return false;
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

function postRuntimeMessage(message) {
  void chrome.runtime.sendMessage(message).catch(() => {});
}
