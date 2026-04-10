import { io, Socket } from 'socket.io-client';

/**
 * Сервис WebSocket соединения с бэкендом.
 * Singleton-инстанс для управления подключением.
 */
class SocketService {
  private socket: Socket | null = null;
  private serverUrl = 'http://localhost:3100';

  /**
   * Подключается к бэкенду
   */
  connect(url: string): Socket {
    this.serverUrl = url;

    if (this.socket?.connected) {
      this.socket.disconnect();
    }

    this.socket = io(this.serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    this.socket.on('connect', () => {
      console.log('[Socket] Подключено к серверу');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Отключено:', reason);
    });

    this.socket.on('connect_error', (error) => {
      console.error('[Socket] Ошибка подключения:', error.message);
    });

    return this.socket;
  }

  /**
   * Возвращает текущий сокет
   */
  getSocket(): Socket | null {
    return this.socket;
  }

  /**
   * Отправляет запрос на начало перевода
   */
  startTranslation(videoUrl: string, settings: {
    targetLanguage: string;
    sttProvider: string;
    translationProvider: string;
    ttsProvider: string;
    translationMode?: string;
    preferSubtitles?: boolean;
    seekTime?: number;
    apiKeys: {
      deepgram?: string;
      openai?: string;
    };
  }): void {
    if (!this.socket?.connected) {
      console.error('[Socket] Не подключён к серверу');
      return;
    }

    this.socket.emit('start', { videoUrl, settings });
  }

  /**
   * Отправляет текущую позицию воспроизведения на сервер
   */
  sendPlaybackTime(positionSec: number): void {
    this.socket?.emit('playback_time', { time: positionSec });
  }

  /**
   * Отправляет обновлённые настройки (горячее переключение провайдеров)
   */
  updateSettings(videoUrl: string, settings: {
    targetLanguage: string;
    sttProvider: string;
    translationProvider: string;
    ttsProvider: string;
    translationMode?: string;
    apiKeys: {
      deepgram?: string;
      openai?: string;
    };
  }): void {
    if (!this.socket?.connected) {
      console.log('[Socket] updateSettings: не подключён');
      return;
    }
    console.log('[Socket] updateSettings:', { videoUrl, settings });
    this.socket.emit('update_settings', { videoUrl, settings });
  }

  /**
   * Отправляет запрос на seek (перемотку)
   */
  seek(timeSec: number): void {
    this.socket?.emit('seek', { time: timeSec });
  }

  /**
   * Запрашивает прямой URL видео (без запуска перевода)
   */
  requestVideoUrl(videoUrl: string): void {
    if (!this.socket?.connected) {
      console.error('[Socket] requestVideoUrl: не подключён');
      return;
    }
    this.socket.emit('get_video_url', { videoUrl });
  }

  /**
   * Отправляет запрос на остановку перевода
   */
  stopTranslation(): void {
    this.socket?.emit('stop');
  }

  /**
   * Отключается от сервера
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

export const socketService = new SocketService();
