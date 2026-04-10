# Стриминговый режим синхронного перевода — План реализации

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать premium-режим перевода с минимальной задержкой, где видео автоматически ставится на паузу при старте, а воспроизведение начинается синхронно с первым переведённым сегментом.

**Architecture:** Новый `StreamingOrchestrator` работает параллельно с существующим `Orchestrator`. При старте сервер отправляет клиенту команду `pause_video`, запускает DeepGram STT (streaming WebSocket) → OpenAI GPT-4o-mini → DeepGram TTS. Когда первый сегмент готов — отправляет `resume_video` и клиент начинает воспроизведение. Временные метки сегментов берутся из DeepGram STT (`start` + `duration`), обеспечивая точную синхронизацию.

**Tech Stack:** DeepGram SDK (@deepgram/sdk), OpenAI SDK (openai), Socket.IO, expo-av, Zustand

---

## Файловая структура

### Новые файлы
- `apps/backend/src/core/streaming-orchestrator.ts` — Стриминговый оркестратор (DeepGram STT → OpenAI → DeepGram TTS)
- `apps/backend/src/providers/translation/openai-streaming.provider.ts` — OpenAI провайдер с оптимизацией для стриминга (batch-перевод, кэш)

### Модифицируемые файлы
- `apps/backend/src/socket/handlers.ts` — Новое событие `start_streaming`, маршрутизация по режиму
- `apps/backend/src/providers/stt/deepgram.provider.ts` — Исправить таймштампы, добавить событие готовности соединения
- `apps/backend/src/providers/stt/stt.interface.ts` — Расширить `STTSegment` полем `duration`
- `apps/mobile/hooks/useSocket.ts` — Обработка `pause_video`, `resume_video` событий
- `apps/mobile/store/player.store.ts` — Новый статус `buffering`, действие `setAutoPause`
- `apps/mobile/store/settings.store.ts` — Поле `translationMode: 'free' | 'streaming'`
- `apps/mobile/components/ProviderSelector.tsx` — Переключатель режима (Free/Streaming)
- `apps/mobile/app/player/[id].tsx` — Логика автопаузы и автовоспроизведения
- `apps/mobile/components/ShadowPlayer.tsx` — Поддержка программной паузы из стора

---

## Chunk 1: Backend — Стриминговый оркестратор

### Task 1: Расширить STT интерфейс

**Files:**
- Modify: `apps/backend/src/providers/stt/stt.interface.ts`

- [ ] **Step 1: Добавить поле `duration` в `STTSegment`**

```typescript
// В интерфейсе STTSegment добавить:
export interface STTSegment {
  text: string;
  startTime: number;
  endTime: number;
  isFinal: boolean;
  gender?: SpeakerGender;
  duration?: number; // Длительность сегмента в секундах (от DeepGram)
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/providers/stt/stt.interface.ts
git commit -m "feat: add duration field to STTSegment interface"
```

---

### Task 2: Исправить DeepGram STT провайдер

**Files:**
- Modify: `apps/backend/src/providers/stt/deepgram.provider.ts`

Текущие проблемы:
1. `currentStartTime` считается по размеру чанка (`audioChunk.length / 16000`), а не по данным от DeepGram
2. Нет события готовности WebSocket
3. Нет обработки переподключения
4. `onSegmentCallback` перезаписывается каждый вызов `processChunk`

- [ ] **Step 1: Переписать DeepGram провайдер с правильными таймштампами**

