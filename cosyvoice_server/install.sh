#!/usr/bin/env bash
# Полная установка CosyVoice3 + зависимостей в WSL2 Ubuntu.
# Запускается автоматически. Логи: /tmp/cosyvoice_install.log

set -e
LOG=/tmp/cosyvoice_install.log
exec > >(tee -a "$LOG") 2>&1

echo "======================================"
echo " CosyVoice Install $(date)"
echo "======================================"

# ── 1. Системные зависимости ───────────────────────────────────────────────
echo "[1/7] Системные пакеты..."
apt-get update -qq
apt-get install -y -qq \
    git curl wget ffmpeg sox libsox-dev \
    build-essential cmake \
    python3.10 python3.10-venv python3-pip \
    2>/dev/null

# ── 2. Miniforge (conda без лицензионных ограничений) ─────────────────────
if ! command -v conda &>/dev/null; then
    echo "[2/7] Устанавливаем Miniforge..."
    wget -q https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh \
        -O /tmp/miniforge.sh
    bash /tmp/miniforge.sh -b -p /root/miniforge3
    rm /tmp/miniforge.sh
    eval "$(/root/miniforge3/bin/conda shell.bash hook)"
    conda init bash
else
    echo "[2/7] conda уже установлен: $(conda --version)"
    eval "$(conda shell.bash hook)"
fi

source /root/.bashrc 2>/dev/null || true
export PATH="/root/miniforge3/bin:$PATH"

# ── 3. Conda окружение ─────────────────────────────────────────────────────
echo "[3/7] Conda окружение cosyvoice..."
conda create -n cosyvoice python=3.10 -y 2>/dev/null || true
eval "$(conda shell.bash hook)"
conda activate cosyvoice

# ── 4. Клонирование CosyVoice ──────────────────────────────────────────────
COSYVOICE_DIR=/root/CosyVoice
if [ ! -d "$COSYVOICE_DIR" ]; then
    echo "[4/7] Клонируем CosyVoice..."
    git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git "$COSYVOICE_DIR"
else
    echo "[4/7] CosyVoice уже склонирован, обновляем субмодули..."
    cd "$COSYVOICE_DIR" && git submodule update --init --recursive
fi

# ── 5. Python зависимости CosyVoice ───────────────────────────────────────
echo "[5/7] Python зависимости CosyVoice..."
cd "$COSYVOICE_DIR"
pip install --upgrade pip -q
pip install -r requirements.txt -q
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121 -q

# FastAPI для сервера
pip install fastapi uvicorn[standard] pydantic huggingface_hub -q

# ── 6. Загрузка модели ────────────────────────────────────────────────────
MODEL_DIR="$COSYVOICE_DIR/pretrained_models/Fun-CosyVoice3-0.5B"
if [ ! -d "$MODEL_DIR" ]; then
    echo "[6/7] Скачиваем модель Fun-CosyVoice3-0.5B (~2GB)..."
    python3 -c "
from huggingface_hub import snapshot_download
snapshot_download(
    'FunAudioLLM/Fun-CosyVoice3-0.5B-2512',
    local_dir='$MODEL_DIR',
    ignore_patterns=['*.msgpack','*.h5','flax_model*','tf_model*']
)
print('Модель скачана.')
"
    # Скачиваем ttsfrd (нормализатор текста)
    python3 -c "
from huggingface_hub import snapshot_download
snapshot_download(
    'FunAudioLLM/CosyVoice-ttsfrd',
    local_dir='$COSYVOICE_DIR/pretrained_models/CosyVoice-ttsfrd'
)
print('ttsfrd скачан.')
"
else
    echo "[6/7] Модель уже скачана: $MODEL_DIR"
fi

# ── 7. Сервер как systemd-сервис ──────────────────────────────────────────
echo "[7/7] Настраиваем автозапуск сервера..."

# Копируем серверный файл из Windows-проекта
WIN_SERVER="/mnt/d/MyProjects/youtube-translator/cosyvoice_server/server.py"
WIN_ENV="/mnt/d/MyProjects/youtube-translator/cosyvoice_server/.env"
SERVER_DIR=/root/cosyvoice_server
mkdir -p "$SERVER_DIR"

if [ -f "$WIN_SERVER" ]; then
    cp "$WIN_SERVER" "$SERVER_DIR/server.py"
    echo "Скопирован server.py"
fi

# Загружаем .env
if [ -f "$WIN_ENV" ]; then
    cp "$WIN_ENV" "$SERVER_DIR/.env"
    echo "Скопирован .env"
fi

# Создаём скрипт запуска
cat > /root/start_cosyvoice.sh << 'RUNEOF'
#!/usr/bin/env bash
export PATH="/root/miniforge3/bin:$PATH"
eval "$(conda shell.bash hook)"
conda activate cosyvoice

# Загружаем переменные окружения
set -a
source /root/cosyvoice_server/.env
set +a

export COSYVOICE_DIR=/root/CosyVoice
export COSYVOICE_MODEL_DIR=/root/CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B

echo "Запуск CosyVoice сервера на порту ${PORT:-8020}..."
python3 /root/cosyvoice_server/server.py >> /tmp/cosyvoice_server.log 2>&1
RUNEOF
chmod +x /root/start_cosyvoice.sh

echo ""
echo "======================================"
echo " Установка завершена!"
echo ""
echo " Запуск сервера:"
echo "   wsl -d Ubuntu-22.04 -- bash /root/start_cosyvoice.sh"
echo ""
echo " Логи сервера: /tmp/cosyvoice_server.log"
echo " Лог установки: /tmp/cosyvoice_install.log"
echo "======================================"
