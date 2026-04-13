package tts

import (
	"os"
	"testing"
)

func TestEdgeTTSSynthesize(t *testing.T) {
	provider := &EdgeTTSProvider{}
	if err := provider.Initialize(Options{Language: "ru"}); err != nil {
		t.Fatal(err)
	}
	defer provider.Destroy()

	audio, err := provider.Synthesize("Привет, это тест синтеза речи.", "male")
	if err != nil {
		t.Fatal(err)
	}

	if len(audio) == 0 {
		t.Fatal("Пустой аудио-ответ")
	}

	t.Logf("Получено %d байт аудио", len(audio))

	// Проверяем что это MP3 (начинается с ID3 или 0xFF)
	if len(audio) > 3 && string(audio[:3]) != "ID3" && audio[0] != 0xFF {
		t.Fatalf("Невалидный MP3: первые байты %X", audio[:4])
	}

	// Сохраняем для ручной проверки
	_ = os.WriteFile("test_output.mp3", audio, 0644)
	t.Log("Сохранено в test_output.mp3")
}

func TestEdgeTTSReuseConnection(t *testing.T) {
	provider := &EdgeTTSProvider{}
	if err := provider.Initialize(Options{Language: "ru"}); err != nil {
		t.Fatal(err)
	}
	defer provider.Destroy()

	// Первый запрос — создаёт соединение
	audio1, err := provider.Synthesize("Первый сегмент.", "male")
	if err != nil {
		t.Fatal("Первый запрос:", err)
	}
	t.Logf("Сегмент 1: %d байт", len(audio1))

	// Второй запрос — переиспользует соединение
	audio2, err := provider.Synthesize("Второй сегмент.", "female")
	if err != nil {
		t.Fatal("Второй запрос:", err)
	}
	t.Logf("Сегмент 2: %d байт", len(audio2))

	if len(audio1) == 0 || len(audio2) == 0 {
		t.Fatal("Один из сегментов пустой")
	}
}
