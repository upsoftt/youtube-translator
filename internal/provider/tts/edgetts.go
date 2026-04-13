package tts

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	// Константы из edge-tts Python пакета
	trustedClientToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
	secMSGECVersion    = "1-143.0.3650.75"
	edgeWSBaseURL      = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
	edgeOrigin         = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
	edgeUserAgent      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"

	// Windows file time epoch offset (секунды между 1601-01-01 и 1970-01-01)
	winEpoch = 11644473600

	// Формат аудио
	outputFormat = "audio-24khz-48kbitrate-mono-mp3"

	// Таймауты
	connectTimeout   = 10 * time.Second
	synthesisTimeout = 20 * time.Second
	reconnectDelay   = 1 * time.Second
	maxReconnects    = 3
)

// EdgeTTSProvider — TTS через Microsoft Edge Speech Service.
// Использует persistent WebSocket с DRM-токенами (Sec-MS-GEC).
type EdgeTTSProvider struct {
	language string
	voice    string

	conn   *websocket.Conn
	connMu sync.Mutex
}

func (p *EdgeTTSProvider) Name() string { return "edge-tts" }

func (p *EdgeTTSProvider) Initialize(opts Options) error {
	p.language = opts.Language
	if p.language == "" {
		p.language = "ru"
	}
	voices, ok := EdgeVoices[p.language]
	if ok {
		p.voice = voices.Male
	} else {
		p.voice = "en-US-GuyNeural"
	}
	if opts.Voice != "" {
		p.voice = opts.Voice
	}
	slog.Info("[EdgeTTS] Инициализирован", "voice", p.voice, "language", p.language)
	return nil
}

func (p *EdgeTTSProvider) Synthesize(text string, gender string) ([]byte, error) {
	if text == "" || strings.TrimSpace(text) == "" {
		return nil, nil
	}

	voice := p.getVoiceForGender(gender)

	var lastErr error
	for attempt := 0; attempt <= maxReconnects; attempt++ {
		if attempt > 0 {
			slog.Warn("[EdgeTTS] Retry", "attempt", attempt, "error", lastErr)
			time.Sleep(reconnectDelay)
		}

		audio, err := p.synthesizeOnce(text, voice)
		if err != nil {
			lastErr = err
			p.closeConn()
			continue
		}
		return audio, nil
	}
	return nil, fmt.Errorf("[EdgeTTS] %d попыток не удались: %w", maxReconnects+1, lastErr)
}

func (p *EdgeTTSProvider) Destroy() error {
	p.closeConn()
	slog.Info("[EdgeTTS] Завершён")
	return nil
}

func (p *EdgeTTSProvider) synthesizeOnce(text, voice string) ([]byte, error) {
	conn, err := p.ensureConnection()
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	requestID := connectID()

	// 1. Конфигурация формата аудио
	configMsg := fmt.Sprintf(
		"X-Timestamp:%s\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"+
			`{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"%s"}}}}`,
		formatTimestamp(), outputFormat,
	)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(configMsg)); err != nil {
		return nil, fmt.Errorf("write config: %w", err)
	}

	// 2. SSML запрос
	ssml := buildSSML(text, voice)
	ssmlMsg := fmt.Sprintf(
		"X-RequestId:%s\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:%s\r\nPath:ssml\r\n\r\n%s",
		requestID, formatTimestamp(), ssml,
	)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(ssmlMsg)); err != nil {
		return nil, fmt.Errorf("write ssml: %w", err)
	}

	// 3. Чтение ответа — binary фреймы с 2-байтным заголовком
	var audioBuf bytes.Buffer
	deadline := time.Now().Add(synthesisTimeout)
	_ = conn.SetReadDeadline(deadline)

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return nil, fmt.Errorf("read: %w", err)
		}

		switch msgType {
		case websocket.BinaryMessage:
			// Первые 2 байта — длина заголовка (big endian)
			if len(data) < 2 {
				continue
			}
			headerLen := int(binary.BigEndian.Uint16(data[:2]))
			audioStart := 2 + headerLen
			if audioStart < len(data) {
				audioBuf.Write(data[audioStart:])
			}

		case websocket.TextMessage:
			txt := string(data)
			if strings.Contains(txt, "Path:turn.end") {
				_ = conn.SetReadDeadline(time.Time{})
				result := audioBuf.Bytes()
				if len(result) == 0 {
					return nil, fmt.Errorf("пустой ответ от Edge TTS")
				}
				slog.Info("[EdgeTTS] Синтезировано",
					"bytes", len(result),
					"text", truncate(text, 50),
				)
				return result, nil
			}
		}
	}
}

