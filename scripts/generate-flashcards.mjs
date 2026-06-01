import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(options.inputDir);
  const metadataPath = path.join(inputDir, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const pages = await loadPages(metadata.pages);
  const csvPath = path.resolve(options.outputCsv ?? path.join(inputDir, 'csv', 'flashcards.csv'));

  await mkdir(path.dirname(csvPath), { recursive: true });

  const prompt = buildPrompt({
    theme: options.theme,
    sourceName: metadata.sourceName,
    sourceSlug: metadata.sourceSlug,
    sourceType: metadata.sourceType,
    bibliography: metadata.bibliography ?? {},
    pdfFileName: metadata.pdfFileName,
    totalPages: metadata.totalPages,
    pageStart: metadata.selectedRange.start,
    pageEnd: metadata.selectedRange.end,
    pages,
  });

  if (options.promptOnly) {
    const promptPath = path.resolve(options.promptOutput ?? path.join(inputDir, 'prompt.txt'));
    await writeFile(promptPath, `${prompt}\n`, 'utf8');
    console.log(`Prompt salvo em ${promptPath}`);
    return;
  }

  await runCodex({
    prompt,
    imagePaths: pages.map((page) => page.imagePath),
    outputCsvPath: csvPath,
    model: options.model,
  });

  console.log(`CSV salvo em ${csvPath}`);
}

