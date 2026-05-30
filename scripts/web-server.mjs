import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_TYPES,
  buildRunDirectoryName,
  deriveSourceNameFromFile,
  discoverPdfFiles,
  inferSourceType,
  readPdfPageCount,
  validatePdfPath,
} from './lib/app-core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'web');
const jobs = new Map();

async function main() {
  const shouldOpen = !process.argv.slice(2).includes('--no-open');
  const port = await findAvailablePort(4173);
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const url = `http://127.0.0.1:${port}`;
  console.log(`FlashMaker UI: ${url}`);
  if (shouldOpen) {
    void tryOpenBrowser(url);
  }
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname.startsWith('/api/')) {
      await handleApiRequest(request, response, url);
      return;
    }

    if (url.pathname.startsWith('/output/')) {
      await serveOutputFile(response, url.pathname);
      return;
    }

    await serveStaticFile(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: getErrorMessage(error) });
  }
}

async function handleApiRequest(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/pdfs') {
    const pdfPaths = await discoverPdfFiles(projectRoot);
    const items = await Promise.all(
      pdfPaths.map(async (pdfPath) => {
        const totalPages = await readPdfPageCount(pdfPath);
        return {
          path: pdfPath,
          fileName: path.basename(pdfPath),
          totalPages,
          inferredSourceName: deriveSourceNameFromFile(pdfPath),
          inferredSourceType: inferSourceType(path.basename(pdfPath)),
        };
      }),
    );
    sendJson(response, 200, { items, sourceTypes: SOURCE_TYPES });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/pdf-info') {
    const body = await readJsonBody(request);
    const pdfPath = await validatePdfPath(String(body.pdfPath ?? ''));
    const totalPages = await readPdfPageCount(pdfPath);
    sendJson(response, 200, {
      pdfPath,
      fileName: path.basename(pdfPath),
      totalPages,
      inferredSourceName: deriveSourceNameFromFile(pdfPath),
      inferredSourceType: inferSourceType(path.basename(pdfPath)),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/extract') {
    const body = await readJsonBody(request);
    const pdfPath = await validatePdfPath(String(body.pdfPath ?? ''));
    const sourceName = String(body.sourceName ?? '').trim();
    const sourceType = String(body.sourceType ?? '').trim();
    const sourceAuthors = String(body.sourceAuthors ?? '').trim();
    const sourceYear = String(body.sourceYear ?? '').trim();
    const sourceTitle = String(body.sourceTitle ?? '').trim();
    const sourceContainer = String(body.sourceContainer ?? '').trim();
    const pageStart = normalizePageNumber(body.pageStart, 'pageStart');
    const pageEnd = normalizePageNumber(body.pageEnd, 'pageEnd');
    const dpi = body.dpi == null || body.dpi === '' ? 150 : normalizePageNumber(body.dpi, 'dpi');
    const outputDir = path.resolve(
      body.outputDir
        ? String(body.outputDir)
        : path.join(projectRoot, 'output', buildRunDirectoryName(sourceName || deriveSourceNameFromFile(pdfPath))),
    );

    if (!sourceName) {
      throw new Error('sourceName e obrigatorio.');
    }
    if (!SOURCE_TYPES.includes(sourceType)) {
      throw new Error('sourceType invalido.');
    }

    await mkdir(outputDir, { recursive: true });
    const jobId = createJob('extract');
    startJob(jobId, 'python3', [
      path.join(projectRoot, 'scripts', 'extract_pdf_pages.py'),
      '--pdf',
      pdfPath,
      '--page-start',
      String(pageStart),
      '--page-end',
      String(pageEnd),
      '--source-name',
      sourceName,
      '--source-type',
      sourceType,
      '--source-authors',
      sourceAuthors,
      '--source-year',
      sourceYear,
      '--source-title',
      sourceTitle,
      '--source-container',
      sourceContainer,
      '--dpi',
      String(dpi),
      '--output-dir',
      outputDir,
    ], async () => {
      const metadata = JSON.parse(await readFile(path.join(outputDir, 'metadata.json'), 'utf8'));
      return {
        outputDir,
        metadata: withWebPaths(metadata),
      };
    });

    sendJson(response, 202, { jobId });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/generate') {
    const body = await readJsonBody(request);
    const inputDir = path.resolve(String(body.inputDir ?? ''));
    const theme = String(body.theme ?? '').trim();
    const model = String(body.model ?? '').trim();
    const promptOnly = Boolean(body.promptOnly);

    if (!theme) {
      throw new Error('theme e obrigatorio.');
    }

    await access(path.join(inputDir, 'metadata.json'));

    const args = [
      path.join(projectRoot, 'scripts', 'generate-flashcards.mjs'),
      '--input-dir',
      inputDir,
      '--theme',
      theme,
    ];

    if (promptOnly) {
      args.push('--prompt-only');
    }
    if (model) {
      args.push('--model', model);
    }

    const jobId = createJob(promptOnly ? 'prompt' : 'generate');
    startJob(jobId, 'node', args, async () => {
      const metadata = JSON.parse(await readFile(path.join(inputDir, 'metadata.json'), 'utf8'));
      const csvPath = path.join(inputDir, 'csv', 'flashcards.csv');
      const promptPath = path.join(inputDir, 'prompt.txt');
      return {
        inputDir,
        metadata: withWebPaths(metadata),
        promptPath: promptOnly ? promptPath : null,
        promptUrl: promptOnly ? toOutputWebPath(promptPath) : null,
        csvPath: !promptOnly ? csvPath : null,
        csvUrl: !promptOnly ? toOutputWebPath(csvPath) : null,
      };
    });
    sendJson(response, 202, { jobId });
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const jobId = url.pathname.replace('/api/jobs/', '');
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(response, 404, { error: 'Job nao encontrado.' });
      return;
    }
    sendJson(response, 200, serializeJob(job));
    return;
  }

  sendJson(response, 404, { error: 'Rota nao encontrada.' });
}

