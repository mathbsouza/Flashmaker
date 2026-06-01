import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const SOURCE_TEMPLATES_DIR_NAME = 'source-templates';
export const SOURCE_TEMPLATE_FILE_NAME = 'template.txt';

const KEY_ALIASES = new Map([
  ['previewtitle', 'materialTitleTemplate'],
  ['preview_title', 'materialTitleTemplate'],
  ['titletemplate', 'documentNameTemplate'],
  ['title_template', 'documentNameTemplate'],
  ['title do material', 'materialTitleTemplate'],
  ['autor', 'authorTemplate'],
  ['ano', 'year'],
  ['authors', 'authorTemplate'],
  ['nome do documento', 'documentNameTemplate'],
  ['tag', 'tagTemplate'],
  ['reference img src', 'referenceImageTemplate'],
]);

const FALLBACK_SOURCE_TYPES = ['Livro', 'Capitulo', 'Artigos', 'Guidelines', 'FRMW2026', 'AMW2026', 'UTD'];

export async function loadSourceTemplates(projectRoot) {
  const templatesDir = path.join(projectRoot, SOURCE_TEMPLATES_DIR_NAME);
  const entries = await readdir(templatesDir, { withFileTypes: true }).catch(() => []);
  const templates = {};

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    const templatePath = path.join(templatesDir, entry.name, SOURCE_TEMPLATE_FILE_NAME);
    const text = await readFile(templatePath, 'utf8').catch(() => null);
    if (!text) {
      continue;
    }

    templates[entry.name] = normalizeTemplate(entry.name, parseTemplateText(text));
  }

  if (Object.keys(templates).length > 0) {
    return templates;
  }

  for (const type of FALLBACK_SOURCE_TYPES) {
    templates[type] = normalizeTemplate(type, {});
  }
  return templates;
}

export function listSourceTypes(templates) {
  return Object.keys(templates);
}

export function normalizeTemplate(type, partialTemplate) {
  const typeName = String(type ?? '').trim() || 'Outros';
  const materialTitleTemplate = String(partialTemplate.materialTitleTemplate ?? '{Title do material}').trim() || '{Title do material}';
  const authorTemplate = String(partialTemplate.authorTemplate ?? '').trim();
  const documentNameTemplate = String(partialTemplate.documentNameTemplate ?? '{Nome do Documento}').trim() || '{Nome do Documento}';
  return {
    type: typeName,
    label: String(partialTemplate.label ?? typeName).trim() || typeName,
    materialTitleTemplate,
    previewTitle: materialTitleTemplate,
    authorTemplate,
    authors: authorTemplate,
    year: String(partialTemplate.year ?? '').trim(),
    documentNameTemplate,
    titleTemplate: documentNameTemplate,
    tagTemplate: String(partialTemplate.tagTemplate ?? '{Tag}').trim() || '{Tag}',
    referenceImageTemplate: String(partialTemplate.referenceImageTemplate ?? '{reference img src}').trim() || '{reference img src}',
    container: String(partialTemplate.container ?? '').trim(),
  };
}

export function renderTemplateString(template, context) {
  const replacements = [
    ['{{sourceName}}', String(context?.sourceName ?? '').trim()],
    ['{{sourceType}}', String(context?.sourceType ?? '').trim()],
    ['{Title do material}', String(context?.materialTitle ?? context?.sourceName ?? '').trim()],
    ['{Nome do Documento}', String(context?.documentName ?? context?.sourceName ?? '').trim()],
    ['{Tag}', String(context?.tag ?? context?.sourceType ?? '').trim()],
    ['{reference img src}', String(context?.referenceImageSrc ?? context?.imageIdentifier ?? '').trim()],
    ['{Autor}', String(context?.author ?? context?.authors ?? '').trim()],
    ['{Ano}', String(context?.publicationYear ?? context?.year ?? '').trim()],
  ];

  return replacements.reduce((result, [token, value]) => result.split(token).join(value), String(template ?? ''));
}

function parseTemplateText(text) {
  const parsed = {};

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const rawKey = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const normalizedKey = KEY_ALIASES.get(rawKey.toLowerCase()) ?? rawKey;

    parsed[normalizedKey] = rawValue;
  }

  return parsed;
}
