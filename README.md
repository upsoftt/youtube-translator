# YouTube Translator

Кроссплатформенное мобильное приложение для синхронного перевода YouTube-видео в реальном времени.

## Архитектура

- **Монорепозиторий** с npm workspaces
- **Frontend**: React Native (Expo Router) — `apps/mobile/`
- **Backend**: Node.js (Fastify + TypeScript) — `apps/backend/`

## Требования

- Node.js >= 18
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (установлен и доступен в PATH)
- [ffmpeg](https://ffmpeg.org/) (для обработки аудио)
- Python 3 + [whisper](https://github.com/openai/whisper) (опционально, для бесплатного STT)

## Быстрый старт

### 1. Установка зависимостей

```bash
cd youtube-translator
npm install --workspaces
```

### 2. Настройка бэкенда

```bash
cd apps/backend
cp .env.example .env
# Отредактируйте .env при необходимости
```

### 3. Запуск бэкенда

```bash
npm run dev --workspace=apps/backend
```

Сервер запустится на `http://localhost:3000`

### 4. Запуск мобильного приложения

```bash
npm run start --workspace=apps/mobile
```

Откроется Expo Dev Server. Используйте Expo Go для подключения.

## Провайдеры

### STT (Распознавание речи)
| Провайдер | Стоимость | Требования |
|-----------|-----------|------------|
| Whisper | Бесплатно | Python + whisper CLI |
| DeepGram | Платный | API ключ |

### Перевод
| Провайдер | Стоимость | Требования |
|-----------|-----------|------------|
| LibreTranslate | Бесплатно | Интернет |
| OpenAI GPT-4o-mini | Платный | API ключ |

### TTS (Озвучивание)
| Провайдер | Стоимость | Требования |
|-----------|-----------|------------|
| Edge TTS | Бесплатно | npx edge-tts |
| DeepGram Aura | Платный | API ключ |

## Структура проекта

```
youtube-translator/
├── package.json                    # Корневой workspace
├── README.md
├── apps/
│   ├── mobile/                     # React Native (Expo)
│   │   ├── app/
│   │   │   ├── _layout.tsx         # Root Layout (Stack, тёмная тема)
│   │   │   ├── index.tsx           # Главный экран (ввод URL)
│   │   │   ├── player/[id].tsx     # Экран плеера
│   │   │   └── settings.tsx        # Настройки
│   │   ├── components/
│   │   │   ├── ShadowPlayer.tsx    # Видео-плеер
│   │   │   ├── ControlBar.tsx      # Панель управления
│   │   │   ├── ProviderSelector.tsx# Выбор провайдера
│   │   │   ├── StatusBar.tsx       # Индикатор статуса
│   │   │   └── SubtitleOverlay.tsx # Субтитры
│   │   ├── hooks/
│   │   │   ├── useSocket.ts        # WebSocket хук
│   │   │   └── useAudioSync.ts     # Синхронизация аудио
│   │   ├── services/
│   │   │   ├── socket.service.ts   # Socket.IO клиент
│   │   │   └── audio-queue.service.ts # Очередь аудио
│   │   ├── store/
│   │   │   ├── settings.store.ts   # Стор настроек (Zustand)
│   │   │   └── player.store.ts     # Стор плеера (Zustand)
│   │   ├── constants/
│   │   │   ├── theme.ts            # Цвета и стили
│   │   │   └── languages.ts        # Языки и провайдеры
│   │   └── package.json
│   │
│   └── backend/                    # Node.js (Fastify)
│       ├── src/
│       │   ├── index.ts            # Точка входа сервера
│       │   ├── config.ts           # Конфигурация
│       │   ├── core/
│       │   │   ├── youtube-streamer.ts   # yt-dlp стриминг
│       │   │   └── orchestrator.ts       # Конвейер обработки
│       │   ├── providers/
│       │   │   ├── stt/
│       │   │   │   ├── stt.interface.ts
│       │   │   │   ├── whisper.provider.ts
│       │   │   │   └── deepgram.provider.ts
│       │   │   ├── translation/
│       │   │   │   ├── translation.interface.ts
│       │   │   │   ├── libre.provider.ts
│       │   │   │   └── openai.provider.ts
│       │   │   └── tts/
│       │   │       ├── tts.interface.ts
│       │   │       ├── edge-tts.provider.ts
│       │   │       └── deepgram-tts.provider.ts
│       │   └── socket/
│       │       └── handlers.ts     # WebSocket обработчики
│       ├── .env.example
│       └── package.json
```

## WebSocket протокол

### Клиент → Сервер:
```json
{
  "type": "start",
  "videoUrl": "https://youtube.com/watch?v=...",
  "settings": {
    "targetLanguage": "ru",
    "sttProvider": "whisper",
    "translationProvider": "libre",
    "ttsProvider": "edge-tts",
    "apiKeys": {}
  }
}
```

### Сервер → Клиент:
```json
{ "type": "segment", "id": "uuid", "text": "Перевод", "startTime": 5.2, "audioBase64": "..." }
{ "type": "status", "message": "Перевод активен" }
{ "type": "video_url", "url": "https://direct-video-url..." }
{ "type": "error", "message": "Описание ошибки" }
```

## Дизайн

- Тёмная тема (фон #0A0A0A, карточки #1A1A1A, акцент #FF4444)
- Минималистичный современный интерфейс
- Все тексты UI на русском языке

## Лицензия

MIT