async function serveStaticFile(response, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(publicDir, cleanPath.replace(/^\/+/, ''));
  const content = await readFile(filePath);
  response.writeHead(200, { 'content-type': getContentType(filePath) });
  response.end(content);
}

async function serveOutputFile(response, pathname) {
  const relativePath = pathname.replace(/^\/output\//, '');
  const filePath = path.join(projectRoot, 'output', relativePath);
  const content = await readFile(filePath);
  response.writeHead(200, { 'content-type': getContentType(filePath) });
  response.end(content);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function normalizePageNumber(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} invalido.`);
  }
  return parsed;
}

function createJob(kind) {
  const jobId = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, {
    id: jobId,
    kind,
    status: 'running',
    log: '',
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return jobId;
}

function startJob(jobId, command, args, onSuccess) {
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error('Job nao encontrado.');
  }

  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const appendLog = (chunk) => {
    job.log += chunk.toString('utf8');
    job.updatedAt = new Date().toISOString();
  };

  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  child.on('error', (error) => {
    job.status = 'failed';
    job.error = getErrorMessage(error);
    job.updatedAt = new Date().toISOString();
  });
  child.on('exit', async (code) => {
    try {
      if (code !== 0) {
        job.status = 'failed';
        job.error = job.log.trim() || `${command} terminou com codigo ${code}.`;
        job.updatedAt = new Date().toISOString();
        return;
      }

      job.result = await onSuccess();
      job.status = 'completed';
      job.updatedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.error = getErrorMessage(error);
      job.updatedAt = new Date().toISOString();
    }
  });
}

function serializeJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    log: job.log,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function withWebPaths(metadata) {
  return {
    ...metadata,
    pages: metadata.pages.map((page) => ({
      ...page,
      imageUrl: toOutputWebPath(page.imagePath),
      textUrl: toOutputWebPath(page.textPath),
    })),
  };
}

function toOutputWebPath(filePath) {
  const relative = path.relative(path.join(projectRoot, 'output'), filePath);
  return `/output/${relative.split(path.sep).join('/')}`;
}

function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.txt') || filePath.endsWith('.csv')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function findAvailablePort(startPort) {
  let port = startPort;
  let lastError = null;
  while (port <= 65535) {
    const probe = await canListen(port);
    if (probe.ok) {
      return port;
    }
    lastError = probe.error;
    port += 1;
  }
  throw new Error(`Nao foi possivel encontrar uma porta livre a partir de ${startPort}.${lastError ? ` Ultimo erro: ${lastError}` : ''}`);
}

async function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => resolve({ ok: false, error: error.message }));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve({ ok: true, error: null }));
    });
  });
}

async function tryOpenBrowser(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
});
