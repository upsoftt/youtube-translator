#!/usr/bin/env bash
# Запуск CosyVoice TTS сервера через WSL2 Ubuntu-22.04.
# Из Windows: wsl -d Ubuntu-22.04 -- bash /root/start_cosyvoice.sh
# Или напрямую в WSL2: bash /root/start_cosyvoice.sh

export PATH="/root/miniforge3/bin:$PATH"
eval "$(conda shell.bash hook)"
conda activate cosyvoice

set -a
source /root/cosyvoice_server/.env
set +a

export COSYVOICE_DIR=/root/CosyVoice
export COSYVOICE_MODEL_DIR=/root/CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " CosyVoice TTS Server"
echo " Port:    ${PORT:-8020}"
echo " Model:   $COSYVOICE_MODEL_DIR"
echo " API Key: ${COSYVOICE_API_KEY:0:8}..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

python3 /root/cosyvoice_server/server.py
