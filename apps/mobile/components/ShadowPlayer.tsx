import React, { useRef, useEffect } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { usePlayerStore } from '../store/player.store';
import { useSettingsStore } from '../store/settings.store';

interface ShadowPlayerProps {
  videoId: string;
  onPlaybackStatusUpdate?: (isPlaying: boolean, positionSeconds: number) => void;
  onSeek?: (positionSeconds: number) => void;
}

/**
 * На Web: YouTube IFrame embed (работает без CORS).
 * На Native: expo-av Video с прямым URL.
 */
export function ShadowPlayer({ videoId, onPlaybackStatusUpdate, onSeek }: ShadowPlayerProps) {
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const setIsPlaying = usePlayerStore(state => state.setIsPlaying);
  const setCurrentTime = usePlayerStore(state => state.setCurrentTime);
  const setPlaybackRate = usePlayerStore(state => state.setPlaybackRate);
  const originalVolume = useSettingsStore(state => state.originalVolume);

  const playerRef = useRef<any>(null);
  const playerReadyRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTimeRef = useRef(0);
  const seekCooldownRef = useRef(false);
  const stateRef = useRef({ isPlaying, onPlaybackStatusUpdate, onSeek, originalVolume });

  useEffect(() => {
    stateRef.current = { isPlaying, onPlaybackStatusUpdate, onSeek, originalVolume };
  }, [isPlaying, onPlaybackStatusUpdate, onSeek, originalVolume]);

  // YouTube IFrame API для Web
  useEffect(() => {
    if (Platform.OS !== 'web' || !videoId) return;

    playerReadyRef.current = false;

    // Загружаем YouTube IFrame API если ещё нет
    if (!(window as any).YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }

    const initPlayer = () => {
      // Защита от двойного вызова
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch {}
        playerRef.current = null;
      }

      const container = document.getElementById('yt-player');
      if (!container) {
        console.error('[ShadowPlayer] div#yt-player не найден в DOM');
        return;
      }

      playerRef.current = new (window as any).YT.Player('yt-player', {
        videoId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: (event: any) => {
            console.log('[ShadowPlayer] Player ready');
            playerReadyRef.current = true;
            event.target.setVolume(stateRef.current.originalVolume * 100);
            setIsPlaying(true);
          },
          onStateChange: (event: any) => {
            const YT = (window as any).YT;
            const playing = event.data === YT.PlayerState.PLAYING;
            setIsPlaying(playing);
          },
          onPlaybackRateChange: (event: any) => {
            console.log(`[ShadowPlayer] Playback rate: ${event.data}x`);
            setPlaybackRate(event.data);
          },
        },
      });

      // Опрашиваем текущее время и детектируем seek
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        if (!playerRef.current?.getCurrentTime || !playerReadyRef.current) return;

        const time = playerRef.current.getCurrentTime();
        const playing = playerRef.current.getPlayerState() === (window as any).YT.PlayerState.PLAYING;

        // Детекция seek: скачок больше 1.5с, только во время воспроизведения
        const delta = Math.abs(time - lastTimeRef.current);
        if (lastTimeRef.current > 0 && delta > 1.5 && playing && !seekCooldownRef.current) {
          console.log(`[ShadowPlayer] Seek detected: ${lastTimeRef.current.toFixed(1)}s → ${time.toFixed(1)}s`);
          stateRef.current.onSeek?.(time);
          // Cooldown 1с после детекции seek — защита от двойного срабатывания
          seekCooldownRef.current = true;
          setTimeout(() => { seekCooldownRef.current = false; }, 1000);
        }
        lastTimeRef.current = time;

        setCurrentTime(time);
        stateRef.current.onPlaybackStatusUpdate?.(playing, time);
      }, 250);
    };

    // Обрабатываем все варианты загрузки YouTube API
    if ((window as any).YT?.Player) {
      initPlayer();
    } else {
      (window as any).onYouTubeIframeAPIReady = initPlayer;
      // Fallback polling на случай race condition с callback
      const checkInterval = setInterval(() => {
        if ((window as any).YT?.Player) {
          clearInterval(checkInterval);
          if (!playerRef.current) initPlayer();
        }
      }, 200);
      setTimeout(() => clearInterval(checkInterval), 10000);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      playerReadyRef.current = false;
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch {}
        playerRef.current = null;
      }
    };
  }, [videoId]);

  // Управление громкостью
  useEffect(() => {
    if (Platform.OS === 'web' && playerReadyRef.current && playerRef.current?.setVolume) {
      playerRef.current.setVolume(originalVolume * 100);
    }
  }, [originalVolume]);

  // Play/Pause — только когда плеер готов (не мешаем autoplay при инициализации)
  useEffect(() => {
    if (Platform.OS === 'web' && playerReadyRef.current && playerRef.current) {
      if (isPlaying) {
        playerRef.current.playVideo?.();
      } else {
        playerRef.current.pauseVideo?.();
      }
    }
  }, [isPlaying]);

  if (!videoId) {
    return <View style={styles.placeholder} />;
  }

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <div id="yt-player" style={{ width: '100%', height: '100%' }} />
      </View>
    );
  }

  // Native — fallback на expo-av (потребует videoUrl)
  return <View style={styles.placeholder} />;
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  placeholder: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
});
