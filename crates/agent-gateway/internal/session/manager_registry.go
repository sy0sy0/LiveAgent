package session

import (
	"context"
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) RecordAuthentication(agentID, agentVersion, sessionID string) {
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	m.registry.lastAuth = AuthSnapshot{
		AgentID:      agentID,
		AgentVersion: agentVersion,
		SessionID:    sessionID,
	}
	m.registry.authValid = true
}

func (m *Manager) LatestAuthSnapshot() AuthSnapshot {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.lastAuth
}

func (m *Manager) IsOnline() bool {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.session != nil
}

func (m *Manager) SetSession(s *AgentSession) {
	m.registry.mu.Lock()
	previous := m.registry.session
	if m.registry.authValid {
		s.AgentID = m.registry.lastAuth.AgentID
		s.AgentVersion = m.registry.lastAuth.AgentVersion
		s.SessionID = m.registry.lastAuth.SessionID
	}
	if previous != s {
		m.registry.sessionEpoch += 1
		clearRuntimeStatusLocked(m.registry)
	}
	sessionChanged := previous != s
	m.registry.session = s
	m.registry.mu.Unlock()

	if sessionChanged {
		m.clearTerminalSessionSnapshot()
	}
	if previous != nil && previous != s {
		previous.Close()
	}
}

func (m *Manager) ClearSession(session *AgentSession) {
	m.registry.mu.Lock()
	if m.registry.session != session {
		m.registry.mu.Unlock()
		return
	}
	m.registry.session = nil
	clearRuntimeStatusLocked(m.registry)
	m.registry.mu.Unlock()

	if session == nil {
		return
	}

	session.Close()
	m.clearTerminalSessionSnapshot()
}

func (m *Manager) ClearSessionIfHeartbeatStale(session *AgentSession, timeout time.Duration) bool {
	if session == nil || timeout <= 0 {
		return false
	}

	now := time.Now()
	m.registry.mu.Lock()
	if m.registry.session != session {
		m.registry.mu.Unlock()
		return false
	}
	if lastPing := m.registry.session.LastPing; !lastPing.IsZero() && now.Sub(lastPing) <= timeout {
		m.registry.mu.Unlock()
		return false
	}
	m.registry.session = nil
	clearRuntimeStatusLocked(m.registry)
	m.registry.mu.Unlock()

	session.Close()
	m.clearTerminalSessionSnapshot()
	return true
}

func (m *Manager) ClearSessionForEpoch(sessionEpoch uint64) bool {
	m.registry.mu.Lock()
	session := m.registry.session
	if session == nil || m.registry.sessionEpoch != sessionEpoch {
		m.registry.mu.Unlock()
		return false
	}
	m.registry.session = nil
	clearRuntimeStatusLocked(m.registry)
	m.registry.mu.Unlock()

	session.Close()
	m.clearTerminalSessionSnapshot()
	return true
}

func (m *Manager) Status() Status {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()

	now := time.Now()
	status := Status{}
	if m.registry.authValid {
		status.AgentID = m.registry.lastAuth.AgentID
		status.AgentVersion = m.registry.lastAuth.AgentVersion
		status.SessionID = m.registry.lastAuth.SessionID
	}
	if m.registry.session == nil {
		return status
	}
	status.Online = true
	status.AgentReady = true
	status.AgentID = m.registry.session.AgentID
	status.AgentVersion = m.registry.session.AgentVersion
	status.SessionID = m.registry.session.SessionID
	status.ConnectedSince = m.registry.session.ConnectedAt.Unix()
	status.LastHeartbeat = m.registry.session.LastPing.Unix()
	status.RuntimeState = m.registry.runtimeState
	status.RuntimeWorkerID = m.registry.runtimeWorkerID
	status.RuntimeVisible = m.registry.runtimeVisible
	status.RuntimeActiveRunCount = m.registry.runtimeActiveRunCount
	if !m.registry.runtimeLastHeartbeat.IsZero() {
		status.RuntimeLastHeartbeat = m.registry.runtimeLastHeartbeat.Unix()
	}
	status.ChatRuntimeReady = runtimeReadyLocked(m.registry, now)
	return status
}

