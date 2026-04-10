import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

/**
 * Главный экран — ввод YouTube URL и запуск перевода.
 */
export default function HomeScreen() {
  const router = useRouter();
  const [url, setUrl] = useState('');

  /**
   * Извлекает ID видео из YouTube URL
   */
  const extractVideoId = (inputUrl: string): string | null => {
    const patterns = [
      /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
      /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
      const match = inputUrl.match(pattern);
      if (match) return match[1];
    }

    return null;
  };

  /**
   * Обрабатывает нажатие кнопки "Смотреть с переводом"
   */
  const handleStart = () => {
    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      if (Platform.OS === 'web') {
        window.alert('Введите ссылку на YouTube видео');
      } else {
        Alert.alert('Ошибка', 'Введите ссылку на YouTube видео');
      }
      return;
    }

    // Нормализуем URL — добавляем https:// если нет протокола
    const normalizedUrl = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;

    const videoId = extractVideoId(normalizedUrl);
    if (!videoId) {
      if (Platform.OS === 'web') {
        window.alert('Некорректная ссылка на YouTube видео');
      } else {
        Alert.alert('Ошибка', 'Некорректная ссылка на YouTube видео');
      }
      return;
    }

    // Переходим на экран плеера, передавая URL как query parameter
    router.push(`/player/${videoId}?url=${encodeURIComponent(normalizedUrl)}`);
  };

  /**
   * Переход на экран настроек
   */
  const handleSettings = () => {
    router.push('/settings');
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.content}>
        {/* Логотип и заголовок */}
        <View style={styles.header}>
          <Ionicons name="language" size={64} color={theme.colors.accent} />
          <Text style={styles.title}>YouTube{'\n'}Translator</Text>
          <Text style={styles.subtitle}>
            Синхронный перевод видео в реальном времени
          </Text>
        </View>

        {/* Поле ввода URL */}
        <View style={styles.inputContainer}>
          <View style={styles.inputWrapper}>
            <Ionicons
              name="link"
              size={20}
              color={theme.colors.textSecondary}
              style={styles.inputIcon}
            />
            <TextInput
              style={styles.input}
              placeholder="Вставьте ссылку на YouTube видео"
              placeholderTextColor={theme.colors.textMuted}
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={handleStart}
            />
            {url.length > 0 && (
              <TouchableOpacity onPress={() => setUrl('')} style={styles.clearButton}>
                <Ionicons name="close-circle" size={20} color={theme.colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>

          {/* Кнопка "Смотреть с переводом" */}
          <TouchableOpacity style={styles.startButton} onPress={handleStart}>
            <Ionicons name="play" size={24} color={theme.colors.text} />
            <Text style={styles.startButtonText}>Смотреть с переводом</Text>
          </TouchableOpacity>
        </View>

        {/* Кнопка настроек */}
        <TouchableOpacity style={styles.settingsButton} onPress={handleSettings}>
          <Ionicons name="settings-outline" size={22} color={theme.colors.textSecondary} />
          <Text style={styles.settingsText}>Настройки</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  header: {
    alignItems: 'center',
    marginBottom: theme.spacing.xl * 2,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.fontSize.xxl,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: theme.spacing.md,
    lineHeight: 40,
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: theme.fontSize.sm,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
  },
  inputContainer: {
    gap: theme.spacing.md,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.inputBorder,
    paddingHorizontal: theme.spacing.md,
  },
  inputIcon: {
    marginRight: theme.spacing.sm,
  },
  input: {
    flex: 1,
    height: 52,
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
  },
  clearButton: {
    padding: theme.spacing.xs,
  },
  startButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    height: 52,
    gap: theme.spacing.sm,
  },
  startButtonText: {
    color: theme.colors.text,
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
  },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
  settingsText: {
    color: theme.colors.textSecondary,
    fontSize: theme.fontSize.md,
  },
});
