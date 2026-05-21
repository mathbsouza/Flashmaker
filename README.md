# CropPDF

Extensao Chrome em JavaScript puro para converter paginas selecionadas de um PDF aberto em JPG e baixar tudo em ZIP.

## Uso

1. Rode `npm install`.
2. Rode `npm run build`.
3. Abra `chrome://extensions`.
4. Ative o modo desenvolvedor.
5. Carregue a pasta `dist/` como extensao sem compactar.
6. Abra um PDF no Chrome.
7. Clique no CropPDF, informe nome-base, pagina inicial, pagina final e DPI.
8. Clique em `Gerar`.

## Observacoes

- O DPI padrao e `150`.
- A numeracao usa a quantidade total de paginas do PDF: um PDF com 4132 paginas gera `0001`, `0002`, etc.
- PDFs locais (`file://`) precisam da permissao `Permitir acesso a URLs de arquivo` na tela da extensao.
- Nao ha backend, Python ou Native Messaging. A conversao roda com `PDF.js`, `canvas` e `JSZip`.
