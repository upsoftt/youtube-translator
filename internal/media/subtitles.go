package media

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/upsoftt/youtube-translator/internal/config"
)

// SubtitleSegment — один сегмент субтитров с таймингами
type SubtitleSegment struct {
	Text      string  `json:"text"`
	StartTime float64 `json:"startTime"` // секунды
	Duration  float64 `json:"duration"`  // секунды
}

const subtitlesTimeout = 15 * time.Second

// FetchYouTubeSubtitles загружает субтитры YouTube через yt-dlp.
// Возвращает nil если субтитры недоступны.
func FetchYouTubeSubtitles(cfg *config.Config, youtubeURL, language string) ([]SubtitleSegment, error) {
	if language == "" {
		language = "en"
	}

	tmpBase := filepath.Join(os.TempDir(), fmt.Sprintf("yt-subs-%d", time.Now().UnixMilli()))
	defer cleanupTempFiles(tmpBase)

	ctx, cancel := context.WithTimeout(context.Background(), subtitlesTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, cfg.YtdlpPath,
		"--write-auto-sub",
		"--write-sub",
		"--sub-lang", language,
		"--sub-format", "json3",
		"--skip-download",
		"-o", tmpBase,
		youtubeURL,
	)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("yt-dlp subtitles: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}

	// Ищем файл с субтитрами
	dir := filepath.Dir(tmpBase)
	base := filepath.Base(tmpBase)
	entries, _ := os.ReadDir(dir)

	var subtitleFile string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), base) && strings.HasSuffix(e.Name(), ".json3") {
			subtitleFile = filepath.Join(dir, e.Name())
			break
		}
	}

	if subtitleFile == "" {
		slog.Info("[Subtitles] Файл субтитров не найден")
		return nil, nil
	}

	// Парсим json3
	data, err := os.ReadFile(subtitleFile)
	if err != nil {
		return nil, fmt.Errorf("read subtitles: %w", err)
	}

	segments := parseJson3Subtitles(data)
	if segments == nil {
		return nil, nil
	}

	slog.Info("[Subtitles] Загружены", "segments", len(segments))
	return segments, nil
}

// json3 формат YouTube
type json3File struct {
	Events []json3Event `json:"events"`
}

type json3Event struct {
	TStartMs    int64      `json:"tStartMs"`
	DDurationMs int64      `json:"dDurationMs"`
	Segs        []json3Seg `json:"segs"`
}

type json3Seg struct {
	UTF8 string `json:"utf8"`
}

func parseJson3Subtitles(data []byte) []SubtitleSegment {
	var file json3File
	if err := json.Unmarshal(data, &file); err != nil {
		slog.Warn("[Subtitles] Ошибка парсинга json3", "error", err)
		return nil
	}

	if len(file.Events) == 0 {
		return nil
	}

	// Парсим события
	var raw []SubtitleSegment
	for _, event := range file.Events {
		if len(event.Segs) == 0 || event.TStartMs == 0 {
			continue
		}

		var parts []string
		for _, seg := range event.Segs {
			if seg.UTF8 != "" {
				parts = append(parts, seg.UTF8)
			}
		}

		text := strings.TrimSpace(strings.ReplaceAll(strings.Join(parts, ""), "\n", " "))
		if text == "" {
			continue
		}

		startTime := float64(event.TStartMs) / 1000.0
		duration := float64(event.DDurationMs) / 1000.0
		if duration == 0 {
			duration = 3.0
		}

		raw = append(raw, SubtitleSegment{Text: text, StartTime: startTime, Duration: duration})
	}

	// Объединяем короткие сегменты
	merged := mergeSubtitleSegments(raw)
	slog.Info("[Subtitles] Парсинг", "raw", len(raw), "merged", len(merged))
	return merged
}

// mergeSubtitleSegments объединяет короткие сегменты для лучшего перевода
func mergeSubtitleSegments(segments []SubtitleSegment) []SubtitleSegment {
	var result []SubtitleSegment
	var buffer string
	var bufferStart, bufferEnd float64

	punctuationRe := regexp.MustCompile(`[.!?]$`)

	for _, seg := range segments {
		if buffer == "" {
			buffer = seg.Text
			bufferStart = seg.StartTime
			bufferEnd = seg.StartTime + seg.Duration
		} else {
			buffer += " " + seg.Text
			bufferEnd = seg.StartTime + seg.Duration
		}

		wordCount := len(strings.Fields(buffer))
		endsWithPunct := punctuationRe.MatchString(buffer)
		totalDuration := bufferEnd - bufferStart

		if wordCount >= 8 || endsWithPunct || totalDuration > 5 {
			result = append(result, SubtitleSegment{
				Text:      strings.TrimSpace(buffer),
				StartTime: bufferStart,
				Duration:  totalDuration,
			})
			buffer = ""
		}
	}

	if strings.TrimSpace(buffer) != "" {
		result = append(result, SubtitleSegment{
			Text:      strings.TrimSpace(buffer),
			StartTime: bufferStart,
			Duration:  bufferEnd - bufferStart,
		})
	}

	return result
}

func cleanupTempFiles(basePath string) {
	dir := filepath.Dir(basePath)
	base := filepath.Base(basePath)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), base) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
