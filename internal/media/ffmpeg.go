package media

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"sync"
	"time"

	"github.com/upsoftt/youtube-translator/internal/config"
)

// AudioStreamer стримит аудио из YouTube через ffmpeg.
// Двухшаговый подход: yt-dlp -g → audio URL → ffmpeg → MP3 chunks.
type AudioStreamer struct {
	cfg           *config.Config
	cmd           *exec.Cmd
	cancel        context.CancelFunc
	cachedAudioURL string
	cachedVideoURL string
	mu            sync.Mutex
}

// NewAudioStreamer создаёт стример
func NewAudioStreamer(cfg *config.Config) *AudioStreamer {
	return &AudioStreamer{cfg: cfg}
}

// StartStream запускает стриминг аудио и вызывает onChunk для каждого чанка.
// Блокирует до завершения потока или отмены контекста.
func (s *AudioStreamer) StartStream(ctx context.Context, youtubeURL string, seekSec float64, onChunk func([]byte)) error {
	// Получаем (или кэшируем) аудио URL
	audioURL, err := s.getAudioURL(youtubeURL)
	if err != nil {
		return fmt.Errorf("audio URL: %w", err)
	}

	// Создаём контекст с отменой для ffmpeg
	ffCtx, ffCancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.cancel = ffCancel
	s.mu.Unlock()

	// Собираем аргументы ffmpeg
	args := []string{}
	if seekSec > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.1f", seekSec))
	}
	args = append(args,
		"-i", audioURL,
		"-vn",
		"-acodec", "libmp3lame",
		"-ab", "64k",
		"-ar", "16000",
		"-ac", "1",
		"-f", "mp3",
		"-flush_packets", "1",
		"pipe:1",
	)

	cmd := exec.CommandContext(ffCtx, s.cfg.FfmpegPath, args...)
	s.mu.Lock()
	s.cmd = cmd
	s.mu.Unlock()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		ffCancel()
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		ffCancel()
		return fmt.Errorf("start ffmpeg: %w", err)
	}

	slog.Info("[ffmpeg] Стрим запущен", "seek", seekSec)

	// Читаем чанки из stdout
	buf := make([]byte, 16384) // 16KB chunks
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			onChunk(chunk)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			// Контекст отменён — нормальное завершение
			if ffCtx.Err() != nil {
				break
			}
			slog.Error("[ffmpeg] Ошибка чтения", "error", err)
			break
		}
	}

	// Ждём завершения процесса
	_ = cmd.Wait()
	slog.Info("[ffmpeg] Стрим завершён")
	return nil
}

// Stop останавливает текущий стрим
func (s *AudioStreamer) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}

	if s.cmd != nil && s.cmd.Process != nil {
		// Даём 2 секунды на graceful shutdown
		go func(cmd *exec.Cmd) {
			select {
			case <-time.After(2 * time.Second):
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
					slog.Warn("[ffmpeg] Принудительно убит")
				}
			}
		}(s.cmd)
		s.cmd = nil
	}
}

func (s *AudioStreamer) getAudioURL(youtubeURL string) (string, error) {
	s.mu.Lock()
	cached := s.cachedAudioURL
	cachedFor := s.cachedVideoURL
	s.mu.Unlock()

	if cached != "" && cachedFor == youtubeURL {
		return cached, nil
	}

	url, err := GetAudioURL(s.cfg, youtubeURL)
	if err != nil {
		return "", err
	}

	s.mu.Lock()
	s.cachedAudioURL = url
	s.cachedVideoURL = youtubeURL
	s.mu.Unlock()

	slog.Info("[ffmpeg] Аудио URL получен и закэширован")
	return url, nil
}
