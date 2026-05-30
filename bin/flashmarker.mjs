#!/usr/bin/env node

import path from 'node:path';
import { stdout as output, stderr } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'start':
      await runPassthrough('node', [path.join(projectRoot, 'scripts', 'web-server.mjs'), ...args]);
      return;
    case 'extract':
      await runPassthrough('python3', [path.join(projectRoot, 'scripts', 'extract_pdf_pages.py'), ...args]);
      return;
    case 'generate':
      await runPassthrough('node', [path.join(projectRoot, 'scripts', 'generate-flashcards.mjs'), ...args]);
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Comando desconhecido: ${command}`);
  }
}

async function runPassthrough(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} terminou com codigo ${code}.`));
      }
    });
  });
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  output.write(`FlashMaker\n\n`);
  output.write(`Uso:\n`);
  output.write(`  flashmarker start\n`);
  output.write(`  flashmarker extract [args]\n`);
  output.write(`  flashmarker generate [args]\n`);
}

main().catch((error) => {
  stderr.write(`${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
