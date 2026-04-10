/**
 * Тема приложения — тёмная, минималистичная
 */
export const theme = {
  colors: {
    background: '#0A0A0A',
    card: '#1A1A1A',
    cardBorder: '#2A2A2A',
    accent: '#FF4444',
    accentLight: '#FF6666',
    text: '#FFFFFF',
    textSecondary: '#999999',
    textMuted: '#666666',
    inputBackground: '#1A1A1A',
    inputBorder: '#333333',
    success: '#4CAF50',
    warning: '#FF9800',
    error: '#FF4444',
    overlay: 'rgba(0, 0, 0, 0.7)',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  borderRadius: {
    sm: 8,
    md: 12,
    lg: 16,
    full: 9999,
  },
  fontSize: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 18,
    xl: 24,
    xxl: 32,
  },
} as const;
