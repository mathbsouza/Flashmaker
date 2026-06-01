import { SOURCE_TEMPLATES } from './generated/source-templates.js';

export const SOURCE_TYPE_OPTIONS = Object.entries(SOURCE_TEMPLATES).map(([value, template]) => ({
  value,
  label: template.label || value,
}));

export function getSourceTemplate(sourceType) {
  return SOURCE_TEMPLATES[sourceType] ?? {
    type: sourceType,
    label: sourceType,
    materialTitleTemplate: '{Title do material}',
    previewTitle: '{Title do material}',
    authorTemplate: '',
    authors: '',
    year: '',
    documentNameTemplate: '{Nome do Documento}',
    titleTemplate: '{Nome do Documento}',
    tagTemplate: '{Tag}',
    referenceImageTemplate: '{reference img src}',
    container: '',
  };
}

export function buildSourceTemplateContext({ sourceType, sourceName, imageIdentifier }) {
  const documentName = String(sourceName ?? '').trim();
  const referenceImageSrc = String(imageIdentifier ?? documentName).trim();
  return {
    sourceName: documentName,
    sourceType,
    materialTitle: documentName,
    documentName,
    tag: `Med_${sourceType}`,
    referenceImageSrc,
    imageIdentifier: referenceImageSrc,
  };
}

export function renderSourceTemplate(template, context) {
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
