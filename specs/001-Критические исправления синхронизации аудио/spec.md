# Sprint 1 : Критические исправления синхронизации аудио

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

- [x] {{TASK:1.1}} Заменить polling на event-driven sync в AudioQueueService
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Переписать `apps/mobile/services/audio-queue.service.ts`. Убрать `setInterval(200)` scheduler. Вместо этого использовать `usePlayerStore.subscribe()` для подписки на изменения `currentTime`. При каждом обновлении `currentTime` проверять очередь сегментов.
  - **Как сделать:**
    1. В методе `startScheduler()` заменить `setInterval` на `usePlayerStore.subscribe((state) => state.currentTime, (currentTime) => this.checkQueue(currentTime))`
    2. Вынести логику проверки очереди в отдельный метод `checkQueue(videoTime: number)`
    3. Добавить debounce 50мс чтобы не дёргать очередь на каждый мс (zustand subscribe срабатывает при каждом setState)
    4. Оставить fallback `setInterval(1000)` на случай если subscribe не срабатывает (видео на паузе)
  - **Ограничения:** Не менять интерфейс `enqueue()`, `clear()`, `pause()`, `resume()`. Не менять формат сегментов.
  - **Критерии приемки:** При воспроизведении видео аудио-сегмент начинает играть в пределах 100мс от его `startTime` (вместо текущих 200-700мс). Проверить в console.log: `[AudioQueue] Playing segment at videoTime=X.Xs, startTime=X.Xs, delta=X.Xms`.
- [x] {{TASK:1.2}} Добавить timeout на resume_video в StreamingOrchestrator
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/backend/src/core/streaming-orchestrator.ts` добавить таймаут 15 секунд после `emit('pause_video')`. Если за 15с `firstSegmentSent` не стал `true` — принудительно отправить `resume_video` и залогировать предупреждение.
  - **Как сделать:**
    1. В методе `start()`, после `this.emit('pause_video')`, запустить `this.resumeTimeout = setTimeout(() => { ... }, 15000)`
    2. Внутри таймаута: `if (!this.firstSegmentSent) { this.firstSegmentSent = true; this.emit('resume_video'); this.emit('status', 'Перевод активен'); console.warn('[StreamingOrch] TIMEOUT: resume_video forced after 15s'); }`
    3. В `processSegment` при установке `firstSegmentSent = true` — очистить таймаут: `clearTimeout(this.resumeTimeout)`
    4. В `stop()` — очистить таймаут
    5. Добавить поле `private resumeTimeout: ReturnType<typeof setTimeout> | null = null`
  - **Ограничения:** Не менять логику processSegment. Таймаут должен быть configurable (15с по умолчанию).
  - **Критерии приемки:** При ошибке провайдера (OpenAI/DeepGram) видео возобновляется через 15с, а не зависает навечно. В логах: `[StreamingOrch] TIMEOUT: resume_video forced after 15s`.
- [x] {{TASK:1.3}} Исправить расчёт duration в youtube-subtitles.ts
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/backend/src/utils/youtube-subtitles.ts`, функция `parseJson3Subtitles`, исправить логику мерджа коротких сегментов.
  - **Как сделать:**
    1. Текущая ошибка: `bufferDuration = (seg.startTime + seg.duration) - bufferStart` — включает gaps между сегментами.
    2. Исправить на: отслеживать `bufferContentDuration` как сумму `seg.duration` отдельных сегментов в буфере.
    3. При flush: `merged.push({ text: buffer.trim(), startTime: bufferStart, duration: bufferContentDuration })`
    4. При добавлении в буфер: `bufferContentDuration += seg.duration`
    5. При reset: `bufferContentDuration = 0`
  - **Ограничения:** Не менять интерфейс `SubtitleSegment`. Не менять логику flush (8 слов, пунктуация, 5с).
  - **Критерии приемки:** Merged сегмент из двух фраз (0-1с + 5-6с) должен иметь `duration: 2`, а не `duration: 6`. Лог: `[Subtitles] Получено X сегментов → объединено в Y` с корректными duration.

## Completion

- [ ] All 3 tasks completed

**Output:** `<promise>DONE</promise>`