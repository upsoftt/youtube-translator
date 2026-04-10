import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

/**
 * Панель управления плеером:
 * - Play/Pause
 * - Слайдер громкости оригинала
 * - Слайдер громкости перевода
 */
interface ControlBarProps {
  isPlaying: boolean;
  originalVolume: number;
  translationVolume: number;
  onPlayPause: () => void;
  onOriginalVolumeChange: (value: number) => void;
  onTranslationVolumeChange: (value: number) => void;
}

export function ControlBar({
  isPlaying,
  originalVolume,
  translationVolume,
  onPlayPause,
  onOriginalVolumeChange,
  onTranslationVolumeChange,
}: ControlBarProps) {
  return (
    <View style={styles.container}>
      {/* Кнопка Play/Pause */}
      <TouchableOpacity style={styles.playButton} onPress={onPlayPause}>
        <Ionicons
          name={isPlaying ? 'pause' : 'play'}
          size={28}
          color={theme.colors.text}
        />
      </TouchableOpacity>

      {/* Слайдеры громкости */}
      <View style={styles.slidersContainer}>
        {/* Громкость оригинала */}
        <View style={styles.sliderRow}>
          <Ionicons name="volume-low" size={18} color={theme.colors.textSecondary} />
          <Text style={styles.sliderLabel}>Оригинал</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            value={originalVolume}
            onValueChange={onOriginalVolumeChange}
            minimumTrackTintColor={theme.colors.textSecondary}
            maximumTrackTintColor={theme.colors.inputBorder}
            thumbTintColor={theme.colors.text}
          />
          <Text style={styles.volumeValue}>{Math.round(originalVolume * 100)}%</Text>
        </View>

        {/* Громкость перевода */}
        <View style={styles.sliderRow}>
          <Ionicons name="volume-high" size={18} color={theme.colors.accent} />
          <Text style={styles.sliderLabel}>Перевод</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            value={translationVolume}
            onValueChange={onTranslationVolumeChange}
            minimumTrackTintColor={theme.colors.accent}
            maximumTrackTintColor={theme.colors.inputBorder}
            thumbTintColor={theme.colors.accent}
          />
          <Text style={styles.volumeValue}>{Math.round(translationVolume * 100)}%</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.md,
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  playButton: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.md,
  },
  slidersContainer: {
    flex: 1,
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
  },
  sliderLabel: {
    color: theme.colors.textSecondary,
    fontSize: theme.fontSize.xs,
    width: 60,
    marginLeft: theme.spacing.xs,
  },
  slider: {
    flex: 1,
    height: 30,
  },
  volumeValue: {
    color: theme.colors.textSecondary,
    fontSize: theme.fontSize.xs,
    width: 36,
    textAlign: 'right',
  },
});
