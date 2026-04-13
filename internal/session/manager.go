package session

import (
	"log/slog"
	"sync"

	"github.com/fasthttp/websocket"
)

// Manager управляет всеми активными сессиями
type Manager struct {
	sessions sync.Map
}

// NewManager создаёт менеджер сессий
func NewManager() *Manager {
	return &Manager{}
}

// Create создаёт и регистрирует новую сессию
func (m *Manager) Create(id string, conn *websocket.Conn) *Session {
	s := NewSession(id, conn)
	m.sessions.Store(id, s)
	slog.Info("[SessionManager] Сессия создана", "id", id)
	return s
}

// Get возвращает сессию по ID
func (m *Manager) Get(id string) *Session {
	v, ok := m.sessions.Load(id)
	if !ok {
		return nil
	}
	return v.(*Session)
}

// Destroy закрывает и удаляет сессию
func (m *Manager) Destroy(id string) {
	v, ok := m.sessions.LoadAndDelete(id)
	if !ok {
		return
	}
	s := v.(*Session)
	s.Close()
	slog.Info("[SessionManager] Сессия уничтожена", "id", id)
}

// ShutdownAll завершает все активные сессии
func (m *Manager) ShutdownAll() {
	count := 0
	m.sessions.Range(func(key, value interface{}) bool {
		s := value.(*Session)
		s.Close()
		count++
		return true
	})
	if count > 0 {
		slog.Info("[SessionManager] Все сессии остановлены", "count", count)
	}
}
