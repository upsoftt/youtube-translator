import { useEffect, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { socketService } from '../services/socket.service';
import { audioQueueService } from '../services/audio-queue.service';
import { usePlayerStore, TranslationSegment, ConnectionStatus } from '../store/player.store';
import { useSettingsStore } from '../store/settings.store';

/**
 * Хук для управления WebSocket соединением с бэкендом.
 */
export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  
  // Получаем экшены стора один раз (они стабильны в Zustand)
  const setStatus = usePlayerStore(state => state.setStatus);
  const setVideoUrl = usePlayerStore(state => state.setVideoUrl);
  const addSegment = usePlayerStore(state => state.addSegment);
  const setErrorMessage = usePlayerStore(state => state.setErrorMessage);
  const backendUrl = useSettingsStore(state => state.backendUrl);

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return socketRef.current;

    const socket = socketService.connect(backendUrl);
    socketRef.current = socket;

    socket.on('segment', (data: TranslationSegment) => {
      addSegment(data);
      audioQueueService.enqueue(data);
      // Субтитры обновляются через audioQueueService.setSubtitleCallback
      // когда сегмент реально начинает воспроизводиться
    });

    socket.on('status', (data: { message: string }) => {
      const statusMap: Record<string, ConnectionStatus> = {
        'Инициализация провайдеров...': 'connecting',
        'Получение ссылки на видео...': 'connecting',
        'Запуск распознавания...': 'recognizing',
        'Перевод активен': 'translating',
      };
      const mapped = statusMap[data.message];
      if (mapped) {
        setStatus(mapped);
      } else {
        console.log(`[useSocket] Неизвестный статус: "${data.message}", игнорируем`);
      }
    });

    socket.on('video_url', (data: { url: string }) => {
      setVideoUrl(data.url);
    });

    socket.on('error', (data: { message: string }) => {
      setErrorMessage(data.message);
    });

    socket.on('provider_info', (data: { stt: string; translation: string; tts: string }) => {
      console.log('[useSocket] Провайдеры:', data);
      usePlayerStore.getState().setProviderInfo(data);
    });

    socket.on('pause_video', () => {
      console.log('[Socket] Сервер: pause_video');
      usePlayerStore.getState().setAutoPause(true);
      usePlayerStore.getState().setIsPlaying(false);
      setStatus('buffering');
    });

    socket.on('resume_video', () => {
      console.log('[Socket] Сервер: resume_video');
      usePlayerStore.getState().setAutoPause(false);
      usePlayerStore.getState().setIsPlaying(true);
      setStatus('translating');
    });

    socket.on('connect', () => {
      console.log('[useSocket] Сокет подключён, статус не меняем (ждём startTranslation)');
    });

    socket.on('disconnect', () => {
      const currentStatus = usePlayerStore.getState().status;
      if (currentStatus !== 'idle') {
        console.warn('[useSocket] Соединение потеряно во время активной трансляции');
        audioQueueService.clear();
        setStatus('idle');
      }
    });

    socket.io.on('reconnect', () => {
      const currentStatus = usePlayerStore.getState().status;
      console.log(`[useSocket] Соединение восстановлено (статус был: ${currentStatus})`);
      // Если перевод был активен — сообщаем пользователю
      if (currentStatus === 'translating' || currentStatus === 'recognizing' || currentStatus === 'buffering') {
        setStatus('idle');
        setErrorMessage('Соединение восстановлено. Включите перевод заново.');
      }
    });

    return socket;
  }, [backendUrl, setStatus, setVideoUrl, addSegment, setErrorMessage]);

  const startTranslation = useCallback((videoUrl: string, seekTime?: number) => {
    const settings = useSettingsStore.getState();
    socketService.startTranslation(videoUrl, {
      targetLanguage: settings.targetLanguage,
      sttProvider: settings.sttProvider,
      translationProvider: settings.translationProvider,
      ttsProvider: settings.ttsProvider,
      translationMode: settings.translationMode,
      preferSubtitles: settings.preferSubtitles,
      seekTime,
      apiKeys: {
        deepgram: settings.deepgramApiKey || undefined,
        openai: settings.openaiApiKey || undefined,
      },
    });
    setStatus('buffering');
  }, [setStatus]);

  const requestVideoUrl = useCallback((videoUrl: string) => {
    socketService.requestVideoUrl(videoUrl);
  }, []);

  const seek = useCallback((timeSec: number) => {
    socketService.seek(timeSec);
  }, []);

  const sendPlaybackTime = useCallback((positionSec: number) => {
    socketService.sendPlaybackTime(positionSec);
  }, []);

  const updateSettings = useCallback((videoUrl: string) => {
    const settings = useSettingsStore.getState();
    socketService.updateSettings(videoUrl, {
      targetLanguage: settings.targetLanguage,
      sttProvider: settings.sttProvider,
      translationProvider: settings.translationProvider,
      ttsProvider: settings.ttsProvider,
      apiKeys: {
        deepgram: settings.deepgramApiKey || undefined,
        openai: settings.openaiApiKey || undefined,
      },
    });
    setStatus('connecting');
  }, [setStatus]);

  const stopTranslation = useCallback(async () => {
    socketService.stopTranslation();
    await audioQueueService.clear();
    setStatus('idle');
  }, [setStatus]);

  const disconnect = useCallback(async () => {
    await audioQueueService.clear();
    socketService.disconnect();
    socketRef.current = null;
  }, []);

  return { connect, startTranslation, stopTranslation, disconnect, sendPlaybackTime, updateSettings, requestVideoUrl, seek };
}
