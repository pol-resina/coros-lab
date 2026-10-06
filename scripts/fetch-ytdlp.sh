#!/usr/bin/env bash
# Fetch the standalone yt-dlp binary into ./bin (no sudo, no python needed).
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p bin

URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"

echo "Fetching yt-dlp from $URL"
curl -fL --progress-bar -o bin/yt-dlp "$URL"
chmod +x bin/yt-dlp

echo "yt-dlp $(./bin/yt-dlp --version) installed at ./bin/yt-dlp"
