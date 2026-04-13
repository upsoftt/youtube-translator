// ═══════════════════════════════════════════════════════════════
// YouTube Translator — клиентский JS
// Alpine.js stores + WebSocket клиент + Audio Queue
// ═══════════════════════════════════════════════════════════════

// --- Утилиты ---

function extractVideoId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// --- Alpine.js Settings Store (localStorage) ---

document.addEventListener('alpine:init', () => {
  const saved = JSON.parse(localStorage.getItem('yt-translator-settings') || '{}');

  Alpine.store('settings', {
    targetLanguage: saved.targetLanguage || 'ru',
    originalVolume: saved.originalVolume ?? 0.2,
    translationVolume: saved.translationVolume ?? 1.0,
    sttProvider: saved.sttProvider || 'local-whisper',
    translationProvider: saved.translationProvider || 'libre',
    ttsProvider: saved.ttsProvider || 'edge-tts',
    translationMode: saved.translationMode || 'free',
    backendUrl: saved.backendUrl || 'http://localhost:8211',
    deepgramApiKey: saved.deepgramApiKey || '',
    openaiApiKey: saved.openaiApiKey || '',

    save() {
      localStorage.setItem('yt-translator-settings', JSON.stringify({
        targetLanguage: this.targetLanguage,
        originalVolume: this.originalVolume,
        translationVolume: this.translationVolume,
        sttProvider: this.sttProvider,
        translationProvider: this.translationProvider,
        ttsProvider: this.ttsProvider,
        translationMode: this.translationMode,
        backendUrl: this.backendUrl,
        deepgramApiKey: this.deepgramApiKey,
        openaiApiKey: this.openaiApiKey,
      }));
    }
  });

  // Автосохранение при любом изменении
  Alpine.effect(() => {
    const s = Alpine.store('settings');
    // Обращаемся ко всем реактивным полям чтобы Alpine трекал их
    void(s.targetLanguage, s.translationMode, s.sttProvider, s.translationProvider, s.ttsProvider, s.backendUrl);
    s.save();
  });
});

// --- WebSocket Client ---

class WsClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.onMessage = null;
    this.onClose = null;
  }

  connect(onOpen) {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      console.log('[WS] Подключён');
      onOpen?.();
    };
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.onMessage?.(msg.type, msg.data);
      } catch (e) {
        console.warn('[WS] Невалидное сообщение:', e);
      }
    };
    this.ws.onclose = () => {
      console.log('[WS] Отключён');
      this.onClose?.();
    };
    this.ws.onerror = (e) => {
      console.error('[WS] Ошибка:', e);
    };
  }

  send(type, data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

// --- Audio Queue (rate-fitting + sync) ---

const HARD_SKIP_THRESHOLD = 3;
const RATE_MIN = 0.75;
const RATE_MAX = 2.5;

class AudioQueue {
  constructor() {
    this.segments = [];
    this.currentAudio = null;
    this.currentSegment = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.volume = 1.0;
    this.videoTime = 0;
    this.playingSegmentId = null;
    this.onSubtitleChange = null;
  }

  enqueue(segment) {
    this.segments.push(segment);
    this.segments.sort((a, b) => a.startTime - b.startTime);
    this.checkQueue();
  }

  checkQueue() {
    if (this.isPaused || this.isPlaying) return;
    if (this.videoTime <= 0) return;

    // Убираем устаревшие
    this.segments = this.segments.filter(s => {
      const windowEnd = s.startTime + (s.duration || 5);
      return windowEnd + 2 >= this.videoTime;
    });

    // Берём самый актуальный сегмент, чей startTime наступил
    let playIdx = -1;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].startTime <= this.videoTime + 0.5 &&
          this.segments[i].id !== this.playingSegmentId) {
        playIdx = i;
      } else {
        break;
      }
    }

    if (playIdx !== -1) {
      const segment = this.segments[playIdx];
      this.segments.splice(0, playIdx + 1);
      this.playSegment(segment);
    }
  }

  playSegment(segment) {
    if (!segment.audioBase64 || segment.audioBase64.length === 0) {
      this.onSubtitleChange?.(segment.text);
      return;
    }

    this.isPlaying = true;
    this.playingSegmentId = segment.id;
    this.currentSegment = segment;
    this.onSubtitleChange?.(segment.text);

    const audio = new Audio('data:audio/mp3;base64,' + segment.audioBase64);
    audio.volume = this.volume;
    audio.playbackRate = this.calculateRate(segment);
    this.currentAudio = audio;

    audio.onended = () => {
      this.currentAudio = null;
      this.currentSegment = null;
      this.isPlaying = false;
      this.onSubtitleChange?.('');
      this.checkQueue();
    };

    audio.onerror = () => {
      console.error('[AudioQueue] Ошибка воспроизведения');
      this.currentAudio = null;
      this.currentSegment = null;
      this.isPlaying = false;
    };

    audio.play().catch(() => {
      this.isPlaying = false;
      this.currentAudio = null;
    });
  }

  calculateRate(segment) {
    const videoRate = 1; // TODO: получать из YouTube player
    const audioDuration = segment.audioDuration;
    const segDuration = segment.duration;

    if (!audioDuration || audioDuration <= 0 || !segDuration || segDuration <= 0) {
      return videoRate;
    }

    const drift = this.videoTime - segment.startTime;
    const effectiveDuration = Math.max(0.5, segDuration - Math.max(0, drift));
    const rawRate = (audioDuration / effectiveDuration) * videoRate;
    return Math.min(RATE_MAX, Math.max(videoRate, rawRate));
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.currentAudio) this.currentAudio.volume = vol;
  }

  pause() {
    this.isPaused = true;
    this.currentAudio?.pause();
  }

  resume() {
    this.isPaused = false;
    this.currentAudio?.play().catch(() => {});
    this.checkQueue();
  }

  clear() {
    this.segments = [];
    this.playingSegmentId = null;
    this.isPaused = false;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.isPlaying = false;
    this.currentSegment = null;
    this.onSubtitleChange?.('');
  }
}
