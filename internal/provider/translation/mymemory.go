package translation

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	myMemoryURL    = "https://api.mymemory.translated.net/get"
	requestTimeout = 5 * time.Second
	maxChunkLen    = 450
)

// MyMemoryProvider — бесплатный перевод через MyMemory API
type MyMemoryProvider struct {
	sourceLang string
	targetLang string
	client     *http.Client
}

func (p *MyMemoryProvider) Name() string { return "libre" }

func (p *MyMemoryProvider) Initialize(opts Options) error {
	p.sourceLang = opts.SourceLanguage
	if p.sourceLang == "" {
		p.sourceLang = "en"
	}
	p.targetLang = opts.TargetLanguage
	if p.targetLang == "" {
		p.targetLang = "ru"
	}
	p.client = &http.Client{Timeout: requestTimeout}
	slog.Info("[Translation] Инициализирован", "from", p.sourceLang, "to", p.targetLang)
	return nil
}

func (p *MyMemoryProvider) Translate(text string) (string, error) {
	if text == "" || strings.TrimSpace(text) == "" {
		return "", nil
	}

	chunks := splitText(text, maxChunkLen)
	var results []string

	for _, chunk := range chunks {
		translated, err := p.translateChunk(chunk)
		if err != nil {
			return text, err // fallback: оригинал
		}
		results = append(results, translated)
	}

	return strings.Join(results, " "), nil
}

func (p *MyMemoryProvider) translateChunk(text string) (string, error) {
	langPair := fmt.Sprintf("%s|%s", p.sourceLang, p.targetLang)
	reqURL := fmt.Sprintf("%s?q=%s&langpair=%s",
		myMemoryURL,
		url.QueryEscape(text),
		url.QueryEscape(langPair),
	)

	slog.Info("[Translation] Запрос", "chars", len(text), "text", truncateStr(text, 60))

	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return text, err
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return text, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return text, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var data struct {
		ResponseStatus int `json:"responseStatus"`
		ResponseData   struct {
			TranslatedText string `json:"translatedText"`
		} `json:"responseData"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return text, fmt.Errorf("decode: %w", err)
	}

	if data.ResponseStatus == 200 && data.ResponseData.TranslatedText != "" {
		result := data.ResponseData.TranslatedText
		slog.Info("[Translation] Результат", "text", truncateStr(result, 60))
		return result, nil
	}

	return text, nil
}

func (p *MyMemoryProvider) Destroy() error {
	slog.Info("[Translation] Завершён")
	return nil
}

// splitText разбивает текст на части, стараясь резать по предложениям
func splitText(text string, maxLen int) []string {
	if len(text) <= maxLen {
		return []string{text}
	}

	var chunks []string
	remaining := text

	for len(remaining) > 0 {
		if len(remaining) <= maxLen {
			chunks = append(chunks, remaining)
			break
		}

		cutAt := -1
		for _, sep := range []string{". ", "! ", "? ", ", "} {
			idx := strings.LastIndex(remaining[:maxLen], sep)
			if idx > 0 && idx > cutAt {
				cutAt = idx + len(sep)
			}
		}
		if cutAt <= 0 {
			cutAt = maxLen
		}

		chunks = append(chunks, strings.TrimSpace(remaining[:cutAt]))
		remaining = strings.TrimSpace(remaining[cutAt:])
	}

	return chunks
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
