const PDF_VIEWER_HOST = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

export function sanitizeBaseName(value) {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\.+$/g, '')
    .trim();

  return cleaned || 'CropPDF';
}

export function deriveBaseNameFromPdfUrl(pdfUrl) {
  if (!pdfUrl) {
    return '';
  }

  try {
    const url = new URL(pdfUrl);
    const lastSegment = url.pathname.split('/').filter(Boolean).pop() || '';
    return sanitizeBaseName(
      safeDecodeURIComponent(lastSegment).replace(/\.pdf$/i, ''),
    );
  } catch {
    const lastSegment = String(pdfUrl)
      .split('?')[0]
      .split('#')[0]
      .split('/')
      .filter(Boolean)
      .pop();

    return sanitizeBaseName(String(lastSegment || '').replace(/\.pdf$/i, ''));
  }
}

export function deriveBaseNameFromTitle(title) {
  return sanitizeBaseName(String(title ?? '').replace(/\.pdf$/i, ''));
}

export function extractPdfUrlFromTabUrl(tabUrl) {
  if (!tabUrl) {
    return '';
  }

  try {
    const url = new URL(tabUrl);

    if (url.protocol === 'chrome-extension:' && url.hostname === PDF_VIEWER_HOST) {
      const fromSearch =
        url.searchParams.get('file') ||
        url.searchParams.get('src') ||
        url.searchParams.get('url');

      if (fromSearch) {
        return safeDecodeURIComponent(fromSearch);
      }

      const rawSearch = url.search.replace(/^\?/, '');
      const decodedSearch = safeDecodeURIComponent(rawSearch);
      if (/^(https?:|file:|blob:)/i.test(decodedSearch)) {
        return decodedSearch;
      }

      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
      const fromHash =
        hashParams.get('file') ||
        hashParams.get('src') ||
        hashParams.get('url');

      if (fromHash) {
        return safeDecodeURIComponent(fromHash);
      }
    }
  } catch {
    return tabUrl;
  }

  return tabUrl;
}

export function isLikelyPdfTab(tabUrl) {
  if (!tabUrl) {
    return false;
  }

  try {
    const url = new URL(tabUrl);

    if (url.protocol === 'chrome-extension:' && url.hostname === PDF_VIEWER_HOST) {
      return true;
    }

    if (url.protocol === 'blob:') {
      return true;
    }

    return /\.pdf($|[?#])/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function parsePageRange(pageStartText, pageEndText, totalPages) {
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error('O PDF nao tem paginas validas.');
  }

  const pageStart = Number(pageStartText);
  const pageEnd = Number(pageEndText);

  if (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd)) {
    throw new Error('Informe paginas inteiras.');
  }

  if (pageStart < 1 || pageEnd < 1) {
    throw new Error('As paginas precisam comecar em 1.');
  }

  if (pageStart > pageEnd) {
    throw new Error('A pagina inicial precisa ser menor ou igual a final.');
  }

  if (pageEnd > totalPages) {
    throw new Error(`A pagina final nao pode passar da pagina ${totalPages}.`);
  }

  return Array.from(
    { length: pageEnd - pageStart + 1 },
    (_, index) => pageStart + index,
  );
}

export function getPaddingWidth(totalPages) {
  return String(totalPages).length;
}

export function buildImageName(baseName, pageNumber, paddingWidth) {
  return `${baseName}-${String(pageNumber).padStart(paddingWidth, '0')}.jpg`;
}

export function buildZipName(baseName) {
  return `${baseName}_imagens.zip`;
}

export function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
