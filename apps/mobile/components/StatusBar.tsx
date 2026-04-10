import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { theme } from '../constants/theme';
import { ConnectionStatus, statusMessages } from '../store/player.store';

/**
 * Статус-бар отображает текущее состояние перевода.
 */
interface StatusBarProps {
  status: ConnectionStatus;
  errorMessage?: string;
}

export function StatusIndicator({ status, errorMessage }: StatusBarProps) {
  const message = errorMessage && status === 'error'
    ? errorMessage
    : statusMessages[status];

  const statusColor = {
    idle: theme.colors.textMuted,
    connecting: theme.colors.warning,
    recognizing: theme.colors.warning,
    buffering: theme.colors.warning,
    translating: theme.colors.success,
    error: theme.colors.error,
    finished: theme.colors.textSecondary,
  }[status];

  const showSpinner = status === 'connecting' || status === 'recognizing' || status === 'buffering';

  return (
    <View style={styles.container}>
      <View style={[styles.dot, { backgroundColor: statusColor }]} />
      {showSpinner && (
        <ActivityIndicator size="small" color={statusColor} style={styles.spinner} />
      )}
      <Text style={[styles.text, { color: statusColor }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: theme.spacing.sm,
  },
  spinner: {
    marginRight: theme.spacing.sm,
  },
  text: {
    fontSize: theme.fontSize.sm,
    fontWeight: '500',
  },
});
