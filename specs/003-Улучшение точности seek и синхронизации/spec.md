# Sprint 3 : Улучшение точности seek и синхронизации

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

## Completion

- [ ] All 2 tasks completed

**Output:** `<promise>DONE</promise>`