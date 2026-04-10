import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Стор настроек приложения.
 * Сохраняет выбранные провайдеры, язык, громкость и API ключи.
 */

export interface SettingsState {
  // Язык перевода
  targetLanguage: string;

  // Громкость
  originalVolume: number; // 0-1 (по умолчанию 0.2 = 20%)
  translationVolume: number; // 0-1 (по умолчанию 1.0 = 100%)

  // Провайдеры
  sttProvider: string;
  translationProvider: string;
  ttsProvider: string;

  // API ключи
  deepgramApiKey: string;
  openaiApiKey: string;

  // Режим перевода
  translationMode: 'free' | 'streaming';

  // Предпочитать субтитры YouTube вместо STT
  preferSubtitles: boolean;

  // Адрес бэкенда
  backendUrl: string;

  // Действия
  setTranslationMode: (mode: 'free' | 'streaming') => void;
  setPreferSubtitles: (prefer: boolean) => void;
  setTargetLanguage: (language: string) => void;
  setOriginalVolume: (volume: number) => void;
  setTranslationVolume: (volume: number) => void;
  setSttProvider: (provider: string) => void;
  setTranslationProvider: (provider: string) => void;
  setTtsProvider: (provider: string) => void;
  setDeepgramApiKey: (key: string) => void;
  setOpenaiApiKey: (key: string) => void;
  setBackendUrl: (url: string) => void;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
}

const STORAGE_KEY = 'youtube-translator-settings';
const SETTINGS_VERSION = 7; // 7: порт сменён с 3100 на 8211 // Инкрементируем при смене дефолтов для принудительного сброса

export const useSettingsStore = create<SettingsState>((set, get) => ({
  targetLanguage: 'ru',
  originalVolume: 0.2,
  translationVolume: 1.0,
  sttProvider: 'deepgram',
  translationProvider: 'openai',
  ttsProvider: 'deepgram-tts',
  deepgramApiKey: '',
  openaiApiKey: '',
  translationMode: 'streaming',
  preferSubtitles: true,
  backendUrl: 'http://localhost:8211',

  setTranslationMode: (mode) => {
    set({ translationMode: mode });
    get().saveSettings();
  },

  setPreferSubtitles: (prefer) => {
    set({ preferSubtitles: prefer });
    get().saveSettings();
  },

  setTargetLanguage: (language) => {
    set({ targetLanguage: language });
    get().saveSettings();
  },

  setOriginalVolume: (volume) => {
    set({ originalVolume: volume });
  },

  setTranslationVolume: (volume) => {
    set({ translationVolume: volume });
  },

  setSttProvider: (provider) => {
    set({ sttProvider: provider });
    get().saveSettings();
  },

  setTranslationProvider: (provider) => {
    set({ translationProvider: provider });
    get().saveSettings();
  },

  setTtsProvider: (provider) => {
    set({ ttsProvider: provider });
    get().saveSettings();
  },

  setDeepgramApiKey: (key) => {
    set({ deepgramApiKey: key });
    get().saveSettings();
  },

  setOpenaiApiKey: (key) => {
    set({ openaiApiKey: key });
    get().saveSettings();
  },

  setBackendUrl: (url) => {
    set({ backendUrl: url });
    get().saveSettings();
  },

  loadSettings: async () => {
    try {
      // 1. Загружаем локальные настройки
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if ((parsed._version ?? 0) < SETTINGS_VERSION) {
          console.log('[Settings] Устаревшая версия настроек, сброс на дефолты');
          await AsyncStorage.removeItem(STORAGE_KEY);
        } else {
          set({
            targetLanguage: parsed.targetLanguage ?? 'ru',
            originalVolume: parsed.originalVolume ?? 0.2,
            translationVolume: parsed.translationVolume ?? 1.0,
            sttProvider: parsed.sttProvider ?? 'deepgram',
            translationProvider: parsed.translationProvider ?? 'openai',
            ttsProvider: parsed.ttsProvider ?? 'deepgram-tts',
            deepgramApiKey: parsed.deepgramApiKey ?? '',
            openaiApiKey: parsed.openaiApiKey ?? '',
            translationMode: parsed.translationMode ?? 'streaming',
            preferSubtitles: parsed.preferSubtitles ?? true,
            backendUrl: parsed.backendUrl ?? 'http://localhost:8211',
          });
        }
      }

      // 2. Загружаем API-ключи с сервера (из .env) — они приоритетнее
      const backendUrl = get().backendUrl;
      try {
        const resp = await fetch(`${backendUrl}/api/keys`);
        if (resp.ok) {
          const keys = await resp.json();
          const updates: Partial<{ deepgramApiKey: string; openaiApiKey: string }> = {};
          if (keys.deepgramApiKey && !get().deepgramApiKey) {
            updates.deepgramApiKey = keys.deepgramApiKey;
          }
          if (keys.openaiApiKey && !get().openaiApiKey) {
            updates.openaiApiKey = keys.openaiApiKey;
          }
          if (Object.keys(updates).length > 0) {
            set(updates);
            console.log('[Settings] API-ключи загружены с сервера');
          }
        }
      } catch {
        console.log('[Settings] Сервер недоступен, используем локальные ключи');
      }
    } catch (error) {
      console.error('Ошибка загрузки настроек:', error);
    }
  },

  saveSettings: async () => {
    try {
      const state = get();
      const data = {
        _version: SETTINGS_VERSION,
        targetLanguage: state.targetLanguage,
        originalVolume: state.originalVolume,
        translationVolume: state.translationVolume,
        sttProvider: state.sttProvider,
        translationProvider: state.translationProvider,
        ttsProvider: state.ttsProvider,
        deepgramApiKey: state.deepgramApiKey,
        openaiApiKey: state.openaiApiKey,
        translationMode: state.translationMode,
        preferSubtitles: state.preferSubtitles,
        backendUrl: state.backendUrl,
      };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('Ошибка сохранения настроек:', error);
    }
  },
}));
