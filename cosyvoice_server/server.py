#!/usr/bin/env python3
"""
CosyVoice3 TTS сервер для YouTube Translator.

Запуск в WSL2:
  conda activate cosyvoice
  python cosyvoice_server/server.py

Эндпоинты:
  GET  /health              — проверка доступности
  POST /v1/audio/speech     — синтез речи (OpenAI-совместимый)

Авторизация: Bearer <COSYVOICE_API_KEY>
"""

import os
import sys
import io
import base64
import secrets
import tempfile
import logging
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import Response
import uvicorn
from pydantic import BaseModel

# Путь к CosyVoice (клонируйте рядом или задайте переменную окружения)
COSYVOICE_DIR = os.environ.get(
    'COSYVOICE_DIR',
    os.path.expanduser('~/CosyVoice')
)

# Дефолтный референсный WAV для inference_cross_lingual (без клонирования)
DEFAULT_REF_WAV = os.path.join(COSYVOICE_DIR, 'asset', 'cross_lingual_prompt.wav')
sys.path.insert(0, COSYVOICE_DIR)
sys.path.insert(0, os.path.join(COSYVOICE_DIR, 'third_party', 'Matcha-TTS'))

# Порт и секретный ключ из переменных окружения
PORT       = int(os.environ.get('PORT', 8020))
API_KEY    = os.environ.get('COSYVOICE_API_KEY', '')
MODEL_DIR  = os.environ.get(
    'COSYVOICE_MODEL_DIR',
    os.path.join(COSYVOICE_DIR, 'pretrained_models', 'Fun-CosyVoice3-0.5B')
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('cosyvoice_server')

app = FastAPI(title='CosyVoice TTS Server', version='1.0.0')

# Глобальная модель — загружается один раз при старте
_model = None

def get_model():
    global _model
    if _model is None:
        log.info(f'Загружаем модель из {MODEL_DIR}...')
        from cosyvoice.cli.cosyvoice import AutoModel
        _model = AutoModel(model_dir=MODEL_DIR)
        log.info('Модель загружена.')
    return _model


def check_auth(authorization: Optional[str]) -> None:
    """Проверяет Bearer-токен. Если API_KEY не задан — авторизация отключена."""
    if not API_KEY:
        return  # ключ не настроен — пропускаем
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail='Требуется авторизация')
    token = authorization[len('Bearer '):]
    if not secrets.compare_digest(token, API_KEY):
        raise HTTPException(status_code=403, detail='Неверный API ключ')


class SpeechRequest(BaseModel):
    model: str = 'cosyvoice3'
    input: str                              # Текст для синтеза
    language: str = 'ru'
    response_format: str = 'mp3'
    voice_clone: bool = False               # Клонировать голос из reference_audio
    reference_audio: Optional[str] = None  # Base64-encoded WAV


@app.get('/health')
def health(authorization: Optional[str] = Header(default=None)):
    check_auth(authorization)
    return {
        'ok': True,
        'model': 'Fun-CosyVoice3-0.5B',
        'model_dir': MODEL_DIR,
        'model_loaded': _model is not None,
    }


@app.post('/v1/audio/speech')
async def speech(req: SpeechRequest, authorization: Optional[str] = Header(default=None)):
    check_auth(authorization)

    text = req.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail='Текст не может быть пустым')

    try:
        model = get_model()
        import torchaudio

        audio_chunks = []

        # CosyVoice3 (Fun-CosyVoice3-0.5B) требует токен <|endofprompt|> в тексте.
        # Передаём text_frontend=False чтобы нормализатор не удалил спецтокен.
        marked_text = f'<|endofprompt|>{text}'

        if req.voice_clone and req.reference_audio:
            # Cross-lingual клонирование: синтез голосом референсного спикера
            ref_wav_bytes = base64.b64decode(req.reference_audio)

            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                f.write(ref_wav_bytes)
                ref_path = f.name

            try:
                for result in model.inference_cross_lingual(
                    marked_text,
                    ref_path,
                    stream=False,
                    text_frontend=False,
                ):
                    audio_chunks.append(result['tts_speech'])
            finally:
                os.unlink(ref_path)

            log.info(f'[voice-clone] Синтез: "{text[:60]}"')

        else:
            # Обычный синтез без клонирования — используем дефолтный референс
            ref_wav = DEFAULT_REF_WAV
            if not os.path.exists(ref_wav):
                raise RuntimeError(f'Дефолтный референсный WAV не найден: {ref_wav}')

            for result in model.inference_cross_lingual(
                marked_text,
                ref_wav,
                stream=False,
                text_frontend=False,
            ):
                audio_chunks.append(result['tts_speech'])

            log.info(f'[cross-lingual] Синтез: "{text[:60]}"')

        if not audio_chunks:
            raise RuntimeError('Модель вернула пустой результат')

        import torch
        audio_tensor = torch.cat(audio_chunks, dim=1)
        sample_rate  = model.sample_rate

        # Кодируем в MP3 через ffmpeg (pipe)
        import subprocess, shutil
        if shutil.which('ffmpeg'):
            # WAV → MP3 через ffmpeg pipe
            wav_buf = io.BytesIO()
            torchaudio.save(wav_buf, audio_tensor, sample_rate, format='wav')
            wav_buf.seek(0)

            proc = subprocess.run(
                ['ffmpeg', '-f', 'wav', '-i', 'pipe:0',
                 '-ar', '24000', '-ab', '128k', '-f', 'mp3', 'pipe:1'],
                input=wav_buf.read(),
                capture_output=True,
                timeout=30,
            )
            mp3_bytes = proc.stdout
        else:
            # ffmpeg не найден — отдаём WAV
            wav_buf = io.BytesIO()
            torchaudio.save(wav_buf, audio_tensor, sample_rate, format='wav')
            mp3_bytes = wav_buf.getvalue()

        return Response(
            content=mp3_bytes,
            media_type='audio/mpeg' if shutil.which('ffmpeg') else 'audio/wav',
        )

    except Exception as e:
        log.error(f'Ошибка синтеза: {e}', exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == '__main__':
    if not API_KEY:
        # Генерируем ключ при первом запуске если не задан
        generated = secrets.token_urlsafe(32)
        log.warning('=' * 60)
        log.warning('COSYVOICE_API_KEY не задан в переменных окружения!')
        log.warning(f'Сгенерирован временный ключ: {generated}')
        log.warning('Добавьте в .env: COSYVOICE_API_KEY=' + generated)
        log.warning('=' * 60)
        API_KEY = generated  # type: ignore[assignment]

    log.info(f'Запуск CosyVoice сервера на порту {PORT}...')
    log.info(f'Модель: {MODEL_DIR}')

    # Прогреваем модель заранее
    get_model()

    uvicorn.run(app, host='0.0.0.0', port=PORT, log_level='info')
