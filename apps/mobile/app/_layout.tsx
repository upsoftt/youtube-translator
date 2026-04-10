import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSettingsStore } from '../store/settings.store';
import { theme } from '../constants/theme';

/**
 * Корневой layout приложения.
 * Stack навигатор с тёмной темой.
 */
export default function RootLayout() {
  const loadSettings = useSettingsStore((state) => state.loadSettings);

  // Загружаем сохранённые настройки при запуске
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: theme.colors.background,
          },
          headerTintColor: theme.colors.text,
          headerTitleStyle: {
            fontWeight: '600',
          },
          contentStyle: {
            backgroundColor: theme.colors.background,
          },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: 'YouTube Translator',
            headerTitleAlign: 'center',
          }}
        />
        <Stack.Screen
          name="player/[id]"
          options={{
            title: 'Плеер',
            headerBackTitle: 'Назад',
            headerShown: true,
            headerTransparent: true,
            headerStyle: {
              backgroundColor: 'rgba(0,0,0,0.7)',
            },
          }}
        />
        <Stack.Screen
          name="settings"
          options={{
            title: 'Настройки',
            headerBackTitle: 'Назад',
            presentation: 'modal',
          }}
        />
      </Stack>
    </>
  );
}
