# CLAUDE.md — Инструкции для агента-исполнителя

## Технический стек
- **Язык**: TypeScript (strict mode)
- **Frontend**: React Native (Expo Router), Zustand, expo-av, YouTube IFrame API
- **Backend**: Node.js, Fastify, Socket.IO, tsx (dev runner)
- **Инструменты**: yt-dlp, ffmpeg, Python 3 (edge_tts)
- **API**: DeepGram (STT Streaming WebSocket, TTS Aura-2), OpenAI (GPT-4o-mini, TTS)

## Команды запуска
```bash
# Backend
cd apps/backend && npx tsx src/index.ts

# Frontend (web)
cd apps/mobile && npx expo start --web --port 8085
```

## КРИТИЧЕСКИЕ ПРАВИЛА

1. **Всегда читай planning.md и PRD.md перед началом работы.**
2. **Отмечай выполненные задачи в tasks.md крестиком [x].**
3. **ПРАВИЛО ПЕРЕКЛЮЧЕНИЯ РОЛЕЙ (DYNAMIC PERSONA):** В tasks.md перед каждой задачей или спринтом указан тег [Role: Название Роли]. Перед выполнением задачи ОБЯЗАН переключить свой контекст и образ мышления на эту роль.
4. **НЕ меняй интерфейс TranslationSettings** без обновления ВСЕХ мест, где он используется (orchestrator.ts, streaming-orchestrator.ts, useSocket.ts, socket.service.ts, handlers.ts).
5. **НЕ используй @deepgram/sdk** — SDK v3.13.0 ломает WebSocket. Используй raw `ws` WebSocket.
6. **НЕ используй ffmpeg -re** — он форсирует 1x скорость вывода, но синхронизация идёт через таймштампы.
7. **DeepGram Aura-2 не поддерживает русский** — для ru/zh/ko используется fallback на Edge TTS или OpenAI TTS.
8. **Весь UI на русском языке.** Комментарии в коде на русском.
9. **Socket.IO события**: segment, status, pause_video, resume_video, provider_info, error, seek, playback_time.
10. **YouTube IFrame API** используется вместо прямых URL (CORS).

## Структура проекта
```
apps/
├── backend/          # Node.js + Socket.IO сервер
│   ├── src/
│   │   ├── index.ts
│   │   ├── config.ts
│   │   ├── core/     # Оркестраторы и YouTube стример
│   │   ├── providers/ # STT, Translation, TTS провайдеры
│   │   ├── socket/    # WebSocket обработчики
│   │   └── utils/     # Gender detector, subtitles
│   └── .env
├── mobile/           # React Native (Expo)
│   ├── app/          # Screens (expo-router)
│   ├── components/   # UI компоненты
│   ├── hooks/        # useSocket, useAudioSync
│   ├── services/     # socket.service, audio-queue.service
│   ├── store/        # Zustand stores
│   └── constants/    # theme, languages
```

## Используй навыки
- **systematic-debugging** при любых багах
- **test-driven-development** при создании новых провайдеров
- **verification-before-completion** перед пометкой задачи как выполненной
