# Архитектура: YouTube Translator

## Стек технологий
- **Frontend**: React Native (Expo Router), Zustand, expo-av, YouTube IFrame API
- **Backend**: Node.js, TypeScript, tsx, Fastify, Socket.IO
- **Инструменты**: yt-dlp, ffmpeg, Python 3 (edge_tts)
- **API**: DeepGram (STT + TTS), OpenAI (перевод)

## Архитектура потока данных

```
┌─────────────────────────────────────────────────────────────────┐
│                        BACKEND (Node.js)                        │
│                                                                 │
│  YouTube URL                                                    │
│      │                                                          │
│      ├── yt-dlp --write-auto-sub ──→ SubtitleFetcher            │
│      │       (json3 субтитры)          │                        │
│      │                                 ▼                        │
│      │                     ┌──────────────────────┐             │
│      ├── yt-dlp -g ──→ ffmpeg ──→ │ DeepGram STT (WS) │ ← fallback│
│      │   (audio URL)   (mp3 chunks) └──────────────────────┘    │
│      │                                 │                        │
│      │                                 ▼                        │
│      │                     ┌──────────────────────┐             │
│      │                     │  OpenAI GPT-4o-mini  │             │
│      │                     │  (перевод текста)     │             │
│      │                     └──────────────────────┘             │
│      │                                 │                        │
│      │                                 ▼                        │
│      │                     ┌──────────────────────┐             │
│      │                     │ DeepGram TTS / Edge  │             │
│      │                     │ (озвучка перевода)    │             │
│      │                     └──────────────────────┘             │
│      │                                 │                        │
│      │                    Socket.IO    │                        │
│      │              ┌─────────────────┐│                        │
│      │              │  segment        ││                        │
│      │              │  pause_video    ││                        │
│      │              │  resume_video   ││                        │
│      │              │  status         ││                        │
│      │              │  provider_info  ││                        │
│      │              └─────────────────┘│                        │
└──────┼──────────────────────┼──────────┼────────────────────────┘
       │                      │          │
       ▼                      ▼          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     FRONTEND (React Native)                      │
│                                                                 │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ YouTube IFrame  │  │  AudioQueue     │  │  PlayerStore     │ │
│  │ (видео, seek)   │  │  (time-synced)  │  │  (Zustand)       │ │
│  │                 │  │                 │  │                  │ │
│  │ currentTime ───────→ scheduler ←──────── segments[]       │ │
│  │ playbackRate ──────→ rate matching   │  │ currentTime      │ │
│  │ onSeek ────────────→ pipeline restart│  │ isPlaying        │ │
│  └────────────────┘  └─────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Критические компоненты и их проблемы

### 1. AudioQueueService (клиент)
**Текущая проблема**: Polling каждые 200мс проверяет currentTime. Между проверками сегменты пропускаются.
**Целевое решение**: Event-driven — подписка на изменение currentTime через Zustand subscribe.

### 2. StreamingOrchestrator (сервер)
**Текущая проблема**: Субтитры обрабатываются последовательно (await в цикле). Edge TTS добавляет 1-2с на сегмент.
**Целевое решение**: Параллельная обработка batch'ами по 3-5 сегментов.

### 3. Edge TTS Provider (сервер)
**Текущая проблема**: Python subprocess на каждый вызов = 500мс+ overhead.
**Целевое решение**: OpenAI TTS API как альтернатива (один HTTP запрос, без subprocess).

### 4. YouTube Subtitles Parser (сервер)
**Текущая проблема**: Merging считает duration через gaps между сегментами.
**Целевое решение**: Duration = сумма duration'ов отдельных сегментов, не span.

### 5. ShadowPlayer (клиент)
**Текущая проблема**: Seek детектируется polling'ом каждые 500мс, мелкие seek'и (< 3с) пропускаются.
**Целевое решение**: Снизить порог детекции seek до 1.5с, уменьшить интервал до 250мс.

## Структура директорий (текущая + новые файлы)
```
apps/
├── backend/src/
│   ├── core/
│   │   ├── orchestrator.ts
│   │   ├── streaming-orchestrator.ts      ← основной (fix sync)
│   │   └── youtube-streamer.ts
│   ├── providers/
│   │   ├── stt/deepgram.provider.ts
│   │   ├── translation/openai.provider.ts
│   │   └── tts/
│   │       ├── deepgram-tts.provider.ts
│   │       ├── edge-tts.provider.ts
│   │       └── openai-tts.provider.ts     ← NEW (замена Edge)
│   └── utils/
│       ├── gender-detector.ts
│       └── youtube-subtitles.ts           ← fix duration
├── mobile/
│   ├── services/
│   │   └── audio-queue.service.ts         ← fix event-driven
│   ├── components/
│   │   └── ShadowPlayer.tsx               ← fix seek detection
│   └── hooks/
│       └── useAudioSync.ts
```
