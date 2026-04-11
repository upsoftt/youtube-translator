/**
 * Реестр TTS-провайдеров.
 * Каждая запись описывает провайдер и поля конфигурации,
 * которые нужно отображать в UI расширения.
 */

export interface TTSFieldDef {
  key: string;
  label: string;
  /** 'password' — скрытый ввод, 'text' — обычный, 'url' — URL, 'select' — выпадающий список */
  type: 'password' | 'text' | 'url' | 'select';
  required: boolean;
  placeholder?: string;
  /** URL для загрузки опций (для type='select'). GET-запрос, ответ: [{value, label}] */
  optionsUrl?: string;
  /** Ключ из ttsProviderConfig, содержащий API key для запроса опций */
  optionsApiKeyField?: string;
}

export interface TTSProviderMeta {
  id: string;
  name: string;
  description: string;
  /** Поддерживает zero-shot клонирование голоса из видео */
  supportsVoiceClone: boolean;
  /** Поля конфигурации, которые показываем в панели расширения */
  fields: TTSFieldDef[];
}

export const TTS_PROVIDERS_REGISTRY: TTSProviderMeta[] = [
  {
    id: 'edge-tts',
    name: 'Edge TTS (бесплатный)',
    description: 'Microsoft Edge TTS через Python edge-tts. Бесплатно, не требует ключа.',
    supportsVoiceClone: false,
    fields: [],
  },
  {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    description: 'Высококачественный синтез от OpenAI. Поддерживает русский, китайский, японский.',
    supportsVoiceClone: false,
    fields: [
      {
        key: 'apiKey',
        label: 'OpenAI API ключ',
        type: 'password',
        required: true,
        placeholder: 'sk-...',
      },
    ],
  },
  {
    id: 'cosyvoice',
    name: 'CosyVoice (локальный, WSL2)',
    description: 'Локальная модель 0.5B с клонированием голоса. Требует запущенного сервера в WSL2.',
    supportsVoiceClone: true,
    fields: [
      {
        key: 'serverUrl',
        label: 'URL сервера',
        type: 'url',
        required: true,
        placeholder: 'http://localhost:8020',
      },
      {
        key: 'apiKey',
        label: 'API ключ (Bearer)',
        type: 'password',
        required: true,
        placeholder: 'Секретный ключ',
      },
    ],
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    description: 'Высококачественный мультиязычный TTS с большим выбором голосов.',
    supportsVoiceClone: false,
    fields: [
      {
        key: 'apiKey',
        label: 'ElevenLabs API ключ',
        type: 'password',
        required: true,
        placeholder: 'sk_...',
      },
      {
        key: 'voiceId',
        label: 'Голос',
        type: 'select',
        required: false,
        placeholder: 'Загрузка голосов…',
        optionsUrl: '/api/elevenlabs-voices',
        optionsApiKeyField: 'apiKey',
      },
    ],
  },
  {
    id: 'deepgram-tts',
    name: 'DeepGram Aura-2',
    description: 'DeepGram TTS. Не поддерживает русский (автоматически использует Edge TTS).',
    supportsVoiceClone: false,
    fields: [
      {
        key: 'apiKey',
        label: 'DeepGram API ключ',
        type: 'password',
        required: true,
        placeholder: 'Ключ DeepGram',
      },
    ],
  },
];
