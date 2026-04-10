import React from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Switch } from 'react-native';
import { useSettingsStore } from '../store/settings.store';
import { usePlayerStore } from '../store/player.store';
import { theme } from '../constants/theme';

interface ProviderSelectorProps {
  onProviderChange?: () => void;
  showModeToggle?: boolean;
  showApiKeys?: boolean;
}

/**
 * Компактный переключатель провайдеров.
 * showModeToggle — показывать переключатель Бесплатный/Стриминг (только в плеере)
 * showApiKeys — показывать поля API-ключей (только в настройках)
 */
export function ProviderSelector({ onProviderChange, showModeToggle = true, showApiKeys = false }: ProviderSelectorProps = {}) {
  const {
    sttProvider,
    setSttProvider,
    translationProvider,
    setTranslationProvider,
    ttsProvider,
    setTtsProvider,
    targetLanguage,
    setTargetLanguage,
    deepgramApiKey,
    setDeepgramApiKey,
    openaiApiKey,
    setOpenaiApiKey,
    translationMode,
    setTranslationMode,
    preferSubtitles,
    setPreferSubtitles,
  } = useSettingsStore();

  const providerInfo = usePlayerStore(state => state.providerInfo);
  const isStreaming = translationMode === 'streaming';

  // Проверка наличия ключей
  const needsDeepgramKey = isStreaming || sttProvider === 'deepgram' || ttsProvider === 'deepgram-tts';
  const needsOpenaiKey = isStreaming || translationProvider === 'openai';
  const missingKeys: string[] = [];
  if (needsDeepgramKey && !deepgramApiKey) missingKeys.push('DeepGram');
  if (needsOpenaiKey && !openaiApiKey) missingKeys.push('OpenAI');

  const handleSelect = (setter: (id: string) => void) => (id: string) => {
    setter(id);
    onProviderChange?.();
  };

  const renderOption = (label: string, current: string, options: { id: string; name: string }[], onSelect: (id: string) => void) => (
    <View style={styles.optionGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chipContainer}>
        {options.map((opt) => (
          <TouchableOpacity
            key={opt.id}
            style={[styles.chip, current === opt.id && styles.activeChip]}
            onPress={() => onSelect(opt.id)}
          >
            <Text style={[styles.chipText, current === opt.id && styles.activeChipText]}>
              {opt.name}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Переключатель режима — только в плеере */}
      {showModeToggle && <View style={styles.optionGroup}>
        <Text style={styles.label}>РЕЖИМ</Text>
        <View style={styles.chipContainer}>
          <TouchableOpacity
            style={[styles.modeButton, !isStreaming && styles.modeActive]}
            onPress={() => { setTranslationMode('free'); onProviderChange?.(); }}
          >
            <Text style={[styles.modeText, !isStreaming && styles.modeTextActive]}>
              Бесплатный
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeButton, isStreaming && styles.modeActive]}
            onPress={() => { setTranslationMode('streaming'); onProviderChange?.(); }}
          >
            <Text style={[styles.modeText, isStreaming && styles.modeTextActive]}>
              Стриминг (API)
            </Text>
          </TouchableOpacity>
        </View>
      </View>}

      {/* Провайдеры — скрываются в стриминг-режиме плеера */}
      {(!isStreaming || !showModeToggle) && renderOption('Распознавание (STT)', sttProvider, [
        { id: 'whisper', name: 'Whisper Cloud' },
        { id: 'local-whisper', name: 'Local GPU' },
        { id: 'deepgram', name: 'Deepgram' },
      ], handleSelect(setSttProvider))}

      {(!isStreaming || !showModeToggle) && renderOption('Перевод', translationProvider, [
        { id: 'libre', name: 'Libre' },
        { id: 'openai', name: 'OpenAI' },
      ], handleSelect(setTranslationProvider))}

      {(!isStreaming || !showModeToggle) && renderOption('Озвучка (TTS)', ttsProvider, [
        { id: 'edge-tts', name: 'Edge' },
        { id: 'deepgram-tts', name: 'Deepgram' },
      ], handleSelect(setTtsProvider))}

      {/* Субтитры YouTube */}
      {isStreaming && (
        <View style={styles.subtitleToggle}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>ИСТОЧНИК ТЕКСТА</Text>
            <Text style={styles.subtitleHint}>
              {preferSubtitles ? 'Субтитры YouTube (если есть) → STT' : 'Только распознавание аудио (STT)'}
            </Text>
          </View>
          <Switch
            value={preferSubtitles}
            onValueChange={(v) => { setPreferSubtitles(v); onProviderChange?.(); }}
            trackColor={{ false: '#333', true: theme.colors.accent }}
            thumbColor="#fff"
          />
        </View>
      )}

      {renderOption('Язык перевода', targetLanguage, [
        { id: 'ru', name: 'РУС' },
        { id: 'en', name: 'ENG' },
        { id: 'de', name: 'DEU' },
        { id: 'es', name: 'ESP' },
      ], handleSelect(setTargetLanguage))}

      {/* Активные провайдеры (от сервера) */}
      {providerInfo && (
        <View style={styles.providerInfoBox}>
          <Text style={styles.providerInfoLabel}>АКТИВНЫЕ ПРОВАЙДЕРЫ</Text>
          <Text style={styles.providerInfoText}>STT: {providerInfo.stt}</Text>
          <Text style={styles.providerInfoText}>Перевод: {providerInfo.translation}</Text>
          <Text style={styles.providerInfoText}>TTS: {providerInfo.tts}</Text>
        </View>
      )}

      {/* Предупреждение о недостающих ключах (в плеере) */}
      {!showApiKeys && missingKeys.length > 0 && (
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>
            Нет API-ключей: {missingKeys.join(', ')}. Укажите их в Настройках.
          </Text>
        </View>
      )}

      {/* API ключи — только в настройках */}
      {showApiKeys && (
        <>
          <View style={styles.optionGroup}>
            <Text style={styles.label}>DeepGram API Key</Text>
            <TextInput
              style={styles.apiInput}
              placeholder="Введите ключ..."
              placeholderTextColor="#555"
              value={deepgramApiKey}
              onChangeText={setDeepgramApiKey}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </View>
          <View style={styles.optionGroup}>
            <Text style={styles.label}>OpenAI API Key</Text>
            <TextInput
              style={styles.apiInput}
              placeholder="Введите ключ..."
              placeholderTextColor="#555"
              value={openaiApiKey}
              onChangeText={setOpenaiApiKey}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 16,
  },
  optionGroup: {
    gap: 8,
  },
  label: {
    color: '#888',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  chipContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  activeChip: {
    backgroundColor: theme.colors.accent + '20',
    borderColor: theme.colors.accent,
  },
  chipText: {
    color: '#aaa',
    fontSize: 11,
    fontWeight: '600',
  },
  activeChipText: {
    color: theme.colors.accent,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center' as const,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  modeActive: {
    backgroundColor: theme.colors.accent + '33',
    borderColor: theme.colors.accent,
  },
  modeText: {
    color: '#777',
    fontSize: 12,
    fontWeight: '700' as const,
  },
  modeTextActive: {
    color: theme.colors.accent,
  },
  warningBox: {
    backgroundColor: 'rgba(255,68,68,0.15)',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,68,68,0.3)',
  },
  warningText: {
    color: '#FF6B6B',
    fontSize: 11,
    fontWeight: '600',
  },
  apiInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#fff',
    fontSize: 12,
  },
  subtitleToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  subtitleHint: {
    color: '#666',
    fontSize: 10,
    marginTop: 4,
  },
  providerInfoBox: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    gap: 3,
  },
  providerInfoLabel: {
    color: '#555',
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  providerInfoText: {
    color: '#888',
    fontSize: 10,
  },
});
