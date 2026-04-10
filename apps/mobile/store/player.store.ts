import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/**
 * Сегмент перевода от бэкенда
 */
export interface TranslationSegment {
  id: string;
  text: string;
  startTime: number;
  duration: number;      // Длительность оригинального сегмента (секунды видео)
  audioDuration: number; // Реальная длительность TTS аудио (секунды при 1x)
  audioBase64: string;
}

/**
 * Статусы подключения
 */
export type ConnectionStatus =
  | 'idle'          // Ожидание
  | 'connecting'    // Подключение
  | 'recognizing'   // Распознавание речи
  | 'buffering'     // Ждём первый сегмент (видео на паузе)
  | 'translating'   // Перевод активен
  | 'error'         // Ошибка
  | 'finished';     // Завершён

/**
 * Текстовые описания статусов на русском
 */
export const statusMessages: Record<ConnectionStatus, string> = {
  idle: 'Ожидание',
  connecting: 'Подключение...',
  recognizing: 'Распознавание...',
  translating: 'Перевод активен',
  buffering: 'Буферизация...',
  error: 'Ошибка',
  finished: 'Завершён',
};

/**
 * Стор состояния плеера
 */
export interface PlayerState {
  // Состояние
  isPlaying: boolean;
  status: ConnectionStatus;
  errorMessage: string;

  // Видео
  videoUrl: string;
  currentTime: number;
  playbackRate: number;

  // Сегменты перевода
  segments: TranslationSegment[];
  currentSegment: TranslationSegment | null;
  currentSubtitle: string;

  // Автопауза (сервер поставил на паузу)
  isAutoPaused: boolean;

  // Информация о провайдерах (от сервера)
  providerInfo: { stt: string; translation: string; tts: string } | null;

  // Действия
  setAutoPause: (paused: boolean) => void;
  setIsPlaying: (playing: boolean) => void;
  setStatus: (status: ConnectionStatus) => void;
  setErrorMessage: (message: string) => void;
  setVideoUrl: (url: string) => void;
  setCurrentTime: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
  addSegment: (segment: TranslationSegment) => void;
  setCurrentSegment: (segment: TranslationSegment | null) => void;
  setCurrentSubtitle: (text: string) => void;
  setProviderInfo: (info: { stt: string; translation: string; tts: string } | null) => void;
  reset: () => void;
}

export const usePlayerStore = create<PlayerState>()(subscribeWithSelector((set) => ({
  isPlaying: false,
  status: 'idle',
  errorMessage: '',
  videoUrl: '',
  currentTime: 0,
  playbackRate: 1,
  segments: [],
  currentSegment: null,
  isAutoPaused: false,
  currentSubtitle: '',
  providerInfo: null,

  setAutoPause: (paused) => set({ isAutoPaused: paused }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setStatus: (status) => set({ status }),
  setErrorMessage: (message) => set({ errorMessage: message, status: 'error' }),
  setVideoUrl: (url) => set({ videoUrl: url }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),

  addSegment: (segment) =>
    set((state) => ({
      segments: [...state.segments, segment],
    })),

  setCurrentSegment: (segment) => set({ currentSegment: segment }),
  setCurrentSubtitle: (text) => set({ currentSubtitle: text }),
  setProviderInfo: (info) => set({ providerInfo: info }),

  reset: () =>
    set({
      isPlaying: false,
      status: 'idle',
      errorMessage: '',
      videoUrl: '',
      currentTime: 0,
      playbackRate: 1,
      segments: [],
      currentSegment: null,
      isAutoPaused: false,
      currentSubtitle: '',
      providerInfo: null,
    }),
})));
