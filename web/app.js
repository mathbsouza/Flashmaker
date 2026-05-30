const state = {
  pdfs: [],
  selectedPdf: null,
  extraction: null,
  activeJobId: null,
  promptText: '',
};

const elements = {
  pdfSelect: document.querySelector('#pdfSelect'),
  refreshPdfsButton: document.querySelector('#refreshPdfsButton'),
  sourceName: document.querySelector('#sourceName'),
  theme: document.querySelector('#theme'),
  sourceType: document.querySelector('#sourceType'),
  dpi: document.querySelector('#dpi'),
  sourceAuthors: document.querySelector('#sourceAuthors'),
  sourceYear: document.querySelector('#sourceYear'),
  sourceTitle: document.querySelector('#sourceTitle'),
  sourceContainer: document.querySelector('#sourceContainer'),
  pageStart: document.querySelector('#pageStart'),
  pageEnd: document.querySelector('#pageEnd'),
  runButton: document.querySelector('#runButton'),
  copyPromptButton: document.querySelector('#copyPromptButton'),
  copyPromptInlineButton: document.querySelector('#copyPromptInlineButton'),
  pdfMeta: document.querySelector('#pdfMeta'),
  sourcePreview: document.querySelector('#sourcePreview'),
  resultLinks: document.querySelector('#resultLinks'),
  logOutput: document.querySelector('#logOutput'),
  promptOutput: document.querySelector('#promptOutput'),
  pagePreview: document.querySelector('#pagePreview'),
  previewCount: document.querySelector('#previewCount'),
  statusBadge: document.querySelector('#statusBadge'),
};

boot().catch((error) => setLog(String(error)));

async function boot() {
  wireEvents();
  await loadPdfs();
}

