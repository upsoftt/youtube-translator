import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../constants/theme';

/**
 * Оверлей субтитров — отображает текущий переведённый текст
 * поверх видео (внизу).
 */
interface SubtitleOverlayProps {
  text: string;
}

export function SubtitleOverlay({ text }: SubtitleOverlayProps) {
  if (!text || text.trim().length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.background}>
        <Text style={styles.text}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    alignItems: 'center',
  },
  background: {
    backgroundColor: theme.colors.overlay,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    maxWidth: '90%',
  },
  text: {
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
    textAlign: 'center',
    lineHeight: 22,
  },
});
