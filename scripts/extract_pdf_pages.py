#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extrai JPG e TXT por pagina de um PDF para o pipeline de flashcards."
    )
    parser.add_argument("--pdf", required=True, help="Caminho do PDF")
    parser.add_argument("--page-start", required=True, type=int, help="Pagina inicial")
    parser.add_argument("--page-end", required=True, type=int, help="Pagina final")
    parser.add_argument("--source-name", required=True, help="Nome da source")
    parser.add_argument("--source-type", help="Tipo da fonte")
    parser.add_argument("--source-authors", default="", help="Autores ou sociedade")
    parser.add_argument("--source-year", default="", help="Ano da referencia")
    parser.add_argument("--source-title", default="", help="Titulo completo da obra")
    parser.add_argument("--source-container", default="", help="Livro, periodico ou instituicao")
    parser.add_argument("--dpi", type=int, default=150, help="DPI das imagens")
    parser.add_argument("--output-dir", required=True, help="Pasta de saida")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pdf_path = Path(args.pdf).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    images_dir = output_dir / "images"
    text_dir = output_dir / "text"
    metadata_path = output_dir / "metadata.json"
    csv_dir = output_dir / "csv"
    prompt_path = output_dir / "prompt.txt"

    prepare_output_dir(output_dir, images_dir, text_dir, csv_dir, metadata_path, prompt_path)

    source_name = args.source_name.strip()
    if not source_name:
        raise ValueError("--source-name nao pode ser vazio.")

    source_type = determine_source_type(pdf_path.name, args.source_type)
    source_slug = slugify(source_name)
    total_pages = read_total_pages(pdf_path)
    validate_page_range(args.page_start, args.page_end, total_pages)
    padding = max(2, len(str(total_pages)))
    image_base_name = f"Med_{source_type}_{source_slug}"
    pages = []

    for page_number in range(args.page_start, args.page_end + 1):
        visual_page = str(page_number).zfill(padding)
        image_file_name = f"{image_base_name}-{visual_page}.jpg"
        text_file_name = f"{image_base_name}-{visual_page}.txt"
        image_path = images_dir / image_file_name
        text_path = text_dir / text_file_name

        print(f"Processando pagina {page_number} ({page_number - args.page_start + 1}/{args.page_end - args.page_start + 1})")

        text = extract_page_text(pdf_path=pdf_path, page_number=page_number)
        text_path.write_text(f"{text}\n" if text else "", encoding="utf-8")

        render_page_to_jpeg(
            pdf_path=pdf_path,
            page_number=page_number,
            dpi=args.dpi,
            output_path=image_path,
        )

        pages.append(
            {
                "pageNumber": page_number,
                "visualPage": visual_page,
                "imageFileName": image_file_name,
                "imagePath": str(image_path),
                "textFileName": text_file_name,
                "textPath": str(text_path),
            }
        )

    metadata = {
        "pdfPath": str(pdf_path),
        "pdfFileName": pdf_path.name,
        "totalPages": total_pages,
        "selectedRange": {"start": args.page_start, "end": args.page_end},
        "sourceName": source_name,
        "sourceSlug": source_slug,
        "sourceType": source_type,
        "imageBaseName": image_base_name,
        "bibliography": {
            "authors": args.source_authors.strip(),
            "year": args.source_year.strip(),
            "title": args.source_title.strip(),
            "container": args.source_container.strip(),
        },
        "dpi": args.dpi,
        "outputDir": str(output_dir),
        "pages": pages,
    }
    metadata_path.write_text(f"{json.dumps(metadata, indent=2, ensure_ascii=False)}\n", encoding="utf-8")

    print(f"TXT e imagens salvos em {output_dir}")
    print(f"Metadata salva em {metadata_path}")
    return 0


def validate_page_range(page_start: int, page_end: int, total_pages: int) -> None:
    if page_start < 1 or page_end < 1:
        raise ValueError("As paginas precisam comecar em 1.")
    if page_start > page_end:
        raise ValueError("A pagina inicial precisa ser menor ou igual a final.")
    if page_end > total_pages:
        raise ValueError(f"A pagina final nao pode passar da pagina {total_pages}.")


def determine_source_type(pdf_file_name: str, explicit_type: str | None) -> str:
    if explicit_type:
        return explicit_type.strip()
    if re.match(r"^Med_FRMW2026_", pdf_file_name, re.IGNORECASE):
        return "FRMW2026"
    if re.match(r"^Med_AMW2026_", pdf_file_name, re.IGNORECASE):
        return "AMW2026"
    if re.match(r"^Med_UTD_", pdf_file_name, re.IGNORECASE):
        return "UTD"
    if re.match(r"^Med_Livro_", pdf_file_name, re.IGNORECASE) or re.match(r"^Med_Livros_", pdf_file_name, re.IGNORECASE):
        return "Livro"
    if re.match(r"^Med_Capitulo_", pdf_file_name, re.IGNORECASE):
        return "Capitulo"
    if re.match(r"^Med_Guideline_", pdf_file_name, re.IGNORECASE) or re.match(r"^Med_Guidelines_", pdf_file_name, re.IGNORECASE):
        return "Guidelines"
    if re.match(r"^Med_Artigo_", pdf_file_name, re.IGNORECASE) or re.match(r"^Med_Artigos_", pdf_file_name, re.IGNORECASE):
        return "Artigos"
    return "Artigos"


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    without_accents = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    slug = re.sub(r"[^A-Za-z0-9]+", "-", without_accents).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    return slug or "Fonte"


def prepare_output_dir(
    output_dir: Path,
    images_dir: Path,
    text_dir: Path,
    csv_dir: Path,
    metadata_path: Path,
    prompt_path: Path,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    for directory in (images_dir, text_dir, csv_dir):
        if directory.exists():
            shutil.rmtree(directory)

    for file_path in (metadata_path, prompt_path):
        if file_path.exists():
            file_path.unlink()

    images_dir.mkdir(parents=True, exist_ok=True)
    text_dir.mkdir(parents=True, exist_ok=True)


def read_total_pages(pdf_path: Path) -> int:
    command = ["pdfinfo", str(pdf_path)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"Falha ao ler total de paginas: {stderr}")

    for line in result.stdout.splitlines():
        if line.startswith("Pages:"):
            value = line.split(":", 1)[1].strip()
            total_pages = int(value)
            if total_pages < 1:
                break
            return total_pages

    raise RuntimeError("Nao foi possivel identificar o total de paginas do PDF.")


def extract_page_text(pdf_path: Path, page_number: int) -> str:
    command = [
        "pdftotext",
        "-f",
        str(page_number),
        "-l",
        str(page_number),
        "-layout",
        str(pdf_path),
        "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"Falha ao extrair texto da pagina {page_number}: {stderr}")
    return result.stdout.strip()


def render_page_to_jpeg(pdf_path: Path, page_number: int, dpi: int, output_path: Path) -> None:
    output_stem = output_path.with_suffix("")
    command = [
        "pdftocairo",
        "-jpeg",
        "-singlefile",
        "-r",
        str(dpi),
        "-f",
        str(page_number),
        "-l",
        str(page_number),
        str(pdf_path),
        str(output_stem),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"Falha ao renderizar pagina {page_number}: {stderr}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