```typescript
import { STTProvider, STTProviderOptions, STTSegment, SpeakerGender } from './stt.interface';

export class DeepgramSTTProvider implements STTProvider {
  readonly name = 'deepgram';

  private apiKey = '';
  private language = 'en';
  private connection: any = null;
  private client: any = null;
  private onSegmentCallback: ((segment: STTSegment) => Promise<void>) | null = null;
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private pendingChunks: Buffer[] = [];

  async initialize(options: STTProviderOptions): Promise<void> {
    this.apiKey = options.apiKey || '';
    this.language = options.language || 'en';

    if (!this.apiKey) {
      throw new Error('[DeepgramSTT] API ключ обязателен');
    }

    // Промис готовности — клиенты могут ждать
    this.readyPromise = new Promise(resolve => {
      this.readyResolve = resolve;
    });

    try {
      const { createClient, LiveTranscriptionEvents } = await import('@deepgram/sdk');
      this.client = createClient(this.apiKey);

      this.connection = this.client.listen.live({
        model: 'nova-2',
        language: this.language,
        smart_format: true,
        endpointing: 300,        // 300ms — быстрее реакция
        interim_results: false,   // Только финальные — меньше шума
        utterance_end_ms: 1000,   // Конец фразы через 1с тишины
        encoding: 'mp3',
        sample_rate: 44100,
      });

      this.connection.on(LiveTranscriptionEvents.Open, () => {
        console.log('[DeepgramSTT] WebSocket открыт');
        this.isReady = true;
        this.readyResolve?.();
        // Отправляем накопленные чанки
        for (const chunk of this.pendingChunks) {
          this.connection.send(chunk);
        }
        this.pendingChunks = [];
      });

      this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
        const alt = data.channel?.alternatives?.[0];
        if (!alt?.transcript || alt.transcript.trim().length === 0) return;
        if (!data.is_final) return;

        const startTime = data.start ?? 0;
        const duration = data.duration ?? 0;

        console.log(`[DeepgramSTT] Финальный: "${alt.transcript.trim()}" @ ${startTime.toFixed(1)}s (${duration.toFixed(1)}s)`);

        if (this.onSegmentCallback) {
          this.onSegmentCallback({
            text: alt.transcript.trim(),
            startTime,
            endTime: startTime + duration,
            duration,
            isFinal: true,
          });
        }
      });

      this.connection.on(LiveTranscriptionEvents.Error, (error: any) => {
        console.error('[DeepgramSTT] Ошибка:', error);
      });

      this.connection.on(LiveTranscriptionEvents.Close, () => {
        console.log('[DeepgramSTT] WebSocket закрыт');
        this.isReady = false;
      });

      console.log(`[DeepgramSTT] Инициализирован, язык: ${this.language}`);
    } catch (error) {
      throw new Error(`[DeepgramSTT] Ошибка инициализации: ${error}`);
    }
  }

  /** Ждёт готовности WebSocket */
  async waitReady(): Promise<void> {
    if (this.isReady) return;
    await this.readyPromise;
  }

  async processChunk(audioChunk: Buffer, onSegment: (segment: STTSegment) => Promise<void>): Promise<void> {
    this.onSegmentCallback = onSegment;

    if (this.isReady && this.connection) {
      this.connection.send(audioChunk);
    } else {
      // Буферизуем до готовности
      this.pendingChunks.push(audioChunk);
    }
  }

  async destroy(): Promise<void> {
    if (this.connection) {
      try { this.connection.finish(); } catch {}
      this.connection = null;
    }
    this.client = null;
    this.onSegmentCallback = null;
    this.isReady = false;
    this.pendingChunks = [];
    console.log('[DeepgramSTT] Завершён');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/providers/stt/deepgram.provider.ts
git commit -m "fix: deepgram STT - proper timestamps, ready state, chunk buffering"
```

---

### Task 3: Создать стриминговый оркестратор

**Files:**
- Create: `apps/backend/src/core/streaming-orchestrator.ts`

- [ ] **Step 1: Реализовать `StreamingOrchestrator`**

Ключевые отличия от обычного `Orchestrator`:
1. Эмитит `pause_video` при старте
2. Эмитит `resume_video` когда первый сегмент готов
3. Использует только платные провайдеры (DeepGram STT + OpenAI + DeepGram TTS)
4. Не ждёт пейсинга — стриминг идёт в реальном времени, синхронизация через таймштампы
5. Каждый сегмент несёт `startTime` и `duration` от DeepGram для точной синхронизации на клиенте

