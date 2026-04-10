/**
 * Оценивает длительность MP3 буфера через парсинг заголовка первого CBR-фрейма.
 *
 * Алгоритм:
 * 1. Если буфер начинается с ID3v2-тега ("ID3") — вычисляем его размер по syncsafe-int
 *    и начинаем поиск фрейма ПОСЛЕ тега, а не с начала буфера.
 * 2. Ищем первый валидный MP3-фрейм (sync word 0xFF 0xEx/0xFx).
 * 3. Вычисляем duration = audioBytes * 8 / bitrate_bps.
 *
 * Работает для CBR MP3 (OpenAI TTS, DeepGram TTS, Edge TTS).
 * OpenAI TTS в частности добавляет ID3v2 тег перед аудио-данными.
 *
 * @returns длительность в секундах (>0), или 0 если не удалось определить
 */
export function getMp3Duration(buffer: Buffer): number {
  if (!buffer || buffer.length < 10) return 0;

  // Таблица битрейтов MPEG1 Layer 3 (кбит/с)
  const bitrateTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];

  // Шаг 1: пропускаем ID3v2-тег если он есть
  let audioStart = 0;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    // ID3v2 size: 4 байта с syncsafe-int (бит 7 каждого байта не используется)
    const id3Size =
      ((buffer[6] & 0x7F) << 21) |
      ((buffer[7] & 0x7F) << 14) |
      ((buffer[8] & 0x7F) << 7)  |
       (buffer[9] & 0x7F);
    audioStart = 10 + id3Size;
    // Если тег «съедает» весь буфер — данных нет
    if (audioStart >= buffer.length) return 0;
  }

  // Шаг 2: ищем первый валидный фрейм в пределах 4 KB от начала аудио-данных
  const searchEnd = Math.min(buffer.length - 4, audioStart + 4096);

  for (let i = audioStart; i < searchEnd; i++) {
    if (buffer[i] !== 0xFF) continue;

    const byte1 = buffer[i + 1];

    // Sync bits: все биты 0xE0 выставлены
    if ((byte1 & 0xE0) !== 0xE0) continue;

    // Layer bits (1-2) не должны быть 00 (undefined)
    if ((byte1 & 0x06) === 0x00) continue;

    const byte2 = buffer[i + 2];
    const bitrateIndex = (byte2 >> 4) & 0x0F;

    // Индексы 0 (free) и 15 (bad) не подходят
    if (bitrateIndex === 0 || bitrateIndex === 15) continue;

    const bitrateKbps = bitrateTable[bitrateIndex];
    if (bitrateKbps === 0) continue;

    // Шаг 3: duration = аудио-байты * 8 / битрейт
    const audioBytes = buffer.length - i;
    const durationSec = (audioBytes * 8) / (bitrateKbps * 1000);

    return durationSec;
  }

  return 0;
}
