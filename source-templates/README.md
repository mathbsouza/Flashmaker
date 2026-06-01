# Source Templates

Cada subpasta representa um `sourceType`.

Estrutura:

```text
source-templates/
  FRMW2026/
    template.txt
  MeuTipoNovo/
    template.txt
```

Campos aceitos em `template.txt`:

```text
label=Nome exibido no select
Title do material=Texto do bloco .title
Tag=Prefixo antes do identificador da imagem. Ex.: Med_FRMW2026
reference img src=Identificador da imagem. Normalmente use {reference img src}
Autor=Autor padrao do bloco .source
Ano=Ano padrao do bloco .source
Nome do Documento=Titulo em italico do bloco .source
container=Container padrao do bloco .source
```

Placeholders suportados:

- `{Title do material}`
- `{Nome do Documento}`
- `{Tag}`
- `{reference img src}`
- `{Autor}`
- `{Ano}`
- `{{sourceName}}`
- `{{sourceType}}`

Exemplo:

```text
label=Ficha Resumo da Medway
Title do material=Ficha Resumo da Medway
Tag=Med_FRMW2026
reference img src={reference img src}
Autor=Medway
Ano=2026
Nome do Documento=Ficha Resumo do Extensivo R3 Clínica Médica: {Nome do Documento}
container=
```

Depois de editar ou criar templates, rode `npm run build` para atualizar a extensão.
