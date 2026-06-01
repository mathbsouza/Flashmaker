# FlashMaker

Extensao Chrome para transformar trechos de PDF em um prompt pronto para gerar flashcards no ChatGPT. O projeto tambem mantem um modo local via CLI para desenvolvimento e automacoes.

Estrutura do projeto:

- `bin/`: comando local `flashmarker`
- `scripts/`: extracao do PDF, geracao do prompt/CSV e servidor web local
- `web/`: interface local de desenvolvimento
- `extension/`: extensao Chrome Manifest V3
- `output/`: saidas geradas

## Extensao Chrome

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

Uso:

1. Abra um PDF em uma aba do Chrome.
2. Clique no icone da extensao para abrir o painel lateral.
3. Preencha tema, fonte e intervalo de paginas.
4. Gere e copie o prompt.

Para PDFs locais (`file://`), habilite `Permitir acesso a URLs de arquivo` nos detalhes da extensao em `chrome://extensions`.

## Modo local

```bash
flashmarker start
```

Isso sobe a UI local e abre no navegador. A interface permite:

- escolher um PDF encontrado automaticamente;
- definir `source name`, tema, tipo da fonte, DPI e intervalo de paginas;
- extrair imagens e texto por pagina;
- revisar o preview das paginas e da fonte;
- gerar um `prompt.txt` pronto para copiar em um unico fluxo.

Por padrao, tudo fica em uma unica pasta:

- `output/flashmaker/`

Se preferir sem `npm link`:

```bash
node bin/flashmarker.mjs start
```

No macOS, tambem da para abrir pelo executavel:

```bash
./FlashMaker.command
```

Ou com duplo clique no arquivo `FlashMaker.command`.

## Como habilitar o comando

```bash
npm link
```

Depois disso, `flashmarker` fica disponivel no terminal.

## Comandos tecnicos

Extrair:

```bash
flashmarker extract --pdf arquivo.pdf --page-start 1 --page-end 3 --source-name "Tema" --output-dir ./output/teste
```

Gerar:

```bash
flashmarker generate --input-dir ./output/teste --theme "Tema"
```

## Saidas

- `images/`: JPG de cada pagina selecionada
- `text/`: TXT por pagina
- `metadata.json`: metadados do processamento
- `prompt.txt`: prompt final, quando rodar em modo prompt-only
- `csv/flashcards.csv`: CSV final

Cada nova extracao sobrescreve os arquivos dessa pasta padrao.

## Build tecnico

O comando `npm run build` empacota a extensao Manifest V3 em `extension/dist`.