function wireEvents() {
  elements.refreshPdfsButton.addEventListener('click', () => void runAction(() => loadPdfs(), 'Falha ao carregar PDFs.'));
  elements.pdfSelect.addEventListener('change', onPdfSelectionChange);
  elements.runButton.addEventListener('click', () => void runAction(() => runPipeline(), 'Falha ao processar PDF.'));
  elements.copyPromptButton.addEventListener('click', () => void runAction(() => copyPrompt(), 'Falha ao copiar prompt.'));
  elements.copyPromptInlineButton.addEventListener('click', () => void runAction(() => copyPrompt(), 'Falha ao copiar prompt.'));
  for (const field of [
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
    field.addEventListener('input', updateSourcePreview);
    field.addEventListener('change', updateSourcePreview);
  }
}

async function loadPdfs() {
  setBusy('Carregando PDFs');
  const payload = await fetchJson('/api/pdfs');
  state.pdfs = payload.items;
  fillSourceTypes(payload.sourceTypes);
  fillPdfSelect(payload.items);
  setIdle('PDFs carregados');
}

function fillSourceTypes(sourceTypes) {
  elements.sourceType.innerHTML = sourceTypes
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join('');
}

function fillPdfSelect(items) {
  const options = ['<option value="">Selecione um PDF</option>']
    .concat(items.map((item) => `<option value="${escapeHtml(item.path)}">${escapeHtml(item.fileName)} (${item.totalPages} pags.)</option>`));
  elements.pdfSelect.innerHTML = options.join('');
  if (items[0]) {
    elements.pdfSelect.value = items[0].path;
    applyPdfInfo(items[0]);
  } else {
    applyPdfInfo(null);
  }
}

function onPdfSelectionChange() {
  const selected = state.pdfs.find((item) => item.path === elements.pdfSelect.value) ?? null;
  applyPdfInfo(selected);
}

function applyPdfInfo(info) {
  state.selectedPdf = info;
  state.extraction = null;
  state.promptText = '';
  renderResults(null);

  if (!info) {
    elements.pdfMeta.textContent = 'Nenhum PDF selecionado.';
    elements.sourceName.value = '';
    elements.theme.value = '';
    elements.sourceAuthors.value = '';
    elements.sourceYear.value = '';
    elements.sourceTitle.value = '';
    elements.sourceContainer.value = '';
    elements.pageStart.value = '';
    elements.pageEnd.value = '';
    return;
  }

  elements.sourceName.value = info.inferredSourceName;
  elements.theme.value = info.inferredSourceName;
  elements.sourceType.value = info.inferredSourceType;
  elements.sourceAuthors.value = defaultAuthors(info.inferredSourceType);
  elements.sourceYear.value = defaultYear(info.inferredSourceType);
  elements.sourceTitle.value = defaultTitle(info.inferredSourceType, info.inferredSourceName);
  elements.sourceContainer.value = defaultContainer(info.inferredSourceType);
  elements.pageStart.value = 1;
  elements.pageEnd.value = info.totalPages;
  elements.pdfMeta.textContent = `${info.fileName} • ${info.totalPages} páginas • ${info.path}`;
  updateSourcePreview();
}

async function runPipeline() {
  await extractPages();
  await generateCards(true);
}

async function extractPages() {
  const pdfPath = getSelectedPdfPath();
  if (!pdfPath) {
    setLog('Selecione um PDF.');
    return;
  }

  const payload = {
    pdfPath,
    sourceName: elements.sourceName.value.trim(),
    sourceType: elements.sourceType.value,
    sourceAuthors: elements.sourceAuthors.value.trim(),
    sourceYear: elements.sourceYear.value.trim(),
    sourceTitle: elements.sourceTitle.value.trim(),
    sourceContainer: elements.sourceContainer.value.trim(),
    pageStart: elements.pageStart.value || 1,
    pageEnd: elements.pageEnd.value || state.selectedPdf?.totalPages,
    dpi: elements.dpi.value || 150,
  };

  setBusy('Extraindo páginas');
  const { jobId } = await fetchJson('/api/extract', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await waitForJob(jobId, {
    runningLabel: 'Extraindo páginas',
    doneLabel: 'Extração concluída',
    onCompleted: (result) => {
      state.extraction = result;
      renderResults(result, result.log || '');
    },
  });
}

async function generateCards(promptOnly) {
  const inputDir = state.extraction?.outputDir;
  if (!inputDir) {
    setLog('Extraia as páginas antes de gerar o prompt.');
    return;
  }

  const payload = {
    inputDir,
    theme: elements.theme.value.trim(),
    promptOnly,
  };

  setBusy('Gerando prompt');
  const { jobId } = await fetchJson('/api/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await waitForJob(jobId, {
    runningLabel: 'Gerando prompt',
    doneLabel: 'Prompt pronto',
    onCompleted: (result) => {
      renderResults(result, result.log || '');
    },
  });
}

function renderResults(result, log = '') {
  renderLinks(result);
  renderPages(result?.metadata?.pages ?? []);
  setLog(log || 'Sem log ainda.');
  void renderPrompt(result);
  updateSourcePreview();
}

function renderLinks(result) {
  if (!result) {
    elements.resultLinks.innerHTML = 'Nenhum processamento ainda.';
    elements.resultLinks.className = 'link-list empty-state';
    elements.promptOutput.value = '';
    return;
  }

  const links = [];
  links.push(`<div><strong>Pasta:</strong> <code>${escapeHtml(result.outputDir || result.inputDir || '')}</code></div>`);
  if (result.promptUrl) {
    links.push(`<a href="${result.promptUrl}" target="_blank" rel="noreferrer">Abrir prompt.txt</a>`);
  }
  if (result.metadata?.pages?.[0]?.imageUrl) {
    links.push(`<a href="${result.metadata.pages[0].imageUrl}" target="_blank" rel="noreferrer">Abrir primeira imagem</a>`);
  }
  elements.resultLinks.className = 'link-list';
  elements.resultLinks.innerHTML = links.join('');
}

async function renderPrompt(result) {
  if (!result?.promptUrl) {
    state.promptText = '';
    elements.promptOutput.value = '';
    return;
  }

  const response = await fetch(result.promptUrl);
  const text = await response.text();
  state.promptText = text;
  elements.promptOutput.value = text;
}

function renderPages(pages) {
  elements.previewCount.textContent = pages.length ? `${pages.length} página(s)` : '';
  if (!pages.length) {
    elements.pagePreview.innerHTML = '';
    return;
  }

  elements.pagePreview.innerHTML = pages
    .map((page) => `
      <article class="preview-item">
        <strong>Página ${escapeHtml(page.visualPage)}</strong>
        <img src="${page.imageUrl}" alt="Página ${escapeHtml(page.visualPage)}">
        <pre>${escapeHtml(page.textExcerpt ?? 'Carregando...')}</pre>
        <a href="${page.textUrl}" target="_blank" rel="noreferrer">Abrir TXT</a>
      </article>
    `)
    .join('');

  pages.forEach(async (page, index) => {
    const response = await fetch(page.textUrl);
    const text = await response.text();
    const pre = elements.pagePreview.querySelectorAll('pre')[index];
    if (pre) {
      pre.textContent = truncateText(text.trim(), 700) || '[Sem texto extraído]';
    }
  });
}

function setLog(value) {
  elements.logOutput.textContent = value || 'Sem log ainda.';
}

function updateSourcePreview() {
  const sourceName = elements.sourceName.value.trim() || '[Source name]';
  const sourceType = elements.sourceType.value || 'Artigos';
  const pageValue = normalizePreviewPage(elements.pageStart.value || '1');
  const sourceSlug = slugify(sourceName);
  const title = buildSourceTitle(sourceType, sourceName);
  const sourceLine = buildSourceLine(
    sourceType,
    sourceName,
    elements.sourceAuthors.value.trim(),
    elements.sourceYear.value.trim(),
    elements.sourceTitle.value.trim(),
    elements.sourceContainer.value.trim(),
  );

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

async function waitForJob(jobId, { runningLabel, doneLabel, onCompleted }) {
  state.activeJobId = jobId;

  while (true) {
    const job = await fetchJson(`/api/jobs/${jobId}`);
    setBusy(runningLabel);
    setLog(job.log || 'Processando...');

    if (job.status === 'completed') {
      const result = {
        ...(job.result || {}),
        log: job.log || '',
      };
      onCompleted?.(result);
      setDone(doneLabel);
      state.activeJobId = null;
      return result;
    }

    if (job.status === 'failed') {
      state.activeJobId = null;
      throw new Error(job.error || 'Falha no processamento.');
    }

    await delay(700);
  }
}

function setBusy(message) {
  elements.statusBadge.textContent = message;
  elements.statusBadge.className = 'status-badge busy';
}

function setDone(message) {
  elements.statusBadge.textContent = message;
  elements.statusBadge.className = 'status-badge done';
}

function setIdle(message) {
  elements.statusBadge.textContent = message;
  elements.statusBadge.className = 'status-badge idle';
}

async function runAction(action, fallbackMessage) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : fallbackMessage;
    setLog(message || fallbackMessage);
    setIdle('Falha');
  }
}

async function copyPrompt() {
  if (!state.promptText.trim()) {
    throw new Error('Gere o prompt antes de copiar.');
  }
  await navigator.clipboard.writeText(state.promptText);
  setDone('Prompt copiado');
}

function getSelectedPdfPath() {
  return state.selectedPdf?.pdfPath || state.selectedPdf?.path || elements.pdfSelect.value;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Falha na requisição.');
  }
  return payload;
}

function truncateText(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
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

function buildSourceLine(sourceType, sourceName, authors, year, title, container) {
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
