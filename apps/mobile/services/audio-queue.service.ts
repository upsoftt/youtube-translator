import { Audio } from 'expo-av';
import { TranslationSegment } from '../store/player.store';
import { usePlayerStore } from '../store/player.store';

/**
 * Сервис воспроизведения переведённых сегментов, синхронизированный с видео.
 *
 * Стратегия синхронизации (два уровня):
 *
 * 1. Rate-fitting (Вариант 1) — для каждого сегмента вычисляем скорость
 *    воспроизведения TTS так, чтобы аудио уложилось в окно оригинального сегмента:
 *
 *      rate = (audioDuration / segmentDuration) * videoPlaybackRate
 *
 *    Clamp: [0.75, 2.5] — за этими границами качество голоса деградирует.
 *
 * 2. Hard-skip (Вариант 2) — если сегмент устарел (video ушло вперёд более чем
 *    на HARD_SKIP_THRESHOLD секунд от конца окна сегмента) — пропускаем его.
 *    Это предотвращает накопление дрейфа.
 */

/** Граница hard-skip: сколько секунд после конца окна сегмента он всё ещё актуален */
const HARD_SKIP_THRESHOLD = 3;

/** Минимальный допустимый rate воспроизведения TTS */
const RATE_MIN = 0.75;

/** Максимальный допустимый rate воспроизведения TTS */
const RATE_MAX = 2.5;

