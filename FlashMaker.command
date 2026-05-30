#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
LOG_DIR="$SCRIPT_DIR/output/flashmaker"
LOG_FILE="$LOG_DIR/flashmaker-launch.log"
mkdir -p "$LOG_DIR"

if [ -f "$HOME/.zprofile" ]; then
  source "$HOME/.zprofile" >/dev/null 2>&1 || true
fi

if [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc" >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nao encontrado no PATH."
  echo "PATH atual: $PATH"
  echo "Instale o Node.js e tente novamente."
  read -r "?Pressione Enter para fechar..."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm nao encontrado no PATH."
  echo "Instale o Node.js completo e tente novamente."
  read -r "?Pressione Enter para fechar..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Dependencias nao encontradas. Rodando npm install..."
  npm install
fi

echo "Abrindo FlashMaker..."
if ! node bin/flashmarker.mjs start >>"$LOG_FILE" 2>&1; then
  echo ""
  echo "Falha ao abrir o FlashMaker."
  echo "Veja o log em: $LOG_FILE"
  tail -n 40 "$LOG_FILE" || true
  read -r "?Pressione Enter para fechar..."
  exit 1
fi
