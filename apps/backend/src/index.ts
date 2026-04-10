import { execSync } from 'child_process';
import { createConnection } from 'net';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { config } from './config';
import { setupSocketHandlers } from './socket/handlers';

/**
 * Проверяет, занят ли порт, и убивает процесс если да.
 */
async function ensurePortFree(port: number): Promise<void> {
  const isPortBusy = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });

  if (!isPortBusy) return;

  console.log(`[Startup] Порт ${port} занят, убиваю старый процесс...`);
  try {
    // Находим PID и убиваем
    const output = execSync(`netstat -ano | findstr ":${port}" | findstr LISTENING`, { encoding: 'utf-8' });
    const match = output.trim().split(/\s+/).pop();
    if (match) {
      execSync(`taskkill /PID ${match} /F`, { encoding: 'utf-8' });
      console.log(`[Startup] Процесс ${match} убит`);
      // Ждём освобождения порта
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    console.warn(`[Startup] Не удалось убить процесс на порту ${port}:`, e);
  }
}

/**
 * Точка входа бэкенда YouTube Translator.
 * Fastify HTTP сервер + Socket.IO для WebSocket коммуникации.
 */
async function main() {
  // Освобождаем порт если занят
  await ensurePortFree(config.port);

  // Создаём Fastify сервер
  const fastify = Fastify({
    logger: true,
  });

  // Настраиваем CORS
  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST'],
  });

  // Эндпоинт проверки здоровья
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      version: '1.0.0',
      providers: {
        stt: ['whisper', 'deepgram'],
        translation: ['libre', 'openai'],
        tts: ['edge-tts', 'deepgram-tts'],
      },
    };
  });

  // Эндпоинт API-ключей — фронтенд загружает при старте
  fastify.get('/api/keys', async () => {
    return {
      deepgramApiKey: config.deepgramApiKey || '',
      openaiApiKey: config.openaiApiKey || '',
    };
  });

  // Эндпоинт информации о сервере
  fastify.get('/', async () => {
    return {
      name: 'YouTube Translator Backend',
      version: '1.0.0',
      description: 'Бэкенд для синхронного перевода YouTube-видео в реальном времени',
    };
  });

  // Запускаем HTTP сервер
  await fastify.listen({ port: config.port, host: config.host });

  // Создаём Socket.IO сервер поверх Fastify
  const io = new Server(fastify.server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 10 * 1024 * 1024, // 10 МБ для аудио-сегментов
  });

  // Настраиваем WebSocket обработчики
  setupSocketHandlers(io);

  console.log(`
╔══════════════════════════════════════════════════╗
║         YouTube Translator Backend               ║
║                                                  ║
║  HTTP:      http://${config.host}:${config.port}             ║
║  WebSocket: ws://${config.host}:${config.port}               ║
║                                                  ║
║  Провайдеры по умолчанию:                        ║
║    STT:         ${config.defaultSttProvider.padEnd(20)}       ║
║    Translation: ${config.defaultTranslationProvider.padEnd(20)}       ║
║    TTS:         ${config.defaultTtsProvider.padEnd(20)}       ║
╚══════════════════════════════════════════════════╝
  `);
}

// Глобальная обработка необработанных ошибок — не даём серверу упасть
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

main().catch((error) => {
  console.error('Критическая ошибка запуска сервера:', error);
  process.exit(1);
});
