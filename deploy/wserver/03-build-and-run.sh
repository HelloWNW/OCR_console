#!/usr/bin/env bash
# Run inside Ubuntu-24.04 WSL distro on wserver:
#   wsl -d Ubuntu-24.04 -- bash /mnt/c/Docker/OCR_console/deploy/wserver/03-build-and-run.sh
#
# Requires DVD_API_KEY to be exported first (the key also gets noted in the
# Cloudflare DNS record comment for api.hello-wnw.org — see
# deploy/cloudflare/setup-dns-access.sh). Requires HF_TOKEN only if the
# hanquansanren/DvD checkpoints repo is ever made private; it's public today.
set -euo pipefail
cd "$(dirname "$0")/../../backend"

docker build -t ocr:latest .

docker volume create ocr-checkpoints >/dev/null

docker rm -f OCR 2>/dev/null || true

docker run -d \
  --name OCR \
  --hostname OCR \
  --gpus 'device=1' \
  --restart unless-stopped \
  -p 127.0.0.1:8000:8000 \
  -v ocr-checkpoints:/opt/dvd/repo/checkpoints \
  -e DVD_API_KEY="${DVD_API_KEY:?export DVD_API_KEY before running this script}" \
  -e DVD_IDLE_TIMEOUT_SECONDS="${DVD_IDLE_TIMEOUT_SECONDS:-600}" \
  -e DVD_ALLOWED_ORIGINS="${DVD_ALLOWED_ORIGINS:-https://hello-wnw.org}" \
  -e HF_TOKEN="${HF_TOKEN:-}" \
  ocr:latest

echo "Container 'OCR' is up, bound to 127.0.0.1:8000 (loopback only)."
echo "Native Caddy on the Windows side reverse-proxies api.hello-wnw.org to that port."
echo "GPU stays empty until the first real request — check with: curl -s http://127.0.0.1:8000/health"
