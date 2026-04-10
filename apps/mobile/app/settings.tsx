import React from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ProviderSelector } from '../components/ProviderSelector';
import { useSettingsStore } from '../store/settings.store';
import { theme } from '../constants/theme';
import { languages } from '../constants/languages';

/**
 * Экран настроек — выбор языка, провайдеров, API ключей.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const settings = useSettingsStore();

  /**
   * Сохранение настроек
   */
  const handleSave = async () => {
    await settings.saveSettings();
    Alert.alert('Готово', 'Настройки сохранены', [
      { text: 'OK', onPress: () => router.back() },
    ]);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* Секция: Язык перевода */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Язык перевода</Text>
        <View style={styles.languageGrid}>
          {languages.map((lang) => {
            const isSelected = settings.targetLanguage === lang.code;
            return (
              <TouchableOpacity
                key={lang.code}
                style={[styles.languageChip, isSelected && styles.languageChipSelected]}
                onPress={() => settings.setTargetLanguage(lang.code)}
              >
                <Text
                  style={[
                    styles.languageChipText,
                    isSelected && styles.languageChipTextSelected,
                  ]}
                >
                  {lang.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Секция: Громкость оригинала */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Громкость оригинала</Text>
        <View style={styles.sliderContainer}>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            value={settings.originalVolume}
            onValueChange={settings.setOriginalVolume}
            minimumTrackTintColor={theme.colors.accent}
            maximumTrackTintColor={theme.colors.inputBorder}
            thumbTintColor={theme.colors.accent}
          />
          <Text style={styles.sliderValue}>
            {Math.round(settings.originalVolume * 100)}%
          </Text>
        </View>
      </View>

      {/* Секция: Провайдеры */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Провайдеры</Text>
        <ProviderSelector showModeToggle={false} showApiKeys={true} />
      </View>

      {/* Секция: Адрес бэкенда */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Сервер</Text>
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Адрес бэкенда</Text>
          <TextInput
            style={styles.apiKeyInput}
            placeholder="http://localhost:3000"
            placeholderTextColor={theme.colors.textMuted}
            value={settings.backendUrl}
            onChangeText={settings.setBackendUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
      </View>

      {/* Кнопка "Сохранить" */}
      <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
        <Ionicons name="checkmark" size={24} color={theme.colors.text} />
        <Text style={styles.saveButtonText}>Сохранить</Text>
      </TouchableOpacity>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
  },
  section: {
    marginBottom: theme.spacing.xl,
  },
  sectionTitle: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.lg,
    fontWeight: '700',
    marginBottom: theme.spacing.md,
  },
  languageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  languageChip: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  languageChipSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent + '20',
  },
  languageChipText: {
    color: theme.colors.textSecondary,
    fontSize: theme.fontSize.sm,
  },
  languageChipTextSelected: {
    color: theme.colors.accent,
    fontWeight: '600',
  },
  sliderContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.md,
  },
  slider: {
    flex: 1,
    height: 40,
  },
  sliderValue: {
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    width: 50,
    textAlign: 'right',
  },
  inputGroup: {
    marginBottom: theme.spacing.md,
  },
  inputLabel: {
    color: theme.colors.textSecondary,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing.sm,
  },
  apiKeyInput: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.inputBorder,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    height: 52,
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  saveButtonText: {
    color: theme.colors.text,
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
  },
  bottomSpacer: {
    height: 40,
  },
});