func (m *Manager) ChatRuntimeReady() bool {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return runtimeReadyLocked(m.registry, time.Now())
}

func (m *Manager) UpdateRuntimeStatus(
	session *AgentSession,
	event *gatewayv1.RuntimeStatusEvent,
) {
	if event == nil {
		return
	}
	workerID := strings.TrimSpace(event.GetWorkerId())
	state := normalizeRuntimeState(event.GetState())
	now := time.Now()

	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	if m.registry.session == nil || (session != nil && m.registry.session != session) {
		return
	}
	m.registry.runtimeState = state
	m.registry.runtimeWorkerID = workerID
	m.registry.runtimeLastHeartbeat = now
	m.registry.runtimeVisible = event.GetVisible()
	m.registry.runtimeActiveRunCount = event.GetActiveRunCount()
}

func (m *Manager) TouchHeartbeat(session *AgentSession) {
	m.registry.mu.Lock()
	defer m.registry.mu.Unlock()
	if m.registry.session == session {
		m.registry.session.LastPing = time.Now()
	}
}

func clearRuntimeStatusLocked(registry *sessionRegistry) {
	registry.runtimeState = ""
	registry.runtimeWorkerID = ""
	registry.runtimeLastHeartbeat = time.Time{}
	registry.runtimeVisible = false
	registry.runtimeActiveRunCount = 0
}

func runtimeReadyLocked(registry *sessionRegistry, now time.Time) bool {
	if registry == nil || registry.session == nil {
		return false
	}
	if registry.session.LastPing.IsZero() || now.Sub(registry.session.LastPing) > agentSessionHeartbeatTTL {
		return false
	}
	if registry.runtimeLastHeartbeat.IsZero() ||
		now.Sub(registry.runtimeLastHeartbeat) > chatRuntimeReadyTTL {
		return false
	}
	switch normalizeRuntimeState(registry.runtimeState) {
	case "ready", "draining", "busy":
		return true
	default:
		return false
	}
}

func normalizeRuntimeState(state string) string {
	switch strings.TrimSpace(state) {
	case "ready", "draining", "busy", "suspended":
		return strings.TrimSpace(state)
	default:
		return defaultRuntimeReadyState
	}
}

func (m *Manager) SendToAgent(env *gatewayv1.GatewayEnvelope) error {
	m.registry.mu.RLock()
	session := m.registry.session
	m.registry.mu.RUnlock()
	if session == nil {
		return ErrAgentOffline
	}

	err := session.SendToAgent(env)
	m.clearSessionAfterSendError(session, err)
	return err
}

func (m *Manager) SendToAgentContext(ctx context.Context, env *gatewayv1.GatewayEnvelope) error {
	m.registry.mu.RLock()
	session := m.registry.session
	m.registry.mu.RUnlock()
	if session == nil {
		return ErrAgentOffline
	}

	err := session.SendToAgentContext(ctx, env)
	m.clearSessionAfterSendError(session, err)
	return err
}

func (m *Manager) clearSessionAfterSendError(session *AgentSession, err error) {
	if err == nil || session == nil {
		return
	}
	m.ClearSession(session)
}

func (m *Manager) currentSessionEpoch() uint64 {
	m.registry.mu.RLock()
	defer m.registry.mu.RUnlock()
	return m.registry.sessionEpoch
}

func (m *Manager) RegisterStream(requestID string) (<-chan *gatewayv1.AgentEnvelope, <-chan struct{}, func(), error) {
	m.registry.mu.RLock()
	session := m.registry.session
	m.registry.mu.RUnlock()
	if session == nil {
		return nil, nil, nil, ErrAgentOffline
	}

	stream, err := session.registerStream(requestID)
	if err != nil {
		return nil, nil, nil, err
	}

	cleanup := func() {
		session.unregisterStream(requestID, stream)
	}

	return stream.ch, stream.done, cleanup, nil
}
