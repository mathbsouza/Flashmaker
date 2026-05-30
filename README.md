# FlashMaker

App local para transformar trechos de PDF em um prompt pronto para gerar flashcards no ChatGPT.

Estrutura do projeto:

- `bin/`: comando local `flashmarker`
- `scripts/`: extracao do PDF, geracao do prompt/CSV e servidor web local
- `web/`: interface local
- `extension/`: legado da extensao Chrome, isolado do app principal
- `output/`: saidas geradas

## Comando principal

```bash
flashmarker start
```

Isso sobe a UI local e abre no navegador. A interface permite:

- escolher um PDF encontrado automaticamente;
- definir `source name`, tema, tipo da fonte, DPI e intervalo de páginas;
- extrair imagens e texto por página;
- revisar o preview das páginas e da fonte;
- gerar um `prompt.txt` pronto para copiar em um único fluxo.

Por padrão, tudo fica em uma única pasta:

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

Depois disso, `flashmarker` fica disponível no terminal.

## Comandos técnicos

Extrair:

```bash
flashmarker extract --pdf arquivo.pdf --page-start 1 --page-end 3 --source-name "Tema" --output-dir ./output/teste
```

Gerar:

```bash
flashmarker generate --input-dir ./output/teste --theme "Tema"
```

## Saídas

- `images/`: JPG de cada página selecionada
- `text/`: TXT por página
- `metadata.json`: metadados do processamento
- `prompt.txt`: prompt final, quando rodar em modo prompt-only
- `csv/flashcards.csv`: CSV final

Cada nova extração sobrescreve os arquivos dessa pasta padrão.

## Extensão antiga

A extensão antiga permanece apenas como legado técnico em `extension/`.

Build da extensão:

```bash
npm run build
```
