import { TTSProvider, TTSOptions, SpeakerGender } from './tts.interface';
import { EdgeTTSProvider } from './edge-tts.provider';

/**
 * TTS провайдер на основе DeepGram Aura-2.
 *
 * Поддерживаемые языки: en, es, de, fr, nl, it, ja.
 * Для неподдерживаемых языков (ru, zh, ko и др.) автоматически
 * переключается на Edge TTS (fallback).
 */
export class DeepgramTTSProvider implements TTSProvider {
  readonly name = 'deepgram-tts';

  private apiKey = '';
  private language = 'en';
  private fallbackProvider: EdgeTTSProvider | null = null;

  // Языки, поддерживаемые DeepGram Aura-2
  private static readonly supportedLanguages = new Set(['en', 'es', 'de', 'fr', 'nl', 'it', 'ja']);

  // Голоса по языку и полу (Aura-2)
  private static readonly voiceMap: Record<string, { male: string; female: string }> = {
    en: { male: 'aura-2-atlas-en', female: 'aura-2-asteria-en' },
    es: { male: 'aura-2-javier-es', female: 'aura-2-carina-es' },
    de: { male: 'aura-2-julius-de', female: 'aura-2-elara-de' },
    fr: { male: 'aura-2-hector-fr', female: 'aura-2-agathe-fr' },
    nl: { male: 'aura-2-sander-nl', female: 'aura-2-daphne-nl' },
    it: { male: 'aura-2-elio-it', female: 'aura-2-melia-it' },
    ja: { male: 'aura-2-ebisu-ja', female: 'aura-2-uzume-ja' },
  };

  private currentVoiceMale = 'aura-2-atlas-en';
  private currentVoiceFemale = 'aura-2-asteria-en';

  async initialize(options: TTSOptions): Promise<void> {
    this.apiKey = options.apiKey || '';
    if (!this.apiKey) {
      throw new Error('[DeepgramTTS] API ключ обязателен');
    }

    this.language = options.language || 'en';

    // Если язык не поддерживается DeepGram — используем Edge TTS как fallback
    if (!DeepgramTTSProvider.supportedLanguages.has(this.language)) {
      console.log(`[DeepgramTTS] Язык "${this.language}" не поддерживается DeepGram Aura → fallback на Edge TTS`);
      this.fallbackProvider = new EdgeTTSProvider();
      await this.fallbackProvider.initialize({ language: this.language });
      return;
    }

    const voices = DeepgramTTSProvider.voiceMap[this.language] || DeepgramTTSProvider.voiceMap['en'];
    this.currentVoiceMale = voices.male;
    this.currentVoiceFemale = voices.female;

    console.log(`[DeepgramTTS] Инициализирован, язык: ${this.language}, голоса: ${voices.male} / ${voices.female}`);
  }

  async synthesize(text: string, gender?: SpeakerGender): Promise<Buffer> {
    // Если есть fallback — используем его
    if (this.fallbackProvider) {
      return this.fallbackProvider.synthesize(text, gender);
    }

    if (!text || text.trim().length === 0) {
      return Buffer.alloc(0);
    }

    const voice = gender === 'female' ? this.currentVoiceFemale : this.currentVoiceMale;

    try {
      const response = await fetch(
        `https://api.deepgram.com/v1/speak?model=${voice}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[DeepgramTTS] HTTP ошибка ${response.status}: ${errorText}`);
        return Buffer.alloc(0);
      }

      const arrayBuffer = await response.arrayBuffer();
      console.log(`[DeepgramTTS] Синтезировано ${arrayBuffer.byteLength} байт (${voice}): "${text.substring(0, 50)}..."`);
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error('[DeepgramTTS] Ошибка синтеза:', error);
      return Buffer.alloc(0);
    }
  }

  async destroy(): Promise<void> {
    if (this.fallbackProvider) {
      await this.fallbackProvider.destroy();
    }
    console.log('[DeepgramTTS] Завершён');
  }
}
