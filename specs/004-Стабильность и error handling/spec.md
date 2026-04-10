# Sprint 4 : Стабильность и error handling

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

- [x] {{TASK:4.1}} Добавить graceful degradation при падении провайдеров
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/backend/src/core/streaming-orchestrator.ts`, метод `processSegment()`, добавить retry и fallback.
  - **Как сделать:**
    1. Обернуть `this.translationProvider.translate(text)` в try-catch с 1 retry (задержка 500мс)
    2. Если перевод fail'ит 2 раза — пропустить сегмент, залогировать, продолжить
    3. Обернуть `this.ttsProvider.synthesize()` в try-catch с 1 retry
    4. Если TTS fail'ит — отправить сегмент без audio (`audioBase64: ''`), клиент покажет субтитр
    5. Добавить счётчик ошибок `this.errorCount`. При > 5 подряд — emit error и stop
  - **Ограничения:** Не retry'ить бесконечно. Max 1 retry на операцию.
  - **Критерии приемки:** При временной ошибке OpenAI (429) сегмент повторяется 1 раз и проходит. При перманентной ошибке — пропускается, следующие продолжают обрабатываться. При 5+ ошибках подряд — трансляция останавливается с сообщением пользователю.
- [x] {{TASK:4.2}} Исправить zombie ffmpeg процессы при быстрых seek'ах
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/backend/src/core/youtube-streamer.ts`, метод `stopStream()`, добавить принудительное убийство процесса и ожидание exit.
  - **Как сделать:**
    1. В `stopStream()`: если `this.process`, сначала `SIGTERM`, затем через 2с `SIGKILL` если не завершился
    2. Добавить `await` на завершение процесса: `await new Promise(resolve => this.process.on('close', resolve))`
    3. Очистить listeners ПЕРЕД kill чтобы не получать stale data events
    4. В `startAudioStream()`: проверить что предыдущий процесс точно мёртв перед запуском нового
  - **Ограничения:** Таймаут SIGKILL — 2 секунды. Не блокировать event loop.
  - **Критерии приемки:** При 5 быстрых seek'ах подряд — в `tasklist` только 1 процесс ffmpeg. Лог: `[YouTubeStreamer] ffmpeg killed (PID: X)`.
- [x] {{TASK:4.3}} Добавить reconnect логику для Socket.IO на клиенте
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/mobile/hooks/useSocket.ts`, обработать reconnect: при восстановлении соединения, если перевод был активен — показать уведомление.
  - **Как сделать:**
    1. В socket.on('reconnect'): проверить `usePlayerStore.getState().status`. Если был `translating` или `recognizing` → `setStatus('idle')`, показать `setErrorMessage('Соединение восстановлено. Включите перевод заново.')`
    2. В socket.on('disconnect'): если `status !== 'idle'` → `setStatus('idle')`, очистить audio queue
    3. Не пытаться автоматически перезапустить перевод — пусть пользователь решает
  - **Ограничения:** Не добавлять auto-restart перевода. Только информирование пользователя.
  - **Критерии приемки:** При перезапуске сервера — на клиенте status сбрасывается в idle, очередь очищается, пользователь видит сообщение.

## Completion

- [ ] All 3 tasks completed

**Output:** `<promise>DONE</promise>`