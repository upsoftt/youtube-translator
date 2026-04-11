import { TTSProvider, TTSOptions, SpeakerGender } from './tts.interface';

/**
 * TTS провайдер ElevenLabs.
 * HTTP API: POST /v1/text-to-speech/{voice_id}
 * Заголовок: xi-api-key
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = 'ElevenLabs';

  private apiKey = '';
  private voiceId = '';
  private language = 'ru';

  async initialize(options: TTSOptions): Promise<void> {
    this.apiKey = options.apiKey || '';
    this.language = options.language || 'ru';
    // voice — ID голоса из ElevenLabs (выбирается в UI)
    this.voiceId = options.voice || '';

    if (!this.apiKey) {
      throw new Error('[ElevenLabs] API key не указан');
    }

    // Если голос не выбран, берём первый доступный
    if (!this.voiceId) {
      const voices = await ElevenLabsTTSProvider.fetchVoices(this.apiKey);
      if (voices.length > 0) {
        this.voiceId = voices[0].voice_id;
        console.log(`[ElevenLabs] Голос по умолчанию: ${voices[0].name} (${this.voiceId})`);
      } else {
        throw new Error('[ElevenLabs] Нет доступных голосов');
      }
    }

    console.log(`[ElevenLabs] Инициализирован, голос: ${this.voiceId}, язык: ${this.language}`);
  }

  async synthesize(text: string, _gender?: SpeakerGender): Promise<Buffer> {
    if (!text.trim()) return Buffer.alloc(0);

    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[ElevenLabs] Ошибка API ${response.status}: ${errorText.slice(0, 200)}`);
        return Buffer.alloc(0);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      console.log(`[ElevenLabs] Синтезировано ${buffer.length} байт: "${text.substring(0, 50)}"`);
      return buffer;
    } catch (error) {
      console.error(`[ElevenLabs] Ошибка синтеза:`, error);
      return Buffer.alloc(0);
    }
  }

  async destroy(): Promise<void> {
    // HTTP-based — нечего очищать
  }

  /** Получает список голосов через API */
  static async fetchVoices(apiKey: string): Promise<Array<{ voice_id: string; name: string; category: string }>> {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API ${response.status}`);
    }

    const data = await response.json() as { voices: Array<{ voice_id: string; name: string; category: string }> };
    return (data.voices || []).map(v => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category || 'unknown',
    }));
  }
}
