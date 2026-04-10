import React, { useEffect, useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch, Dimensions, Platform, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ShadowPlayer } from '../../components/ShadowPlayer';
import { SubtitleOverlay } from '../../components/SubtitleOverlay';
import { ProviderSelector } from '../../components/ProviderSelector';
import { useSocket } from '../../hooks/useSocket';
import { useAudioSync } from '../../hooks/useAudioSync';
import { usePlayerStore } from '../../store/player.store';
import { useSettingsStore } from '../../store/settings.store';
import { statusMessages } from '../../store/player.store';
import { theme } from '../../constants/theme';
import { audioQueueService } from '../../services/audio-queue.service';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

/**
 * Кликабельный слайдер громкости — нажатие/перетаскивание по полосе задаёт значение.
 */
function VolumeSlider({ label, value, onChange, accentColor = '#fff' }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  accentColor?: string;
}) {
  const trackRef = React.useRef<View>(null);
  const trackLayout = React.useRef({ x: 0, width: 0 });

  const calcVolume = (pageX: number) => {
    const { x, width } = trackLayout.current;
    if (width > 0) {
      const ratio = Math.max(0, Math.min(1, (pageX - x) / width));
      onChange(Math.round(ratio * 20) / 20); // шаг 5%
    }
  };

  const measureTrack = () => {
    trackRef.current?.measureInWindow((x, _y, width) => {
      if (width > 0) trackLayout.current = { x, width };
    });
  };

  const pct = Math.round((value || 0) * 100);

  return (
    <View style={styles.controlItem}>
      <Text style={styles.controlLabel}>{label}: {pct}%</Text>
      <View
        style={styles.sliderHitArea}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => { measureTrack(); calcVolume(e.nativeEvent.pageX); }}
        onResponderMove={(e) => calcVolume(e.nativeEvent.pageX)}
      >
        <View ref={trackRef} style={styles.sliderTrack} onLayout={measureTrack}>
          <View style={[styles.sliderFill, { width: `${pct}%`, backgroundColor: accentColor }]} />
        </View>
      </View>
    </View>
  );
}

/**
 * Иконка перевода 文A
 */
