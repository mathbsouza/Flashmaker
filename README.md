# FlashMaker Chrome Extension

Extensao Chrome Manifest V3 para ler o PDF aberto na aba atual, extrair o texto das paginas selecionadas com PDF.js e montar um prompt de flashcards pronto para copiar.

## Build

Gerar a extensao:

```bash
npm install
npm run build
```

Depois carregue no Chrome:

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione a pasta `extension/dist`.

## Uso

1. Abra um PDF em uma aba do Chrome.
2. Clique no icone do FlashMaker.
3. Use o painel lateral para definir fonte, tema, DPI e paginas.
4. Clique em `Extrair PDF e gerar prompt`.
5. Copie o prompt gerado.

Para PDFs locais (`file://`), habilite `Permitir acesso a URLs de arquivo` nos detalhes da extensao em `chrome://extensions`.

## Arquivos principais

- `extension/src/manifest.json`: manifest da extensao.
- `extension/src/background.js`: service worker e criacao do documento offscreen.
- `extension/src/offscreen.js`: leitura do PDF com PDF.js e geracao do prompt.
- `extension/src/popup.html`, `extension/src/popup.js`, `extension/src/styles.css`: painel lateral da extensao.
