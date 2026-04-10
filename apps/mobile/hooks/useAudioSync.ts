import { useEffect, useRef, useCallback } from 'react';
import { audioQueueService } from '../services/audio-queue.service';
import { usePlayerStore } from '../store/player.store';
import { useSettingsStore } from '../store/settings.store';

/**
 * Хук синхронизации аудио перевода с видео.
 * При паузе видео — пауза перевода. При resume — продолжение.
 */
export function useAudioSync() {
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const setCurrentSubtitle = usePlayerStore(state => state.setCurrentSubtitle);
  const translationVolume = useSettingsStore(state => state.translationVolume);
  const prevIsPlaying = useRef(isPlaying);

  // Callback субтитров — при начале воспроизведения сегмента
  useEffect(() => {
    audioQueueService.setSubtitleCallback((text: string) => {
      usePlayerStore.getState().setCurrentSubtitle(text);
    });
  }, []);

  useEffect(() => {
    audioQueueService.setVolume(translationVolume);
  }, [translationVolume]);

  // Пауза/resume при изменении состояния воспроизведения видео
  useEffect(() => {
    if (prevIsPlaying.current && !isPlaying) {
      // Видео поставлено на паузу → пауза перевода
      audioQueueService.pause();
    } else if (!prevIsPlaying.current && isPlaying) {
      // Видео возобновлено → resume перевода
      audioQueueService.resume();
    }
    prevIsPlaying.current = isPlaying;
  }, [isPlaying]);

  const reset = useCallback(async () => {
    await audioQueueService.clear();
    setCurrentSubtitle('');
  }, [setCurrentSubtitle]);

  return { reset };
}
