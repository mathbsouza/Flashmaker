# FlashMaker Chrome Extension

Extensao Chrome Manifest V3 para ler o PDF aberto na aba atual, extrair o texto das paginas selecionadas com PDF.js e montar um prompt de flashcards.

## Build

```bash
npm install
npm run build
```

O build final fica em:

```text
extension/dist
```

## Instalar no Chrome

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione `extension/dist`.

## Uso

1. Abra um PDF em uma aba do Chrome.
2. Clique no icone do FlashMaker.
3. Use o painel lateral para definir fonte, tema, DPI e paginas.
4. Clique em `Extrair PDF e gerar prompt`.
5. Copie o prompt gerado.

Para PDFs locais (`file://`), habilite `Permitir acesso a URLs de arquivo` nos detalhes da extensao.

## Arquivos principais

- `src/manifest.json`: manifest da extensao.
- `src/background.js`: service worker e criacao do documento offscreen.
- `src/offscreen.js`: leitura do PDF com PDF.js e geracao do prompt.
- `src/popup.html`, `src/popup.js`, `src/styles.css`: painel lateral da extensao.
