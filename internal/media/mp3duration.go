package media

// GetMp3Duration оценивает длительность MP3 буфера через парсинг CBR-фрейма.
//
// Алгоритм:
// 1. Пропускаем ID3v2-тег если есть (syncsafe-int размер)
// 2. Ищем первый валидный MP3-фрейм (sync word 0xFF 0xEx/0xFx)
// 3. duration = audioBytes * 8 / bitrate_bps
//
// Возвращает секунды (>0), или 0 если не удалось определить.
func GetMp3Duration(data []byte) float64 {
	if len(data) < 10 {
		return 0
	}

	// Битрейты MPEG1 Layer 3 (кбит/с)
	bitrateTable := [16]int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}

	// Шаг 1: пропускаем ID3v2 тег
	audioStart := 0
	if data[0] == 0x49 && data[1] == 0x44 && data[2] == 0x33 { // "ID3"
		id3Size := (int(data[6]&0x7F) << 21) |
			(int(data[7]&0x7F) << 14) |
			(int(data[8]&0x7F) << 7) |
			int(data[9]&0x7F)
		audioStart = 10 + id3Size
		if audioStart >= len(data) {
			return 0
		}
	}

	// Шаг 2: ищем первый валидный фрейм (в пределах 4KB от начала аудио)
	searchEnd := audioStart + 4096
	if searchEnd > len(data)-4 {
		searchEnd = len(data) - 4
	}

	for i := audioStart; i < searchEnd; i++ {
		if data[i] != 0xFF {
			continue
		}

		byte1 := data[i+1]
		// Sync bits
		if byte1&0xE0 != 0xE0 {
			continue
		}
		// Layer bits не 00
		if byte1&0x06 == 0x00 {
			continue
		}

		byte2 := data[i+2]
		bitrateIndex := (byte2 >> 4) & 0x0F
		if bitrateIndex == 0 || bitrateIndex == 15 {
			continue
		}

		bitrateKbps := bitrateTable[bitrateIndex]
		if bitrateKbps == 0 {
			continue
		}

		// duration = audioBytes * 8 / bitrate_bps
		audioBytes := len(data) - i
		return float64(audioBytes) * 8.0 / float64(bitrateKbps*1000)
	}

	return 0
}