class AudioQueueService {
  private segments: TranslationSegment[] = [];
  private currentSound: Audio.Sound | null = null;
  private currentSegment: TranslationSegment | null = null; // для пересчёта rate при смене скорости
  private isPlaying = false;
  private isPaused = false;
  private volume = 1.0;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private rateUnsubscribe: (() => void) | null = null; // подписка на playbackRate
  private playingSegmentId: string | null = null;
  private onSubtitleChange: ((text: string) => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  setSubtitleCallback(cb: (text: string) => void): void {
    this.onSubtitleChange = cb;
  }

  /**
   * Добавляет сегмент и запускает планировщик
   */
  enqueue(segment: TranslationSegment): void {
    this.segments.push(segment);
    this.segments.sort((a, b) => a.startTime - b.startTime);

    if (!this.unsubscribe && !this.isPaused) {
      this.startScheduler();
    }
  }

  /**
   * Проверяет очередь и запускает подходящий сегмент.
   * Вызывается при каждом обновлении currentTime.
   */
  private checkQueue(videoTime: number): void {
    if (this.isPaused || this.isPlaying) return;
    if (videoTime <= 0) return;

    // Убираем полностью устаревшие сегменты
    this.segments = this.segments.filter(s => {
      const windowEnd = s.startTime + (s.duration || 5);
      return windowEnd + 2 >= videoTime;
    });

    // Берём САМЫЙ ПОЗДНИЙ сегмент, чей startTime уже наступил (+ 0.5с lookahead)
    // Если накопилось несколько — пропускаем устаревшие, играем самый актуальный
    let playIdx = -1;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].startTime <= videoTime + 0.5 &&
          this.segments[i].id !== this.playingSegmentId) {
        playIdx = i;
      } else {
        break;
      }
    }

    if (playIdx !== -1) {
      if (playIdx > 0) {
        console.log(`[AudioQueue] Пропуск ${playIdx} устаревших, t=${this.segments[playIdx].startTime.toFixed(1)}s`);
      }
      const segment = this.segments[playIdx];
      this.segments.splice(0, playIdx + 1);
      const drift = videoTime - segment.startTime;
      console.log(
        `[AudioQueue] Play: "${segment.text.substring(0, 40)}" ` +
        `@ video=${videoTime.toFixed(1)}s start=${segment.startTime.toFixed(1)}s ` +
        `drift=${drift > 0 ? '+' : ''}${drift.toFixed(2)}s`
      );
      this.playSegment(segment);
    }

    // Останавливаем планировщик если нечего воспроизводить
    if (this.segments.length === 0 && !this.isPlaying) {
      this.stopScheduler();
    }
  }

  /**
   * Планировщик — event-driven подписка на currentTime + fallback interval
   */
  private startScheduler(): void {
    if (this.unsubscribe) return;

    // Подписка на изменения currentTime
    this.unsubscribe = usePlayerStore.subscribe(
      (state) => state.currentTime,
      (currentTime) => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.checkQueue(currentTime);
        }, 50);
      }
    );

    // Подписка на изменения playbackRate — пересчитываем rate играющего сегмента
    this.rateUnsubscribe = usePlayerStore.subscribe(
      (state) => state.playbackRate,
      (newRate) => { this.onVideoRateChange(newRate); }
    );

    // Fallback: проверяем раз в секунду
    this.fallbackTimer = setInterval(() => {
      const videoTime = usePlayerStore.getState().currentTime;
      this.checkQueue(videoTime);
    }, 1000);
  }

  private stopScheduler(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.rateUnsubscribe) {
      this.rateUnsubscribe();
      this.rateUnsubscribe = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Вызывается когда YouTube меняет скорость воспроизведения.
   * Пересчитывает rate для уже играющего сегмента и применяет его немедленно.
   */
  private async onVideoRateChange(newVideoRate: number): Promise<void> {
    if (!this.currentSound || !this.currentSegment || !this.isPlaying) return;

    const seg = this.currentSegment;
    let rate = newVideoRate;

    if (seg.audioDuration > 0 && seg.duration > 0) {
      rate = (seg.audioDuration / seg.duration) * newVideoRate;
      rate = Math.min(RATE_MAX, Math.max(newVideoRate, rate));
    }

    console.log(
      `[AudioQueue] Rate update (videoRate changed → ${newVideoRate.toFixed(2)}x): ` +
      `new TTS rate = ${rate.toFixed(2)}x`
    );

    try {
      await this.currentSound.setRateAsync(rate, true); // true = shouldCorrectPitch
    } catch {
      // Звук мог уже закончиться — игнорируем
    }
  }

  /**
   * Вычисляет скорость воспроизведения TTS (Rate-fitting, Вариант 1).
   *
   * Цель: аудио TTS должно укладываться в окно оригинального сегмента с учётом
   * скорости воспроизведения видео.
   *
   * Формула:
   *   rate = (audioDuration / segmentDuration) * videoPlaybackRate
   *
   * При videoPlaybackRate > 1 видео идёт быстрее → TTS тоже нужно ускорить.
   */
  private calculatePlaybackRate(segment: TranslationSegment): number {
    const videoPlaybackRate = usePlayerStore.getState().playbackRate || 1;
    const videoTime         = usePlayerStore.getState().currentTime;
    const segmentDuration   = segment.duration;
    const audioDuration     = segment.audioDuration;

    if (!audioDuration || audioDuration <= 0 || !segmentDuration || segmentDuration <= 0) {
      return Math.min(RATE_MAX, Math.max(videoPlaybackRate, videoPlaybackRate));
    }

    // Учитываем дрейф: если воспроизводим с опозданием — окно уменьшается
    const drift = videoTime - segment.startTime;
    const effectiveDuration = Math.max(0.5, segmentDuration - Math.max(0, drift));

    const rawRate = (audioDuration / effectiveDuration) * videoPlaybackRate;
    // Никогда не замедляем ниже videoPlaybackRate — пауза лучше, чем растянутая речь
    const clampedRate = Math.min(RATE_MAX, Math.max(videoPlaybackRate, rawRate));

    console.log(
      `[AudioQueue] Rate-fit: audioDur=${audioDuration.toFixed(2)}s ` +
      `segDur=${segmentDuration.toFixed(2)}s ` +
      `videoRate=${videoPlaybackRate.toFixed(2)}x ` +
      `→ raw=${rawRate.toFixed(2)}x clamped=${clampedRate.toFixed(2)}x`
    );

    return clampedRate;
  }

  /**
   * Воспроизводит один сегмент с rate-fitting
   */
  private async playSegment(segment: TranslationSegment): Promise<void> {
    if (!segment.audioBase64 || segment.audioBase64.length === 0) {
      // Только субтитр, без аудио
      this.onSubtitleChange?.(segment.text);
      return;
    }

    try {
      this.isPlaying = true;
      this.playingSegmentId = segment.id;
      this.currentSegment   = segment; // сохраняем для пересчёта при смене скорости
      this.onSubtitleChange?.(segment.text);

      const uri  = `data:audio/mp3;base64,${segment.audioBase64}`;
      const rate = this.calculatePlaybackRate(segment);

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        {
          shouldPlay: true,
          volume: this.volume,
          rate,
          shouldCorrectPitch: true,
        }
      );

      this.currentSound = sound;

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync();
          this.currentSound   = null;
          this.currentSegment = null;
          this.isPlaying      = false;
          this.onSubtitleChange?.('');

          const videoTime = usePlayerStore.getState().currentTime;
          this.checkQueue(videoTime);
        }
      });
    } catch (error) {
      console.error('[AudioQueue] Ошибка воспроизведения:', error);
      this.isPlaying      = false;
      this.currentSound   = null;
      this.currentSegment = null;
    }
  }

  async pause(): Promise<void> {
    this.isPaused = true;
    if (this.currentSound) {
      try { await this.currentSound.pauseAsync(); } catch {}
    }
  }

  async resume(): Promise<void> {
    this.isPaused = false;
    if (this.currentSound) {
      try { await this.currentSound.playAsync(); } catch {}
    }
    if (this.segments.length > 0 && !this.unsubscribe) {
      this.startScheduler();
    }
  }

  async setVolume(volume: number): Promise<void> {
    this.volume = volume;
    if (this.currentSound) {
      try { await this.currentSound.setVolumeAsync(volume); } catch {}
    }
  }

  async stopCurrent(): Promise<void> {
    if (this.currentSound) {
      try {
        await this.currentSound.stopAsync();
        await this.currentSound.unloadAsync();
      } catch {}
      this.currentSound = null;
    }
    this.isPlaying      = false;
    this.currentSegment = null;
  }

  async clear(): Promise<void> {
    this.isPaused = false;
    this.segments = [];
    this.playingSegmentId = null;
    this.stopScheduler();
    await this.stopCurrent();
    this.onSubtitleChange?.('');
  }

  get size(): number {
    return this.segments.length;
  }
}

export const audioQueueService = new AudioQueueService();