function TranslateIcon({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  if (Platform.OS === 'web') {
    return (
      <Text style={{ fontSize: size, color, fontWeight: '700', lineHeight: size + 4 }}>
        文A
      </Text>
    );
  }
  return <Ionicons name="language-outline" size={size} color={color} />;
}

/**
 * Экран плеера — полноэкранное видео с пультом управления в углу.
 */
export default function PlayerScreen() {
  const params = useLocalSearchParams<{ id: string; url: string }>();
  const router = useRouter();
  const videoId = params.id;
  const url = params.url && !/^https?:\/\//i.test(params.url) ? `https://${params.url}` : params.url;
  const { connect, startTranslation, stopTranslation, disconnect, sendPlaybackTime, updateSettings, seek } = useSocket();

  const { reset: resetAudio } = useAudioSync();
  const lastSentTimeRef = React.useRef(0);
  const [showSettings, setShowSettings] = useState(false);
  const connectedRef = React.useRef(false);

  const status = usePlayerStore(state => state.status);
  const currentSubtitle = usePlayerStore(state => state.currentSubtitle);
  const resetPlayer = usePlayerStore(state => state.reset);

  const originalVolume = useSettingsStore(state => state.originalVolume);
  const translationVolume = useSettingsStore(state => state.translationVolume);
  const setOriginalVolume = useSettingsStore(state => state.setOriginalVolume);
  const setTranslationVolume = useSettingsStore(state => state.setTranslationVolume);

  const isTranslationActive = status === 'translating' || status === 'recognizing' || status === 'connecting' || status === 'buffering';

  useEffect(() => {
    if (connectedRef.current) return;
    connectedRef.current = true;
    connect();

    return () => {
      connectedRef.current = false;
      disconnect();
      resetPlayer();
      resetAudio();
    };
  }, []);

  const pauseForBuffering = React.useCallback(() => {
    usePlayerStore.getState().setIsPlaying(false);
    usePlayerStore.getState().setStatus('buffering');
    audioQueueService.clear();
  }, []);

  const handleSeek = React.useCallback((timeSec: number) => {
    if (isTranslationActive || status === 'buffering') {
      pauseForBuffering();
      seek(timeSec);
    }
  }, [isTranslationActive, status, seek, pauseForBuffering]);

  const toggleTranslation = () => {
    if (isTranslationActive) {
      stopTranslation();
      usePlayerStore.getState().setIsPlaying(true);
    } else if (url) {
      const currentTime = usePlayerStore.getState().currentTime;
      pauseForBuffering();
      startTranslation(url, currentTime > 1 ? currentTime : undefined);
    }
  };

  const statusText = statusMessages[status] || status;

  return (
    <View style={styles.container}>
      {/* 1. ВИДЕО ФОНОМ */}
      <View style={styles.backgroundVideo}>
        <ShadowPlayer
          videoId={videoId}
          onSeek={handleSeek}
          onPlaybackStatusUpdate={(isPlaying, positionSec) => {
            if (Math.abs(positionSec - lastSentTimeRef.current) >= 2) {
              lastSentTimeRef.current = positionSec;
              sendPlaybackTime(positionSec);
            }
          }}
        />

        <View style={styles.subtitleWrapper}>
          <SubtitleOverlay text={currentSubtitle} />
        </View>
      </View>

      {/* 2. ИНДИКАТОР БУФЕРИЗАЦИИ */}
      {status === 'buffering' && (
        <View style={styles.bufferingOverlay}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
          <Text style={styles.bufferingText}>Подготовка перевода...</Text>
        </View>
      )}

      {/* 3. ПАНЕЛЬ УПРАВЛЕНИЯ */}
      <View style={styles.controlOverlay}>
        {/* Развёрнутые настройки */}
        {showSettings && (
          <View style={styles.glassPanel}>
            {/* ТУМБЛЕР ПЕРЕВОДА */}
            <View style={styles.headerRow}>
              <View>
                <Text style={styles.headerTitle}>Синхронный перевод</Text>
                <Text style={[styles.statusBadge, { color: isTranslationActive ? theme.colors.accent : '#666' }]}>
                  ● {statusText}
                </Text>
              </View>
              <Switch
                value={isTranslationActive}
                onValueChange={toggleTranslation}
                trackColor={{ false: '#333', true: theme.colors.accent }}
                thumbColor="#fff"
              />
            </View>

            <View style={styles.separator} />

            <ProviderSelector onProviderChange={() => {
              const s = usePlayerStore.getState().status;
              if (url && (s === 'translating' || s === 'recognizing' || s === 'connecting' || s === 'buffering')) {
                stopTranslation();
                setTimeout(() => startTranslation(url), 500);
              }
            }} />

            <View style={styles.separator} />

            <VolumeSlider
              label="Громкость оригинала"
              value={originalVolume}
              onChange={setOriginalVolume}
            />

            <VolumeSlider
              label="Громкость перевода"
              value={translationVolume}
              onChange={setTranslationVolume}
              accentColor={theme.colors.accent}
            />
          </View>
        )}

        {/* Кнопки управления */}
        <View style={styles.buttonRow}>
          {/* Кнопка перевода 文A */}
          <TouchableOpacity
            style={[
              styles.translateButton,
              isTranslationActive && styles.translateButtonActive,
            ]}
            onPress={toggleTranslation}
            activeOpacity={0.7}
          >
            <TranslateIcon
              size={18}
              color={isTranslationActive ? '#fff' : '#aaa'}
            />
            {isTranslationActive && (
              <View style={styles.activeIndicator} />
            )}
          </TouchableOpacity>

          {/* Кнопка настроек */}
          <TouchableOpacity
            style={[
              styles.settingsButton,
              showSettings && styles.settingsButtonActive,
            ]}
            onPress={() => setShowSettings(!showSettings)}
            activeOpacity={0.7}
          >
            <Ionicons
              name="settings-outline"
              size={20}
              color={showSettings ? '#fff' : '#aaa'}
            />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  backgroundVideo: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 1,
  },
  subtitleWrapper: {
    position: 'absolute',
    bottom: '15%',
    width: '100%',
    alignItems: 'center',
    zIndex: 50,
  },
  controlOverlay: {
    position: 'absolute',
    bottom: 40,
    right: 40,
    width: 360,
    zIndex: 100,
    alignItems: 'flex-end',
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  translateButton: {
    width: 48,
    height: 48,
    backgroundColor: 'rgba(15,15,15,0.9)',
    borderRadius: 14,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    position: 'relative' as const,
    ...Platform.select({
      web: { boxShadow: '0 8px 32px rgba(0,0,0,0.4)', cursor: 'pointer' }
    }),
  },
  translateButtonActive: {
    backgroundColor: 'rgba(255,68,68,0.25)',
    borderColor: theme.colors.accent,
  },
  activeIndicator: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.colors.accent,
  },
  settingsButton: {
    width: 48,
    height: 48,
    backgroundColor: 'rgba(15,15,15,0.9)',
    borderRadius: 14,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    ...Platform.select({
      web: { boxShadow: '0 8px 32px rgba(0,0,0,0.4)', cursor: 'pointer' }
    }),
  },
  settingsButtonActive: {
    borderColor: 'rgba(255,255,255,0.3)',
    backgroundColor: 'rgba(30,30,30,0.95)',
  },
  glassPanel: {
    width: '100%',
    backgroundColor: 'rgba(10,10,10,0.96)',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    ...Platform.select({
      web: { boxShadow: '0 12px 48px rgba(0,0,0,0.6)' }
    }),
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: '800',
    marginTop: 4,
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginVertical: 20,
  },
  controlItem: {
    marginBottom: 18,
  },
  controlLabel: {
    color: '#777',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  sliderHitArea: {
    paddingVertical: 12,
    marginVertical: -4,
    cursor: 'pointer' as any,
  },
  sliderTrack: {
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 4,
    overflow: 'hidden' as const,
  },
  sliderFill: {
    height: '100%',
    borderRadius: 4,
  },
  bufferingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    zIndex: 200,
  },
  bufferingText: {
    color: '#fff',
    marginTop: 16,
    fontSize: 16,
    fontWeight: '600' as const,
  }
});
