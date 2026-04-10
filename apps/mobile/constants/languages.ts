/**
 * Список поддерживаемых языков перевода
 */
export interface Language {
  code: string;
  name: string;
  nativeName: string;
}

export const languages: Language[] = [
  { code: 'ru', name: 'Русский', nativeName: 'Русский' },
  { code: 'en', name: 'Английский', nativeName: 'English' },
  { code: 'es', name: 'Испанский', nativeName: 'Español' },
  { code: 'de', name: 'Немецкий', nativeName: 'Deutsch' },
  { code: 'fr', name: 'Французский', nativeName: 'Français' },
  { code: 'zh', name: 'Китайский', nativeName: '中文' },
  { code: 'ja', name: 'Японский', nativeName: '日本語' },
  { code: 'ko', name: 'Корейский', nativeName: '한국어' },
];

/**
 * Список провайдеров
 */
export interface ProviderOption {
  id: string;
  name: string;
  description: string;
  isFree: boolean;
  requiresKey?: 'deepgram' | 'openai';
}

export const sttProviders: ProviderOption[] = [
  { id: 'whisper', name: 'Whisper', description: 'Бесплатный, локальный', isFree: true },
  { id: 'deepgram', name: 'DeepGram', description: 'Платный, real-time', isFree: false, requiresKey: 'deepgram' },
];

export const translationProviders: ProviderOption[] = [
  { id: 'libre', name: 'LibreTranslate', description: 'Бесплатный, открытый', isFree: true },
  { id: 'openai', name: 'OpenAI GPT-4o', description: 'Платный, высокое качество', isFree: false, requiresKey: 'openai' },
];

export const ttsProviders: ProviderOption[] = [
  { id: 'edge-tts', name: 'Edge TTS', description: 'Бесплатный, Microsoft', isFree: true },
  { id: 'deepgram-tts', name: 'DeepGram Aura', description: 'Платный, премиум', isFree: false, requiresKey: 'deepgram' },
];
