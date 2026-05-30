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

  if (message.type === 'START_PROMPT') {
    void startPrompt(message.payload);
  }
});

async function startPrompt(payload) {
  try {
    await ensureOffscreenDocument();
    postRuntimeMessage({
      type: 'FLASHMARKER_STATUS',
      jobId: payload.jobId,
      message: 'Preparando PDF...',
      progress: 6,
      progressText: 'Abrindo PDF',
    });

    postRuntimeMessage({
      target: 'offscreen',
      type: 'GENERATE_PROMPT',
      payload,
    });
  } catch (error) {
    postRuntimeMessage({
      type: 'FLASHMARKER_ERROR',
      jobId: payload?.jobId,
      message: getErrorMessage(error),
    });
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
        reasons: ['DOM_PARSER', 'WORKERS'],
        justification: 'Ler PDFs com PDF.js e gerar prompt de flashcards fora da sidebar.',
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
