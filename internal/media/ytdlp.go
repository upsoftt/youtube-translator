package media

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/upsoftt/youtube-translator/internal/config"
)

const ytdlpTimeout = 30 * time.Second

// GetVideoURL возвращает прямой URL видео для воспроизведения в iframe
func GetVideoURL(cfg *config.Config, youtubeURL string) (string, error) {
	return runYtdlp(cfg.YtdlpPath, youtubeURL, "best")
}

// GetAudioURL возвращает прямой URL аудиопотока
func GetAudioURL(cfg *config.Config, youtubeURL string) (string, error) {
	return runYtdlp(cfg.YtdlpPath, youtubeURL, "bestaudio")
}

func runYtdlp(ytdlpPath, youtubeURL, format string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ytdlpTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, ytdlpPath, "-g", "-f", format, "--no-playlist", youtubeURL)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	slog.Info("[yt-dlp] Запрос URL", "format", format)

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("yt-dlp: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}

	url := strings.TrimSpace(strings.Split(stdout.String(), "\n")[0])
	if url == "" {
		return "", fmt.Errorf("yt-dlp: пустой ответ")
	}

	slog.Info("[yt-dlp] URL получен", "format", format)
	return url, nil
}
