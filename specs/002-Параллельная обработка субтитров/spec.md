# Sprint 2 : Параллельная обработка субтитров

## Context

Read planning.md and CLAUDE.md before starting.

### Links

- [Planning](../planning.md)
- [Guidelines](../CLAUDE.md)
- [PRD](../PRD.md)

## ⚡ Архитектурные правила и Тестирование (ОБЯЗАТЕЛЬНО)
* **UI и Рендеринг:** ВСЕ визуальные изменения должны проверяться через E2E-тесты (Playwright) или Agent-Browser. Юнит-тестов логики недостаточно.
* **Темы оформления:** ЗАПРЕЩАЕТСЯ хардкодить цвета (например, bg-gray-950), используйте адаптивные классы (dark:...) или CSS-переменные.
* **Zustand/Redux:** ЗАПРЕЩАЕТСЯ использовать геттеры внутри стора для производных данных. Используйте useMemo в хуках.

## Tasks

- [x] {{TASK:2.1}} Реализовать batch-обработку субтитров вместо sequential
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/backend/src/core/streaming-orchestrator.ts`, метод `startSubtitlePipeline()`, заменить последовательную обработку на параллельную batch'ами.
  - **Как сделать:**
    1. Разбить `relevantSegments` на batch'ы по 3 сегмента: `const batches = chunkArray(relevantSegments, 3)`
    2. Для каждого batch'а: `await Promise.all(batch.map(sub => this.processSegment(...)))`
    3. Между batch'ами — ждём текущий, запускаем следующий
    4. Первый batch (3 сегмента) — приоритетный: после его завершения гарантированно будет resume_video
    5. Добавить вспомогательную функцию `chunkArray<T>(arr: T[], size: number): T[][]`
  - **Ограничения:** Не более 3 параллельных запросов к OpenAI и TTS одновременно (rate limit). Порядок emit'а сегментов должен быть по startTime (клиент сортирует, но лучше отправлять в порядке).
  - **Критерии приемки:** Для видео с 60 субтитрами время обработки уменьшается с ~90с до ~30с (3x ускорение). Первый сегмент приходит через 2-3с вместо 2-3с (без изменений для первого), но последующие приходят быстрее.
- [x] {{TASK:2.2}} Добавить OpenAI TTS как альтернативу Edge TTS для русского
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Создать `apps/backend/src/providers/tts/openai-tts.provider.ts`. Это HTTP-based TTS без Python subprocess — один HTTP запрос к `https://api.openai.com/v1/audio/speech`.
  - **Как сделать:**
    1. Реализовать интерфейс `TTSProvider` из `tts.interface.ts`
    2. Метод `initialize(options)`: сохранить apiKey, language; выбрать voice: `alloy` (male), `nova` (female) для ru; `echo` (male), `shimmer` (female) для остальных
    3. Метод `synthesize(text, gender)`: POST к `https://api.openai.com/v1/audio/speech` с body `{ model: 'tts-1', voice: selectedVoice, input: text, response_format: 'mp3', speed: 1.0 }`, header `Authorization: Bearer ${apiKey}`
    4. Возвращать Buffer из response.arrayBuffer()
    5. Обработка ошибок: логировать и возвращать Buffer.alloc(0)
  - **Ограничения:** Не удалять Edge TTS — оставить как fallback. Не менять интерфейс TTSProvider.
  - **Критерии приемки:** `synthesize('Привет мир', 'male')` возвращает MP3 buffer > 1000 байт за < 1с. Лог: `[OpenAITTS] Синтезировано X байт (voice): "text..."`.
- [x] {{TASK:2.3}} Интегрировать OpenAI TTS в StreamingOrchestrator как основной для русского
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/backend/src/core/streaming-orchestrator.ts`, метод `initProviders()`, заменить DeepgramTTSProvider (который fallback'ит на Edge TTS для ru) на OpenAI TTS когда язык — русский И openai ключ доступен.
  - **Как сделать:**
    1. Импортировать `OpenAITTSProvider` из `../providers/tts/openai-tts.provider`
    2. В `initProviders()` после создания translation provider:
       ```
       if (targetLanguage === 'ru' && openaiKey) {
         this.ttsProvider = new OpenAITTSProvider();
         await this.ttsProvider.initialize({ apiKey: openaiKey, language: targetLanguage });
       } else {
         this.ttsProvider = new DeepgramTTSProvider();
         await this.ttsProvider.initialize({ apiKey: deepgramKey, language: targetLanguage });
       }
       ```
    3. Обновить `emitProviderInfo()`: определять имя TTS по `this.ttsProvider.name`
  - **Ограничения:** Не менять API Edge TTS и DeepGram TTS провайдеров. Fallback: DeepGram → Edge остаётся для не-ru языков.
  - **Критерии приемки:** При targetLanguage='ru' provider_info показывает `tts: 'OpenAI TTS'`. Латентность TTS для русского < 1с (вместо 1-2с с Edge TTS).

## Completion

- [ ] All 3 tasks completed

**Output:** `<promise>DONE</promise>`