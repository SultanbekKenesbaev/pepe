#!/bin/zsh
set -e
cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  echo 'Установите Node.js 22.12 или новее, затем откройте этот файл снова.'
  read -r '?Нажмите Enter для выхода'
  exit 1
fi
if [ ! -d node_modules ]; then
  npm ci --no-fund
fi
if [ ! -f .env ]; then
  cp .env.example .env
fi
echo 'AI Teacher: http://localhost:3000'
echo 'Чтобы остановить приложение, нажмите Control+C.'
node scripts/launch.mjs