function parseArgs(argv) {
  const values = {
    model: undefined,
    outputCsv: undefined,
    promptOnly: false,
    promptOutput: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--prompt-only') {
      values.promptOnly = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Argumento invalido: ${arg}`);
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) {
      throw new Error(`Valor ausente para --${key}`);
    }

    values[toCamelCase(key)] = next;
    index += 1;
  }

  if (!values.inputDir) {
    throw new Error('Parametro obrigatorio ausente: --input-dir');
  }
  if (!values.theme) {
    throw new Error('Parametro obrigatorio ausente: --theme');
  }

  return {
    inputDir: String(values.inputDir),
    theme: String(values.theme).trim(),
    outputCsv: values.outputCsv ? String(values.outputCsv) : undefined,
    model: values.model ? String(values.model).trim() : undefined,
    promptOnly: Boolean(values.promptOnly),
    promptOutput: values.promptOutput ? String(values.promptOutput) : undefined,
  };
}

async function loadPages(pageEntries) {
  return Promise.all(
    pageEntries.map(async (page) => ({
      ...page,
      text: await readFile(page.textPath, 'utf8'),
    })),
  );
}

function buildPrompt({
  theme,
  sourceName,
  sourceSlug,
  sourceType,
  bibliography,
  pdfFileName,
  totalPages,
  pageStart,
  pageEnd,
  pages,
}) {
  const pageBlocks = pages
    .map((page) => {
      const excerpt = page.text.trim() || '[Sem texto extraido desta pagina]';
      return [
        `### PAGINA_VISUAL_${page.visualPage}`,
        `ARQUIVO_IMAGEM: ${page.imageFileName}`,
        `TEXTO_EXTRAIDO:`,
        excerpt,
      ].join('\n');
    })
    .join('\n\n');

  return `
Você é um especialista em educação médica e criação de flashcards para provas de residência médica/R3.

Vou enviar um artigo, guideline, capítulo, resumo, ficha-resumo, apostila ou material de estudo em PDF ou texto. Sua tarefa é gerar um arquivo CSV com poucos flashcards do tipo BASIC, voltados exclusivamente para MEMORIZAÇÃO intensiva de itens high-yield.

TEMA DO DECK:
${theme}

OBJETIVO:
Criar flashcards apenas sobre informações que precisam ser decoradas para prova e que não seriam facilmente aprendidas apenas pela resolução de questões. Priorize dados objetivos, cortes, critérios, tempos, exceções, indicações formais, contraindicações, sequências terapêuticas, testes preferenciais, definições operacionais e detalhes fáceis de esquecer.

CONTEXTO DE ENTRADA:
- Nome do arquivo PDF: ${pdfFileName}
- Tipo da fonte já determinado: ${sourceType}
- Source name obrigatório definido pelo usuário: ${sourceName}
- Identificador obrigatório para o nome das imagens: ${sourceSlug}
- Referência bibliográfica base definida pelo usuário:
  - Autores/sociedade: ${bibliography.authors || '[Autor não informado]'}
  - Ano: ${bibliography.year || '[Ano não informado]'}
  - Título completo: ${bibliography.title || sourceName}
  - Periódico/livro/instituição: ${bibliography.container || '[Fonte não informada]'}
- Páginas visuais selecionadas do PDF: ${pageStart}-${pageEnd}
- Total de páginas do PDF: ${totalPages}

REGRA ADICIONAL OBRIGATÓRIA SOBRE SOURCE NAME:
- Use o source name definido pelo usuário como base obrigatória do título padronizado da fonte e do identificador [TituloOuIdentificador].
- Não substitua esse nome por outro mais curto.
- Preserve o source name como referência principal mesmo se o PDF trouxer outro título interno, exceto quando as regras especiais de FRMW2026, AMW2026 ou UTD exigirem prefixos específicos.
- Para o campo <img src="">, use obrigatoriamente o identificador ${sourceSlug}.

FORMATO OBRIGATÓRIO DO CSV:
PERGUNTA,DICA,RESPOSTA,EXPLICAÇÃO,FONTE

REGRAS GERAIS:
- Gere poucos flashcards.
- Cada flashcard deve testar uma única informação principal.
- Os flashcards devem ser do tipo BASIC.
- A pergunta deve ser direta.
- A dica deve ajudar sem entregar a resposta.
- A resposta deve ser objetiva e curta.
- A explicação deve ser breve, focada no motivo pelo qual o item é relevante para prova.
- Use linguagem médica precisa.
- Evite cards de raciocínio clínico amplo.
- Evite perguntas vagas como “qual a conduta?” sem cenário específico.
- Não crie cards sobre informações óbvias, intuitivas ou facilmente dedutíveis.
- Não crie cards excessivamente longos.
- Não invente informações que não estejam no material enviado.
- Não misture múltiplos conceitos independentes no mesmo card.
- Não gere cards apenas para aumentar volume.
- Se o material tiver pouca coisa realmente memorizável dentro do tema definido, gere poucos cards ou até nenhum.
- Restrinja os flashcards ao TEMA DO DECK. Ignore informações fora do tema, mesmo que sejam high-yield.

REGRAS DE HTML:
- Todos os campos do CSV podem conter HTML.
- A RESPOSTA deve estar sempre em HTML.
- A RESPOSTA pode usar <p> ou <ul>, mas deve ser sempre direta.
- Use <p> para respostas curtas.
- Use <ul><li>...</li></ul> apenas quando a resposta exigir lista.
- A EXPLICAÇÃO também deve estar em HTML, preferencialmente em <p>.
- A FONTE deve estar obrigatoriamente em HTML.
- Escape aspas duplas internas conforme necessário para manter o CSV válido.

MODELO DE RESPOSTA CURTA:
<p>Resposta direta aqui.</p>

MODELO DE RESPOSTA EM LISTA:
<ul>
    <li>Item 1</li>
    <li>Item 2</li>
    <li>Item 3</li>
</ul>

MODELO OBRIGATÓRIO DA FONTE:
<div class="quote">
    <div class="title">
        [Título padronizado da fonte]
    </div>
    <hr>
    <div class="reference">
        <img src="Med_[TipoDaFonte]_[TituloOuIdentificador]-[PaginaVisual].jpg">
    </div>
    <hr>
    <div class="source">
        [Autores ou sociedade responsável]. ([Ano]). <i>[Título completo]</i>. [Periódico, livro, guideline, sociedade, editora ou instituição, se disponível].
    </div>
</div>

REGRA CRÍTICA SOBRE PÁGINAS E REFERÊNCIA BIBLIOGRÁFICA:
- A página visual deve aparecer APENAS no campo <img src="">.
- NÃO colocar “p. X”, “página X”, “page X” ou qualquer paginação no texto bibliográfico da <div class="source">.
- A <div class="source"> deve conter somente a referência bibliográfica da obra, sem página específica.
- A página específica do flashcard será indicada exclusivamente pelo nome do arquivo da imagem em <img src="">.
- O campo <img src=""> deve usar a página visual do PDF/material, não a paginação interna do artigo, periódico, revista ou livro.
- Se a informação estiver na primeira página do PDF, use “01”, mesmo que o artigo mostre paginação de revista como “988”.
- Se a informação estiver na segunda página do PDF, use “02”, mesmo que o artigo mostre paginação de revista como “989”.
- Se o PDF tiver 24 páginas, a página visual deve ser tratada como 01 a 24, salvo se houver numeração visual própria claramente impressa no material.
- Mantenha dois dígitos quando o material tiver páginas visuais em dois dígitos: 01, 02, 03, 04 etc.
- Não invente página. Se não for possível identificar a página visual, use “[PaginaVisualNaoIdentificada]” no nome da imagem.

REGRAS PARA IDENTIFICAR O TIPO DA FONTE:
- O tipo da fonte já foi determinado previamente pelo app. Use exatamente este valor: ${sourceType}.
- Se houver conflito entre o título visual interno e o nome do arquivo, o nome do arquivo tem prioridade para definir o tipo da fonte.
- O título visual interno do PDF pode ajudar na referência bibliográfica, mas não deve substituir o tipo da fonte.

REGRA ESPECIAL PARA FICHAS-RESUMO DA MEDWAY 2026:
- Se o tipo da fonte for FRMW2026, trate obrigatoriamente o material como “Ficha Resumo do Extensivo R3 Clínica Médica”.
- Nesse caso, o [TipoDaFonte] deve ser sempre “FRMW2026”.
- A <div class="title"> deve seguir o padrão:
  Ficha Resumo da Medway
- A <div class="source"> deve seguir o padrão:
  Medway (2026). <i>Ficha Resumo do Extensivo R3 Clínica Médica: ${sourceName}</i>. Medway.
- O campo <img src=""> deve preservar o padrão:
  Med_FRMW2026_${sourceSlug}-[PaginaVisual].jpg

REGRA ESPECIAL PARA APOSTILAS DA MEDWAY 2026:
- Se o tipo da fonte for AMW2026, trate obrigatoriamente o material como “Apostila da Medway 2026”.
- Nesse caso, o [TipoDaFonte] deve ser sempre “AMW2026”.
- A <div class="title"> deve seguir o padrão:
  Apostila da Medway 2026: ${sourceName}
- A <div class="source"> deve seguir o padrão:
  Medway (2026). <i>Apostila da Medway 2026: ${sourceName}</i>. Medway.
- O campo <img src=""> deve preservar o padrão:
  Med_AMW2026_${sourceSlug}-[PaginaVisual].jpg

REGRA ESPECIAL PARA UPTODATE:
- Se o tipo da fonte for UTD, trate como UpToDate.
- Nesse caso, o [TipoDaFonte] deve ser sempre “UTD”.
- A <div class="title"> deve usar ${sourceName}.
- A <div class="source"> deve conter os autores, ano e título quando disponíveis.
- Se algum dado não estiver disponível, use “[Autor não informado]” ou “[Ano não informado]”; não invente.

REGRAS PARA PREENCHER A FONTE:
- Cite a fonte em todos os flashcards.
- Use como base prioritária os dados bibliográficos definidos pelo usuário acima.
- Use os dados bibliográficos reais do material enviado.
- Se algum dado bibliográfico não estiver disponível, não invente; use uma descrição genérica e clara, como “[Autor não informado]” ou “[Ano não informado]”.
- Quando vários flashcards vierem da mesma fonte, repita a mesma estrutura HTML da fonte, mudando apenas a página visual no campo <img src=""> quando necessário.
- Não coloque página no texto da referência bibliográfica.
- Não use paginação de periódico, como 988, 989, 1000 etc., no nome da imagem, se essa paginação for diferente da página visual do PDF/material.

REGRAS PARA O CAMPO <img src=""> DA FONTE:
- O atributo src deve seguir o padrão:
  Med_[TipoDaFonte]_[TituloOuIdentificador]-[PaginaVisual].jpg
- “Med” indica que o conteúdo é da área médica.
- “[TipoDaFonte]” deve indicar a natureza do material e já foi fixado como ${sourceType}.
- “[TituloOuIdentificador]” deve usar obrigatoriamente ${sourceSlug}.
- “[PaginaVisual]” deve ser a página visual do material:
  - use 01, 02, 03 etc. quando o PDF tiver essa estrutura;
  - use a numeração que aparece visualmente no material quando houver;
  - não use paginação de periódico/livro se ela for diferente da página visual do PDF;
  - não inclua “p.”, “page”, “pagina” ou qualquer prefixo; use apenas o número ou identificador visual.

CRITÉRIOS DE SELEÇÃO DOS FLASHCARDS:
Inclua apenas itens como:
- idade de corte;
- tempo mínimo;
- critérios diagnósticos;
- teste de escolha;
- teste inadequado;
- indicação formal;
- contraindicação;
- exceção importante;
- sequência terapêutica;
- achado clássico;
- definição operacional;
- conduta específica após falha de tratamento;
- marcador, escore ou classificação que precise ser memorizado;
- detalhe que muda a resposta da prova;
- dado que costuma ser cobrado de forma literal.

NÃO INCLUIR:
- explicações longas;
- fisiopatologia extensa;
- raciocínios clínicos completos;
- informações meramente contextuais;
- detalhes que não mudam conduta;
- conteúdo que seria naturalmente aprendido por repetição de questões;
- cards com múltiplas respostas aceitáveis;
- cards baseados em inferência não explicitada no material;
- informações fora do TEMA DO DECK.

REGRAS ESPECÍFICAS PARA PROVA DE R3:
- Priorize itens que diferenciam condutas parecidas.
- Priorize exceções e pegadinhas de diretriz.
- Priorize cortes etários, tempos de tratamento, intervalos de controle e critérios formais.
- Evite cards básicos demais para R3, exceto se forem altamente cobrados e fáceis de esquecer.
- O foco é memorização seca e retenção de longo prazo, não revisão conceitual ampla.

SAÍDA:
- Gere um arquivo .csv válido.
- Use codificação UTF-8.
- A primeira linha deve ser o cabeçalho:
PERGUNTA,DICA,RESPOSTA,EXPLICAÇÃO,FONTE
- Cada flashcard deve ocupar uma linha.
- Coloque todos os campos entre aspas duplas.
- Escape aspas duplas internas duplicando-as.
- Não escreva comentários fora do CSV.
- Não explique o que você fez; entregue apenas o CSV.

Agora gere o CSV a partir do material abaixo. Use somente informações presentes nas páginas fornecidas.

${pageBlocks}
`.trim();
}

async function runCodex({ prompt, imagePaths, outputCsvPath, model }) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'croppdf-codex-'));
  const promptPath = path.join(tempDir, 'prompt.txt');

  try {
    await writeFile(promptPath, `${prompt}\n`, 'utf8');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--output-last-message',
      outputCsvPath,
    ];

    if (model) {
      args.push('--model', model);
    }

    for (const imagePath of imagePaths) {
      args.push('--image', imagePath);
    }

    args.push('-');

    await spawnAndWait('codex', args, {
      cwd: projectRoot,
      stdinFile: promptPath,
    });

    const csv = await readFile(outputCsvPath, 'utf8');
    if (!csv.trimStart().startsWith('PERGUNTA,DICA,RESPOSTA,EXPLICAÇÃO,FONTE')) {
      throw new Error('O Codex nao retornou um CSV no formato esperado.');
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function spawnAndWait(command, args, { cwd, stdinFile }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} terminou com codigo ${code}.`));
      }
    });

    const stream = createReadStream(stdinFile, { encoding: 'utf8' });
    stream.on('error', reject);
    stream.pipe(child.stdin);
  });
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