```typescript
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { YouTubeStreamer } from './youtube-streamer';
import { DeepgramSTTProvider } from '../providers/stt/deepgram.provider';
import { OpenAITranslationProvider } from '../providers/translation/openai.provider';
import { DeepgramTTSProvider } from '../providers/tts/deepgram-tts.provider';
import { TranslationSettings, TranslationSegment } from './orchestrator';

/**
 * Стриминговый оркестратор — минимальная задержка через платные API.
 *
 * Поток:
 * 1. pause_video → клиент ставит видео на паузу
 * 2. YouTube Audio → DeepGram STT (streaming WebSocket)
 * 3. Первый распознанный текст → OpenAI перевод → DeepGram TTS
 * 4. resume_video → клиент начинает воспроизведение
 * 5. Далее сегменты приходят в реальном времени с таймштампами
 */
export class StreamingOrchestrator extends EventEmitter {
  private youtubeStreamer: YouTubeStreamer;
  private sttProvider: DeepgramSTTProvider | null = null;
  private translationProvider: OpenAITranslationProvider | null = null;
  private ttsProvider: DeepgramTTSProvider | null = null;
  private isRunning = false;
  private segmentCounter = 0;
  private firstSegmentSent = false;
  private playbackTime = 0;

  constructor() {
    super();
    this.youtubeStreamer = new YouTubeStreamer();
  }

  setPlaybackTime(timeSec: number): void {
    this.playbackTime = timeSec;
  }

  async start(videoUrl: string, settings: TranslationSettings): Promise<void> {
    if (this.isRunning) {
      await this.stop();
    }

    this.isRunning = true;
    this.segmentCounter = 0;
    this.firstSegmentSent = false;

    try {
      // 1. Говорим клиенту поставить видео на паузу
      this.emit('pause_video');
      this.emit('status', 'Инициализация стриминга...');

      // 2. Инициализируем платные провайдеры
      await this.initProviders(settings);

      // 3. Получаем URL видео для клиента
      this.emit('status', 'Получение ссылки на видео...');
      try {
        const directVideoUrl = await this.youtubeStreamer.getVideoUrl(videoUrl);
        this.emit('video_url', directVideoUrl);
      } catch (error) {
        this.emit('error', 'Не удалось получить ссылку на видео.');
        return;
      }

      // 4. Ждём готовности DeepGram WebSocket
      this.emit('status', 'Подключение к DeepGram...');
      await this.sttProvider!.waitReady();

      // 5. Запускаем аудио-стрим и конвейер
      this.emit('status', 'Распознавание...');
      this.startPipeline(videoUrl);

    } catch (error) {
      console.error('[StreamingOrch] Ошибка запуска:', error);
      this.emit('error', `Ошибка: ${error instanceof Error ? error.message : String(error)}`);
      this.isRunning = false;
    }
  }

  private async initProviders(settings: TranslationSettings): Promise<void> {
    // STT — DeepGram streaming
    this.sttProvider = new DeepgramSTTProvider();
    await this.sttProvider.initialize({
      apiKey: settings.apiKeys.deepgram,
      language: 'en',
    });

    // Translation — OpenAI
    this.translationProvider = new OpenAITranslationProvider();
    await this.translationProvider.initialize({
      apiKey: settings.apiKeys.openai,
      sourceLanguage: 'en',
      targetLanguage: settings.targetLanguage,
    });

    // TTS — DeepGram (с автоматическим fallback на Edge TTS для неподдерживаемых языков)
    this.ttsProvider = new DeepgramTTSProvider();
    await this.ttsProvider.initialize({
      apiKey: settings.apiKeys.deepgram,
      language: settings.targetLanguage,
    });

    console.log('[StreamingOrch] Провайдеры инициализированы');
  }

  private startPipeline(videoUrl: string): void {
    let chunkCount = 0;

    this.youtubeStreamer.on('data', async (chunk: Buffer) => {
      if (!this.isRunning || !this.sttProvider) return;

      chunkCount++;
      if (chunkCount % 50 === 0) {
        console.log(`[StreamingOrch] Чанков: ${chunkCount}`);
      }

      try {
        await this.sttProvider.processChunk(chunk, async (segment) => {
          await this.processSegment(segment.text, segment.startTime, segment.duration);
        });
      } catch (error) {
        console.error('[StreamingOrch] Ошибка чанка:', error);
      }
    });

    this.youtubeStreamer.on('end', () => {
      this.emit('status', 'Стрим завершён');
    });

    this.youtubeStreamer.on('error', (error: Error) => {
      this.emit('error', `Ошибка стрима: ${error.message}`);
    });

    this.youtubeStreamer.startAudioStream(videoUrl);
    this.emit('status', 'Стриминг активен');
  }

  private splitIntoSentences(text: string): string[] {
    const raw = text.match(/[^.!?]+[.!?]+/g) || [text];
    const result: string[] = [];
    let current = '';

    for (const sentence of raw) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      if (current.length + trimmed.length > 120 && current.length > 0) {
        result.push(current.trim());
        current = trimmed;
      } else {
        current += (current ? ' ' : '') + trimmed;
      }
    }
    if (current.trim()) result.push(current.trim());
    return result.length > 0 ? result : [text];
  }

  private async processSegment(text: string, startTime: number, duration?: number): Promise<void> {
    if (!this.translationProvider || !this.ttsProvider || !this.isRunning) return;

    try {
      // Перевод
      const translatedText = await this.translationProvider.translate(text);
      if (!translatedText?.trim()) return;

      // Разбиваем на предложения
      const sentences = this.splitIntoSentences(translatedText);
      const segDuration = (duration || 5) / sentences.length;

      for (let i = 0; i < sentences.length; i++) {
        if (!this.isRunning) return;

        const sentenceText = sentences[i];
        const sentenceStartTime = startTime + i * segDuration;

        // TTS
        const audioBuffer = await this.ttsProvider.synthesize(sentenceText);

        const segment: TranslationSegment = {
          id: uuidv4(),
          text: sentenceText,
          startTime: sentenceStartTime,
          audioBase64: audioBuffer.length > 0 ? audioBuffer.toString('base64') : '',
        };

        this.segmentCounter++;
        this.emit('segment', segment);

        // Первый сегмент — resume видео
        if (!this.firstSegmentSent) {
          this.firstSegmentSent = true;
          this.emit('resume_video');
          console.log('[StreamingOrch] Первый сегмент отправлен → resume_video');
        }

        console.log(`[StreamingOrch] #${this.segmentCounter}: "${sentenceText.substring(0, 50)}" @ ${sentenceStartTime.toFixed(1)}s`);
      }
    } catch (error) {
      console.error('[StreamingOrch] Ошибка обработки:', error);
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.youtubeStreamer.stopStream();
    this.youtubeStreamer.removeAllListeners();

    if (this.sttProvider) {
      await this.sttProvider.destroy();
      this.sttProvider = null;
    }
    if (this.translationProvider) {
      await this.translationProvider.destroy();
      this.translationProvider = null;
    }
    if (this.ttsProvider) {
      await this.ttsProvider.destroy();
      this.ttsProvider = null;
    }

    console.log('[StreamingOrch] Остановлен');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/core/streaming-orchestrator.ts
git commit -m "feat: add StreamingOrchestrator for low-latency paid API mode"
```

---

### Task 4: Добавить роутинг в socket handlers

**Files:**
- Modify: `apps/backend/src/socket/handlers.ts`

- [ ] **Step 1: Добавить обработку `translationMode` в start-событие**

В `handlers.ts` добавить импорт `StreamingOrchestrator` и логику выбора:

```typescript
import { StreamingOrchestrator } from '../core/streaming-orchestrator';

// В обработчике 'start':
// После "const orchestrator = ..."
// Заменить создание оркестратора на:

const isStreaming = data.settings.translationMode === 'streaming';
const orchestrator = isStreaming
  ? new StreamingOrchestrator()
  : new Orchestrator();
activeOrchestrators.set(socket.id, orchestrator);

// Подписки — добавить pause_video и resume_video:
orchestrator.on('pause_video', () => {
  socket.emit('pause_video');
});

orchestrator.on('resume_video', () => {
  socket.emit('resume_video');
});

// Остальные подписки (segment, status, video_url, error) — без изменений
```

- [ ] **Step 2: Добавить `translationMode` в `TranslationSettings`**

В `apps/backend/src/core/orchestrator.ts`:

```typescript
export interface TranslationSettings {
  targetLanguage: string;
  sttProvider: string;
  translationProvider: string;
  ttsProvider: string;
  translationMode?: 'free' | 'streaming'; // Новое поле
  apiKeys: {
    deepgram?: string;
    openai?: string;
  };
}
```

- [ ] **Step 3: Аналогичные изменения в `update_settings` обработчике**

Тот же паттерн — выбор оркестратора по `translationMode`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/socket/handlers.ts apps/backend/src/core/orchestrator.ts
git commit -m "feat: route to StreamingOrchestrator based on translationMode setting"
```

---

## Chunk 2: Frontend — Автопауза и режим стриминга

### Task 5: Расширить settings store

**Files:**
- Modify: `apps/mobile/store/settings.store.ts`

- [ ] **Step 1: Добавить `translationMode` в стор**

```typescript
// В SettingsState добавить:
translationMode: 'free' | 'streaming';
setTranslationMode: (mode: 'free' | 'streaming') => void;

// В create({...}) добавить дефолт:
translationMode: 'free',

// Добавить сеттер:
setTranslationMode: (mode) => {
  set({ translationMode: mode });
  get().saveSettings();
},

// В saveSettings/loadSettings — добавить translationMode в объект сериализации
```

- [ ] **Step 2: Инкрементировать SETTINGS_VERSION до 3**

```typescript
const SETTINGS_VERSION = 3;
```

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/store/settings.store.ts
git commit -m "feat: add translationMode setting (free/streaming)"
```

---

### Task 6: Расширить player store

**Files:**
- Modify: `apps/mobile/store/player.store.ts`

- [ ] **Step 1: Добавить статус `buffering` и флаг автопаузы**

```typescript
// ConnectionStatus — добавить 'buffering':
export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'recognizing'
  | 'buffering'    // Ждём первый сегмент (видео на паузе)
  | 'translating'
  | 'error'
  | 'finished';

// statusMessages — добавить:
buffering: 'Буферизация...',

// PlayerState — добавить:
isAutoPaused: boolean; // Видео поставлено на паузу сервером
setAutoPause: (paused: boolean) => void;

// Дефолт:
isAutoPaused: false,

// Сеттер:
setAutoPause: (paused) => set({ isAutoPaused: paused }),

// В reset — добавить isAutoPaused: false
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/store/player.store.ts
git commit -m "feat: add buffering status and autoPause to player store"
```

---

### Task 7: Обработать серверные команды в useSocket

**Files:**
- Modify: `apps/mobile/hooks/useSocket.ts`

- [ ] **Step 1: Добавить обработчики `pause_video` и `resume_video`**

В `connect()`, после существующих обработчиков:

```typescript
const setAutoPause = usePlayerStore.getState().setAutoPause;
const setIsPlaying = usePlayerStore.getState().setIsPlaying;

socket.on('pause_video', () => {
  console.log('[Socket] Сервер: pause_video');
  setAutoPause(true);
  setIsPlaying(false);
  setStatus('buffering');
});

socket.on('resume_video', () => {
  console.log('[Socket] Сервер: resume_video');
  setAutoPause(false);
  setIsPlaying(true);
  setStatus('translating');
});
```

- [ ] **Step 2: Передавать `translationMode` в `startTranslation`**

```typescript
const startTranslation = useCallback((videoUrl: string) => {
  const settings = useSettingsStore.getState();
  socketService.startTranslation(videoUrl, {
    targetLanguage: settings.targetLanguage,
    sttProvider: settings.sttProvider,
    translationProvider: settings.translationProvider,
    ttsProvider: settings.ttsProvider,
    translationMode: settings.translationMode, // Новое
    apiKeys: {
      deepgram: settings.deepgramApiKey || undefined,
      openai: settings.openaiApiKey || undefined,
    },
  });
  setStatus('connecting');
}, [setStatus]);
```

- [ ] **Step 3: Обновить `socket.service.ts` — добавить `translationMode` в типы**

В `socketService.startTranslation()` и `socketService.updateSettings()` — добавить `translationMode?` в параметр `settings`.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/hooks/useSocket.ts apps/mobile/services/socket.service.ts
git commit -m "feat: handle pause_video/resume_video events, pass translationMode"
```

---

### Task 8: Добавить переключатель режима в ProviderSelector

**Files:**
- Modify: `apps/mobile/components/ProviderSelector.tsx`

- [ ] **Step 1: Добавить UI переключателя режима**

В начало компонента (до выбора провайдеров) добавить сегментированный контрол:

```tsx
const translationMode = useSettingsStore(state => state.translationMode);
const setTranslationMode = useSettingsStore(state => state.setTranslationMode);

// JSX — перед секцией провайдеров:
<View style={styles.modeSection}>
  <Text style={styles.sectionTitle}>РЕЖИМ</Text>
  <View style={styles.modeRow}>
    <TouchableOpacity
      style={[styles.modeButton, translationMode === 'free' && styles.modeActive]}
      onPress={() => { setTranslationMode('free'); onProviderChange?.(); }}
    >
      <Text style={[styles.modeText, translationMode === 'free' && styles.modeTextActive]}>
        Бесплатный
      </Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={[styles.modeButton, translationMode === 'streaming' && styles.modeActive]}
      onPress={() => { setTranslationMode('streaming'); onProviderChange?.(); }}
    >
      <Text style={[styles.modeText, translationMode === 'streaming' && styles.modeTextActive]}>
        Стриминг (API)
      </Text>
    </TouchableOpacity>
  </View>
</View>
```

- [ ] **Step 2: При `streaming` — показывать только поля API ключей, скрывать выбор провайдеров**

Если `translationMode === 'streaming'`, скрыть выбор STT/Translation/TTS провайдеров (используются фиксированные: DeepGram + OpenAI + DeepGram). Показать только поля API ключей.

- [ ] **Step 3: Добавить стили**

```typescript
modeSection: { marginBottom: 16 },
modeRow: { flexDirection: 'row', gap: 8 },
modeButton: {
  flex: 1,
  paddingVertical: 10,
  borderRadius: 10,
  backgroundColor: 'rgba(255,255,255,0.05)',
  alignItems: 'center',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.1)',
},
modeActive: {
  backgroundColor: 'rgba(0,122,255,0.2)',
  borderColor: theme.colors.accent,
},
modeText: { color: '#777', fontSize: 12, fontWeight: '700' },
modeTextActive: { color: theme.colors.accent },
```

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/components/ProviderSelector.tsx
git commit -m "feat: add Free/Streaming mode toggle in ProviderSelector"
```

---

### Task 9: Статус буферизации в UI плеера

**Files:**
- Modify: `apps/mobile/app/player/[id].tsx`

- [ ] **Step 1: Показать индикатор буферизации**

Когда `status === 'buffering'`, отобразить оверлей поверх видео:

```tsx
{status === 'buffering' && (
  <View style={styles.bufferingOverlay}>
    <ActivityIndicator size="large" color={theme.colors.accent} />
    <Text style={styles.bufferingText}>Подготовка перевода...</Text>
  </View>
)}
```

Стиль:

```typescript
bufferingOverlay: {
  ...StyleSheet.absoluteFillObject,
  backgroundColor: 'rgba(0,0,0,0.7)',
  justifyContent: 'center',
  alignItems: 'center',
  zIndex: 200,
},
bufferingText: {
  color: '#fff',
  marginTop: 16,
  fontSize: 16,
  fontWeight: '600',
},
```

- [ ] **Step 2: Добавить `ActivityIndicator` в импорты**

```typescript
import { View, Text, StyleSheet, TouchableOpacity, Switch, Dimensions, Platform, ActivityIndicator } from 'react-native';
```

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/player/[id].tsx
git commit -m "feat: add buffering overlay when waiting for first segment"
```

---

## Chunk 3: Интеграция и тестирование

### Task 10: Ручное тестирование E2E

- [ ] **Step 1: Запустить бэкенд**

```bash
cd apps/backend && npm run dev
```

- [ ] **Step 2: Запустить фронтенд**

```bash
cd apps/mobile && npm run web
```

- [ ] **Step 3: Тест бесплатного режима (регрессия)**

1. Открыть приложение, убедиться что режим «Бесплатный» выбран по умолчанию
2. Вставить URL YouTube видео
3. Нажать «Смотреть с переводом»
4. Включить перевод — видео должно играть, субтитры появляться
5. Поставить на паузу — озвучка должна остановиться

Ожидание: всё работает как раньше.

- [ ] **Step 4: Тест стримингового режима**

1. Переключить на режим «Стриминг (API)»
2. Ввести API ключи DeepGram и OpenAI
3. Вставить URL YouTube видео
4. Нажать «Смотреть с переводом»
5. Включить перевод:
   - Видео должно встать на паузу (buffering overlay)
   - Статус: «Буферизация...»
   - Через 3-5 сек первый сегмент приходит → видео начинает играть
   - Субтитры и озвучка синхронизированы с видео

- [ ] **Step 5: Commit финальный**

```bash
git add -A
git commit -m "feat: streaming translation mode with DeepGram STT + OpenAI + DeepGram TTS"
```

---

## Резюме архитектуры

```
[Бесплатный режим]
YouTube → yt-dlp → local-whisper → LibreTranslate → Edge TTS → Client
                                                                  ↕ (Socket.IO)

[Стриминговый режим]
YouTube → yt-dlp → DeepGram STT (WS) → OpenAI GPT-4o-mini → DeepGram TTS → Client
                   ↕ pause_video                                              ↕ resume_video
                   Client video pauses                        Client video resumes on 1st segment
```

Ключевое: оба режима используют один и тот же `YouTubeStreamer`, `audio-queue.service`, `ShadowPlayer` и Socket.IO транспорт. Разница только в оркестраторе и провайдерах.
