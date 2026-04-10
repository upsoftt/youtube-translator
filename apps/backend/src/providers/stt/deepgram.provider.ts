import WebSocket from 'ws';
import { STTProvider, STTProviderOptions, STTSegment } from './stt.interface';

/**
 * Платный STT провайдер на основе DeepGram Streaming API.
 * Использует прямой WebSocket (ws) вместо SDK для надёжности.
 */
export class DeepgramSTTProvider implements STTProvider {
  readonly name = 'deepgram';

  private apiKey = '';
  private language = 'en';
  private ws: WebSocket | null = null;
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

    this.readyPromise = new Promise(resolve => {
      this.readyResolve = resolve;
    });

    const params = new URLSearchParams({
      model: 'nova-2',
      language: this.language,
      smart_format: 'true',
      endpointing: '300',
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    this.ws = new WebSocket(url, {
      headers: {
        'Authorization': `Token ${this.apiKey}`,
      },
    });

    this.ws.on('open', () => {
      console.log('[DeepgramSTT] WebSocket открыт');
      this.isReady = true;
      this.readyResolve?.();
      // Отправляем накопленные чанки
      for (const chunk of this.pendingChunks) {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(chunk);
        }
      }
      this.pendingChunks = [];
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const data = JSON.parse(raw.toString());

        // Пропускаем неречевые сообщения
        if (data.type !== 'Results') return;

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
      } catch (e) {
        // Игнорируем не-JSON сообщения
      }
    });

    this.ws.on('error', (error: Error) => {
      console.error('[DeepgramSTT] Ошибка WebSocket:', error.message);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(`[DeepgramSTT] WebSocket закрыт: ${code} ${reason?.toString()}`);
      this.isReady = false;
    });

    console.log(`[DeepgramSTT] Инициализирован, язык: ${this.language}`);
  }

  /** Ждёт готовности WebSocket */
  async waitReady(): Promise<void> {
    if (this.isReady) return;
    await this.readyPromise;
  }

  async processChunk(audioChunk: Buffer, onSegment: (segment: STTSegment) => void): Promise<void> {
    this.onSegmentCallback = onSegment as (segment: STTSegment) => Promise<void>;

    if (this.isReady && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(audioChunk);
    } else {
      this.pendingChunks.push(audioChunk);
    }
  }

  async destroy(): Promise<void> {
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          // Отправляем пустой буфер для graceful close
          this.ws.send(Buffer.alloc(0));
          this.ws.close();
        }
      } catch {}
      this.ws = null;
    }
    this.onSegmentCallback = null;
    this.isReady = false;
    this.pendingChunks = [];
    console.log('[DeepgramSTT] Завершён');
  }
}
