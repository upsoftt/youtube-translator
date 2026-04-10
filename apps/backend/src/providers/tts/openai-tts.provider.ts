import { TTSProvider, TTSOptions, SpeakerGender } from './tts.interface';

/**
 * TTS провайдер на основе OpenAI API.
 * HTTP-based — один запрос к /v1/audio/speech, без Python subprocess.
 * Поддерживает все языки включая русский.
 */
export class OpenAITTSProvider implements TTSProvider {
  readonly name = 'OpenAI TTS';

  private apiKey = '';
  private language = 'en';

  // Голоса по полу и языку
  private static readonly voiceMap: Record<string, { male: string; female: string }> = {
    ru: { male: 'alloy', female: 'nova' },
    zh: { male: 'alloy', female: 'nova' },
    ko: { male: 'alloy', female: 'nova' },
    default: { male: 'echo', female: 'shimmer' },
  };

  async initialize(options: TTSOptions): Promise<void> {
    this.apiKey = options.apiKey || '';
    this.language = options.language || 'en';

    if (!this.apiKey) {
      throw new Error('[OpenAITTS] API key не указан');
    }

    console.log(`[OpenAITTS] Инициализирован для языка: ${this.language}`);
  }

  async synthesize(text: string, gender?: SpeakerGender): Promise<Buffer> {
    if (!text.trim()) return Buffer.alloc(0);

    const voiceEntry = OpenAITTSProvider.voiceMap[this.language] || OpenAITTSProvider.voiceMap.default;
    const voice = gender === 'female' ? voiceEntry.female : voiceEntry.male;

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          voice,
          input: text,
          response_format: 'mp3',
          speed: 1.0,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[OpenAITTS] Ошибка API ${response.status}: ${errorText.slice(0, 200)}`);
        return Buffer.alloc(0);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      console.log(`[OpenAITTS] Синтезировано ${buffer.length} байт (${voice}): "${text.substring(0, 50)}"`);
      return buffer;
    } catch (error) {
      console.error(`[OpenAITTS] Ошибка синтеза:`, error);
      return Buffer.alloc(0);
    }
  }

  async destroy(): Promise<void> {
    // HTTP-based — нечего очищать
  }
}