// ensureConnection создаёт или возвращает существующее WebSocket соединение
func (p *EdgeTTSProvider) ensureConnection() (*websocket.Conn, error) {
	p.connMu.Lock()
	defer p.connMu.Unlock()

	if p.conn != nil {
		return p.conn, nil
	}

	connID := connectID()
	secMSGEC := generateSecMSGEC()
	muid := generateMUID()

	wsURL := fmt.Sprintf("%s?TrustedClientToken=%s&ConnectionId=%s&Sec-MS-GEC=%s&Sec-MS-GEC-Version=%s",
		edgeWSBaseURL, trustedClientToken, connID, secMSGEC, secMSGECVersion)

	dialer := websocket.Dialer{
		HandshakeTimeout: connectTimeout,
	}
	headers := http.Header{
		"Pragma":          {"no-cache"},
		"Cache-Control":   {"no-cache"},
		"Origin":          {edgeOrigin},
		"User-Agent":      {edgeUserAgent},
		"Accept-Encoding": {"gzip, deflate, br, zstd"},
		"Accept-Language": {"en-US,en;q=0.9"},
		"Cookie":          {fmt.Sprintf("muid=%s;", muid)},
	}

	conn, _, err := dialer.Dial(wsURL, headers)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}

	p.conn = conn
	slog.Info("[EdgeTTS] WebSocket подключён")
	return conn, nil
}

func (p *EdgeTTSProvider) closeConn() {
	p.connMu.Lock()
	defer p.connMu.Unlock()
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
}

func (p *EdgeTTSProvider) getVoiceForGender(gender string) string {
	voices, ok := EdgeVoices[p.language]
	if !ok {
		return p.voice
	}
	if gender == "female" {
		return voices.Female
	}
	return voices.Male
}

// --- DRM функции (порт из edge-tts Python) ---

// generateSecMSGEC генерирует Sec-MS-GEC токен.
// Алгоритм: Unix timestamp + win epoch, округлить до 5 мин,
// перевести в 100-наносекундные интервалы, хешировать SHA256 с trusted token.
func generateSecMSGEC() string {
	ticks := float64(time.Now().Unix())
	ticks += winEpoch
	ticks -= float64(int64(ticks) % 300) // округление до 5 мин
	ticks *= 1e7                          // 100-наносекундные интервалы

	strToHash := fmt.Sprintf("%.0f%s", ticks, trustedClientToken)
	hash := sha256.Sum256([]byte(strToHash))
	return fmt.Sprintf("%X", hash)
}

// generateMUID генерирует случайный MUID (32 hex символа)
func generateMUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%X", b)
}

// connectID генерирует UUID без дефисов
func connectID() string {
	return strings.ReplaceAll(uuid.NewString(), "-", "")
}

// buildSSML формирует SSML-разметку для синтеза
func buildSSML(text, voice string) string {
	escaped := xmlEscape(text)
	return fmt.Sprintf(
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`+
			`<voice name='%s'>`+
			`<prosody pitch='+0Hz' rate='+0%%' volume='+0%%'>%s</prosody>`+
			`</voice></speak>`,
		voice, escaped,
	)
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	return s
}

func formatTimestamp() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
