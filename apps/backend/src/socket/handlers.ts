import { Server, Socket } from 'socket.io';
import { Orchestrator, TranslationSettings } from '../core/orchestrator';
import { StreamingOrchestrator } from '../core/streaming-orchestrator';

// Хранилище активных оркестраторов по сокет-соединениям
const activeOrchestrators = new Map<string, Orchestrator | StreamingOrchestrator>();

/**
 * Создаёт оркестратор нужного типа и подписывает socket на его события
 */
function createOrchestrator(socket: Socket, settings: TranslationSettings): Orchestrator | StreamingOrchestrator {
  const isStreaming = settings.translationMode === 'streaming';
  const orchestrator = isStreaming
    ? new StreamingOrchestrator()
    : new Orchestrator();

  // Общие события
  orchestrator.on('segment', (segment) => {
    socket.emit('segment', segment);
  });

  orchestrator.on('status', (message: string) => {
    socket.emit('status', { message });
  });

  orchestrator.on('video_url', (url: string) => {
    socket.emit('video_url', { url });
  });

  orchestrator.on('error', (message: string) => {
    socket.emit('error', { message });
  });

  // События стримингового режима
  orchestrator.on('pause_video', () => {
    socket.emit('pause_video');
  });

  orchestrator.on('resume_video', () => {
    socket.emit('resume_video');
  });

  orchestrator.on('provider_info', (info: any) => {
    socket.emit('provider_info', info);
  });

  return orchestrator;
}

/**
 * Настраивает WebSocket обработчики для socket.io сервера
 */
export function setupSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    console.log(`[WebSocket] Клиент подключён: ${socket.id}`);

    // Отладка всех событий (кроме частых playback_time)
    socket.onAny((event, ...args) => {
      if (event === 'playback_time') return;
      console.log(`[WebSocket] Получено событие: "${event}"`, args);
    });

    // Запрос прямого URL видео (без запуска перевода)
    socket.on('get_video_url', async (data: { videoUrl: string }) => {
      console.log(`[WebSocket] Запрос video_url для: ${data.videoUrl}`);
      try {
        const { YouTubeStreamer } = await import('../core/youtube-streamer');
        const streamer = new YouTubeStreamer();
        const directUrl = await streamer.getVideoUrl(data.videoUrl);
        socket.emit('video_url', { url: directUrl });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[WebSocket] Ошибка получения video_url:', msg);
        socket.emit('error', { message: `Не удалось получить видео: ${msg}` });
      }
    });

    // Обработка запроса на начало перевода
    socket.on('start', async (data: {
      videoUrl: string;
      settings: TranslationSettings;
    }) => {
      console.log(`[WebSocket] Запуск перевода для: ${data.videoUrl} (режим: ${data.settings.translationMode || 'free'})`);

      // Останавливаем предыдущий оркестратор, если есть
      const existingOrchestrator = activeOrchestrators.get(socket.id);
      if (existingOrchestrator) {
        await existingOrchestrator.stop();
        activeOrchestrators.delete(socket.id);
      }

      // Создаём оркестратор нужного типа
      const orchestrator = createOrchestrator(socket, data.settings);
      activeOrchestrators.set(socket.id, orchestrator);

      // Запускаем конвейер
      try {
        await orchestrator.start(data.videoUrl, data.settings);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        socket.emit('error', { message: `Ошибка запуска: ${errorMessage}` });
      }
    });

    // Обновление позиции воспроизведения от клиента
    socket.on('playback_time', (data: { time: number }) => {
      const orchestrator = activeOrchestrators.get(socket.id);
      if (orchestrator) {
        orchestrator.setPlaybackTime(data.time);
      }
    });

    // Seek — перемотка, перезапуск pipeline с новой позиции
    socket.on('seek', async (data: { time: number }) => {
      const orchestrator = activeOrchestrators.get(socket.id);
      if (orchestrator && 'seekTo' in orchestrator) {
        console.log(`[WebSocket] Seek → ${data.time.toFixed(1)}s`);
        try {
          await (orchestrator as any).seekTo(data.time);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          socket.emit('error', { message: `Ошибка seek: ${msg}` });
        }
      }
    });

    // Горячее обновление настроек (перезапуск pipeline с новыми провайдерами)
    socket.on('update_settings', async (data: {
      videoUrl: string;
      settings: TranslationSettings;
    }) => {
      console.log(`[WebSocket] Обновление настроек, перезапуск pipeline (режим: ${data.settings.translationMode || 'free'})`);
      const existingOrchestrator = activeOrchestrators.get(socket.id);
      if (existingOrchestrator) {
        await existingOrchestrator.stop();
        activeOrchestrators.delete(socket.id);
      }

      const orchestrator = createOrchestrator(socket, data.settings);
      activeOrchestrators.set(socket.id, orchestrator);

      try {
        await orchestrator.start(data.videoUrl, data.settings);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        socket.emit('error', { message: `Ошибка: ${errorMessage}` });
      }
    });

    // Обработка запроса на остановку
    socket.on('stop', async () => {
      console.log(`[WebSocket] Остановка перевода для: ${socket.id}`);
      const orchestrator = activeOrchestrators.get(socket.id);
      if (orchestrator) {
        await orchestrator.stop();
        activeOrchestrators.delete(socket.id);
      }
    });

    // Обработка отключения клиента
    socket.on('disconnect', async () => {
      console.log(`[WebSocket] Клиент отключён: ${socket.id}`);
      const orchestrator = activeOrchestrators.get(socket.id);
      if (orchestrator) {
        await orchestrator.stop();
        activeOrchestrators.delete(socket.id);
      }
    });
  });

  console.log('[WebSocket] Обработчики настроены');
}

/**
 * Останавливает все активные оркестраторы (для graceful shutdown).
 */
export async function stopAllOrchestrators(): Promise<void> {
  const entries = Array.from(activeOrchestrators.entries());
  if (entries.length === 0) return;
  console.log(`[WebSocket] Остановка ${entries.length} активных оркестраторов...`);
  await Promise.all(entries.map(async ([id, orch]) => {
    try {
      await orch.stop();
    } catch (err) {
      console.error(`[WebSocket] Ошибка остановки оркестратора ${id}:`, err);
    }
  }));
  activeOrchestrators.clear();
  console.log('[WebSocket] Все оркестраторы остановлены');
}
