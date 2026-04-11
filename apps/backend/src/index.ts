import { execSync } from 'child_process';
import { createConnection } from 'net';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { Server } from 'socket.io';
import { config } from './config';
import { setupSocketHandlers, stopAllOrchestrators } from './socket/handlers';
import { TTS_PROVIDERS_REGISTRY } from './providers/tts/tts.registry';
import { CosyVoiceTTSProvider } from './providers/tts/cosyvoice-tts.provider';
import { ElevenLabsTTSProvider } from './providers/tts/elevenlabs-tts.provider';

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

  // Rate limiting — защита от злоупотреблений
  await fastify.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
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

  // Список всех доступных TTS-провайдеров с метаданными для UI расширения
  fastify.get('/api/tts-providers', async () => {
    return { providers: TTS_PROVIDERS_REGISTRY };
  });

  // Тест соединения с конкретным TTS-провайдером
  fastify.post<{
    Body: { providerId: string; config: Record<string, string> };
  }>('/api/test-tts', async (req, reply) => {
    const { providerId, config: cfg } = req.body;

    try {
      if (providerId === 'edge-tts') {
        return { ok: true, message: 'Edge TTS всегда доступен (бесплатный)' };
      }

      if (providerId === 'cosyvoice') {
        const provider = new CosyVoiceTTSProvider();
        await provider.initialize({
          serverUrl: cfg.serverUrl || config.cosyvoiceUrl,
          apiKey:    cfg.apiKey    || config.cosyvoiceApiKey,
          language:  'ru',
        });
        await provider.destroy();
        return { ok: true, message: 'CosyVoice сервер доступен' };
      }

      const withTimeout = (ms: number) => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), ms);
        return ac.signal;
      };

      if (providerId === 'openai-tts') {
        const key = cfg.apiKey || config.openaiApiKey;
        if (!key) return reply.status(400).send({ ok: false, message: 'API ключ не указан' });
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: withTimeout(5000),
        });
        if (!res.ok) return reply.status(400).send({ ok: false, message: `OpenAI: HTTP ${res.status}` });
        return { ok: true, message: 'OpenAI API ключ валиден' };
      }

      if (providerId === 'deepgram-tts') {
        const key = cfg.apiKey || config.deepgramApiKey;
        if (!key) return reply.status(400).send({ ok: false, message: 'API ключ не указан' });
        const res = await fetch('https://api.deepgram.com/v1/projects', {
          headers: { 'Authorization': `Token ${key}` },
          signal: withTimeout(5000),
        });
        if (!res.ok) return reply.status(400).send({ ok: false, message: `DeepGram: HTTP ${res.status}` });
        return { ok: true, message: 'DeepGram API ключ валиден' };
      }

      if (providerId === 'elevenlabs') {
        const key = cfg.apiKey;
        if (!key) return reply.status(400).send({ ok: false, message: 'API ключ не указан' });
        const voices = await ElevenLabsTTSProvider.fetchVoices(key);
        return { ok: true, message: `ElevenLabs OK, ${voices.length} голосов доступно` };
      }

      return reply.status(400).send({ ok: false, message: `Неизвестный провайдер: ${providerId}` });

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ ok: false, message: msg });
    }
  });

  // Список голосов ElevenLabs (для выпадающего списка в UI)
  fastify.post<{
    Body: { apiKey: string };
  }>('/api/elevenlabs-voices', async (req, reply) => {
    const { apiKey } = req.body;
    if (!apiKey) return reply.status(400).send({ error: 'API ключ не указан' });

    try {
      const voices = await ElevenLabsTTSProvider.fetchVoices(apiKey);
      return voices.map(v => ({ value: v.voice_id, label: `${v.name} (${v.category})` }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: msg });
    }
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

// Graceful shutdown
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} получен, завершение...`);
  try {
    await stopAllOrchestrators();
  } catch (err) {
    console.error('[Shutdown] Ошибка остановки оркестраторов:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
