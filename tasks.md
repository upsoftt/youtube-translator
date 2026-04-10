# Tasks: YouTube Translator — Исправление синхронизации и стабильности

## Спринт 1: Критические исправления синхронизации аудио
**[Role: Backend Architect + Frontend Engineer]**

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

## Спринт 2: Параллельная обработка субтитров
**[Role: Backend Architect]**

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

## Спринт 3: Улучшение точности seek и синхронизации
**[Role: Frontend Engineer]**

- [x] {{TASK:3.1}} Улучшить детекцию seek в ShadowPlayer
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/mobile/components/ShadowPlayer.tsx` уменьшить порог seek и интервал polling.
  - **Как сделать:**
    1. Изменить интервал polling с 500мс на 250мс (строка setInterval)
    2. Изменить порог seek с `delta > 3` на `delta > 1.5` секунды
    3. Добавить проверку: seek не детектируется когда видео на паузе (`playing === false`)
    4. Добавить защиту от двойного seek: `seekCooldownRef` — после детекции seek, игнорировать следующие 1 секунду
  - **Ограничения:** Не менять YouTube IFrame API инициализацию. Не добавлять YouTube API events для seek (их нет в API).
  - **Критерии приемки:** Seek на 2 секунды вперёд детектируется и вызывает `onSeek`. Лог: `[ShadowPlayer] Seek detected: X.Xs → Y.Ys`. Нет false positives при обычном воспроизведении (delta ~0.25с каждые 250мс).

- [x] {{TASK:3.2}} Добавить адаптивную коррекцию скорости аудио
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `apps/mobile/services/audio-queue.service.ts` добавить логику: если перевод отстаёт от видео на > 2с, ускорить playback до 1.15x; если догнал — вернуть на 1.0x (или на скорость видео).
  - **Как сделать:**
    1. В `checkQueue()` (или в scheduler), после выбора сегмента для воспроизведения:
    2. Вычислить `drift = videoTime - segment.startTime`
    3. Если `drift > 2` → `catchUpRate = Math.min(1.3, baseRate * 1.15)` (ускоряем на 15% от текущей скорости видео)
    4. Если `drift < 0.5` → `catchUpRate = baseRate` (вернуть нормальную скорость)
    5. Применить `rate` при создании Audio.Sound
    6. Логировать: `[AudioQueue] Drift: ${drift.toFixed(1)}s, rate: ${catchUpRate}x`
  - **Ограничения:** Не ускорять больше 1.3x (искажение голоса). Использовать `shouldCorrectPitch: true`.
  - **Критерии приемки:** При drift 3с аудио догоняет видео за ~20 секунд (3с / 0.15 * 1с ≈ 20 итераций). Лог показывает постепенное уменьшение drift.

## Спринт 4: Стабильность и error handling
**[Role: Backend Architect + Frontend Engineer]**

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
