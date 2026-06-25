package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

const (
	MaxTunnelsPerAgent       = 5
	MaxTunnelConnections     = 20
	defaultTunnelTTLSeconds  = 3600
	tunnelSlugEntropyBytes   = 24
	tunnelStreamChannelDepth = 256
	tunnelAgentSendTimeout   = 10 * time.Second
)

type tunnelStore struct {
	mu             sync.Mutex
	tunnelsByID    map[string]*tunnelRecord
	tunnelIDBySlug map[string]string
	streams        map[string]*tunnelStream
}

type tunnelRecord struct {
	id                string
	slug              string
	name              string
	targetURL         string
	publicURL         string
	projectPathKey    string
	diagnostics       []*gatewayv1.TunnelDiagnostic
	createdAt         time.Time
	expiresAt         time.Time
	activeConnections int
	closed            bool
}

type tunnelStream struct {
	streamID string
	tunnelID string
	ch       chan *gatewayv1.TunnelFrame
	done     chan struct{}
	once     sync.Once
}

type TunnelStreamLease struct {
	manager *Manager
	stream  *tunnelStream
	tunnel  *gatewayv1.TunnelSummary
	once    sync.Once
}

func newTunnelStore() *tunnelStore {
	return &tunnelStore{
		tunnelsByID:    make(map[string]*tunnelRecord),
		tunnelIDBySlug: make(map[string]string),
		streams:        make(map[string]*tunnelStream),
	}
}

func (l *TunnelStreamLease) Tunnel() *gatewayv1.TunnelSummary {
	if l == nil || l.tunnel == nil {
		return nil
	}
	return cloneTunnelSummary(l.tunnel)
}

func (l *TunnelStreamLease) TunnelID() string {
	if l == nil || l.stream == nil {
		return ""
	}
	return l.stream.tunnelID
}

func (l *TunnelStreamLease) StreamID() string {
	if l == nil || l.stream == nil {
		return ""
	}
	return l.stream.streamID
}

func (l *TunnelStreamLease) Frames() <-chan *gatewayv1.TunnelFrame {
	if l == nil || l.stream == nil {
		return nil
	}
	return l.stream.ch
}

func (l *TunnelStreamLease) Done() <-chan struct{} {
	if l == nil || l.stream == nil {
		return nil
	}
	return l.stream.done
}

func (l *TunnelStreamLease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		l.manager.releaseTunnelStream(l.stream)
	})
}

func (s *tunnelStream) close() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		close(s.done)
	})
}

func (s *tunnelStream) send(frame *gatewayv1.TunnelFrame) bool {
	select {
	case <-s.done:
		return false
	case s.ch <- frame:
		return true
	}
}

func (m *Manager) WebTunnelsEnabled() bool {
	m.syncHub.settingsSnapshotMu.RLock()
	defer m.syncHub.settingsSnapshotMu.RUnlock()

	remote, ok := m.syncHub.settingsSnapshot["remote"].(map[string]any)
	if !ok {
		return false
	}
	enabled, ok := remote["enableWebTunnels"].(bool)
	return ok && enabled
}

func (m *Manager) ListTunnels() []*gatewayv1.TunnelSummary {
	now := time.Now()
	online := m.IsOnline()
	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()

	summaries := make([]*gatewayv1.TunnelSummary, 0, len(m.tunnels.tunnelsByID))
	for _, record := range m.tunnels.tunnelsByID {
		if record == nil || record.closed {
			continue
		}
		summaries = append(summaries, tunnelSummaryLocked(record, now, online))
	}
	sortTunnelSummaries(summaries)
	return summaries
}

func (m *Manager) SetTunnelDiagnostics(identifier string, diagnostics []*gatewayv1.TunnelDiagnostic) (*gatewayv1.TunnelSummary, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return nil, ErrTunnelNotFound
	}
	now := time.Now()
	online := m.IsOnline()
	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()

	record := m.tunnels.tunnelsByID[identifier]
	if record == nil {
		if id := m.tunnels.tunnelIDBySlug[identifier]; id != "" {
			record = m.tunnels.tunnelsByID[id]
		}
	}
	if record == nil || record.closed {
		return nil, ErrTunnelNotFound
	}
	record.diagnostics = cloneTunnelDiagnostics(diagnostics)
	return tunnelSummaryLocked(record, now, online), nil
}

func (m *Manager) PrepareTunnelCreate(
	input *gatewayv1.TunnelControlRequest,
	publicBaseURL string,
) (*gatewayv1.TunnelControlRequest, error) {
	if input == nil {
		return nil, errors.New("tunnel create input is required")
	}
	ttlSeconds, err := normalizeTunnelTTL(input.GetTtlSeconds())
	if err != nil {
		return nil, err
	}
	now := time.Now()
	var expiresAt time.Time
	if ttlSeconds > 0 {
		expiresAt = now.Add(time.Duration(ttlSeconds) * time.Second)
	}

	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()

	activeCount := 0
	for _, record := range m.tunnels.tunnelsByID {
		if record == nil || record.closed || isTunnelExpired(record, now) {
			continue
		}
		activeCount += 1
	}
	if activeCount >= MaxTunnelsPerAgent {
		return nil, ErrTunnelLimitExceeded
	}

	id := strings.TrimSpace(input.GetTunnelId())
	if id == "" {
		id = generateTunnelID()
	}
	if _, exists := m.tunnels.tunnelsByID[id]; exists {
		return nil, fmt.Errorf("tunnel id already exists")
	}
	slug := strings.TrimSpace(input.GetSlug())
	if slug == "" {
		for {
			generated, err := generateTunnelSlug()
			if err != nil {
				return nil, err
			}
			if _, exists := m.tunnels.tunnelIDBySlug[generated]; !exists {
				slug = generated
				break
			}
		}
	} else if _, exists := m.tunnels.tunnelIDBySlug[slug]; exists {
		return nil, fmt.Errorf("tunnel slug already exists")
	}

	publicURL := normalizeTunnelPublicURL(input.GetPublicUrl())
	if publicURL == "" {
		publicURL = buildTunnelPublicURL(publicBaseURL, slug)
	}

	return &gatewayv1.TunnelControlRequest{
		Action:         strings.TrimSpace(input.GetAction()),
		TunnelId:       id,
		Slug:           slug,
		TargetUrl:      strings.TrimSpace(input.GetTargetUrl()),
		Name:           strings.TrimSpace(input.GetName()),
		TtlSeconds:     ttlSeconds,
		ExpiresAt:      tunnelUnix(expiresAt),
		PublicUrl:      publicURL,
		PublicBaseUrl:  strings.TrimSpace(publicBaseURL),
		ProjectPathKey: strings.TrimSpace(input.GetProjectPathKey()),
	}, nil
}

func (m *Manager) PrepareTunnelUpdate(
	input *gatewayv1.TunnelControlRequest,
) (*gatewayv1.TunnelControlRequest, error) {
	if input == nil {
		return nil, errors.New("tunnel update input is required")
	}
	ttlSeconds, err := normalizeTunnelTTL(input.GetTtlSeconds())
	if err != nil {
		return nil, err
	}
	now := time.Now()
	var expiresAt time.Time
	if input.GetExpiresAt() > 0 {
		expiresAt = time.Unix(input.GetExpiresAt(), 0)
	} else if ttlSeconds > 0 {
		expiresAt = now.Add(time.Duration(ttlSeconds) * time.Second)
	}
	targetURL := strings.TrimSpace(input.GetTargetUrl())
	if targetURL == "" {
		return nil, errors.New("target_url is required")
	}

	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()

	identifier := strings.TrimSpace(input.GetTunnelId())
	if identifier == "" {
		identifier = strings.TrimSpace(input.GetSlug())
	}
	if identifier == "" {
		return nil, ErrTunnelNotFound
	}
	tunnelID := identifier
	if bySlug := m.tunnels.tunnelIDBySlug[identifier]; bySlug != "" {
		tunnelID = bySlug
	}
	record := m.tunnels.tunnelsByID[tunnelID]
	if record == nil || record.closed {
		return nil, ErrTunnelNotFound
	}
	if isTunnelExpired(record, now) {
		return nil, ErrTunnelExpired
	}
	projectPathKey := strings.TrimSpace(input.GetProjectPathKey())
	if projectPathKey == "" {
		projectPathKey = record.projectPathKey
	}

	return &gatewayv1.TunnelControlRequest{
		Action:         strings.TrimSpace(input.GetAction()),
		TunnelId:       record.id,
		Slug:           record.slug,
		TargetUrl:      targetURL,
		Name:           strings.TrimSpace(input.GetName()),
		TtlSeconds:     ttlSeconds,
		ExpiresAt:      tunnelUnix(expiresAt),
		PublicUrl:      record.publicURL,
		ProjectPathKey: projectPathKey,
	}, nil
}

func (m *Manager) StorePreparedTunnel(
	prepared *gatewayv1.TunnelControlRequest,
	targetURLOverride string,
) (*gatewayv1.TunnelSummary, error) {
	if prepared == nil {
		return nil, errors.New("prepared tunnel is required")
	}
	now := time.Now()
	targetURL := strings.TrimSpace(targetURLOverride)
	if targetURL == "" {
		targetURL = strings.TrimSpace(prepared.GetTargetUrl())
	}
	if targetURL == "" {
		return nil, errors.New("target_url is required")
	}
	var expiresAt time.Time
	if prepared.GetExpiresAt() > 0 {
		expiresAt = time.Unix(prepared.GetExpiresAt(), 0)
	} else if prepared.GetTtlSeconds() > 0 {
		ttlSeconds, err := normalizeTunnelTTL(prepared.GetTtlSeconds())
		if err != nil {
			return nil, err
		}
		expiresAt = now.Add(time.Duration(ttlSeconds) * time.Second)
	}
	record := &tunnelRecord{
		id:             strings.TrimSpace(prepared.GetTunnelId()),
		slug:           strings.TrimSpace(prepared.GetSlug()),
		name:           strings.TrimSpace(prepared.GetName()),
		targetURL:      targetURL,
		publicURL:      normalizeTunnelPublicURL(prepared.GetPublicUrl()),
		projectPathKey: strings.TrimSpace(prepared.GetProjectPathKey()),
		createdAt:      now,
		expiresAt:      expiresAt,
	}
	if record.id == "" || record.slug == "" {
		return nil, errors.New("prepared tunnel is missing id or slug")
	}
	if record.publicURL == "" {
		record.publicURL = buildTunnelPublicURL(prepared.GetPublicBaseUrl(), record.slug)
	}

	online := m.IsOnline()
	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()
	if _, exists := m.tunnels.tunnelsByID[record.id]; exists {
		return nil, fmt.Errorf("tunnel id already exists")
	}
	if _, exists := m.tunnels.tunnelIDBySlug[record.slug]; exists {
		return nil, fmt.Errorf("tunnel slug already exists")
	}
	m.tunnels.tunnelsByID[record.id] = record
	m.tunnels.tunnelIDBySlug[record.slug] = record.id
	return tunnelSummaryLocked(record, now, online), nil
}

func (m *Manager) CreateTunnelFromAgent(
	input *gatewayv1.TunnelControlRequest,
) (*gatewayv1.TunnelSummary, error) {
	prepared, err := m.PrepareTunnelCreate(input, input.GetPublicBaseUrl())
	if err != nil {
		return nil, err
	}
	return m.StorePreparedTunnel(prepared, input.GetTargetUrl())
}

func (m *Manager) UpdateTunnelFromAgent(
	input *gatewayv1.TunnelControlRequest,
) (*gatewayv1.TunnelSummary, error) {
	prepared, err := m.PrepareTunnelUpdate(input)
	if err != nil {
		return nil, err
	}
	return m.ApplyTunnelUpdate(&gatewayv1.TunnelSummary{
		Id:             prepared.GetTunnelId(),
		Slug:           prepared.GetSlug(),
		Name:           prepared.GetName(),
		TargetUrl:      prepared.GetTargetUrl(),
		PublicUrl:      prepared.GetPublicUrl(),
		ExpiresAt:      prepared.GetExpiresAt(),
		ProjectPathKey: prepared.GetProjectPathKey(),
	})
}

func (m *Manager) ApplyTunnelUpdate(summary *gatewayv1.TunnelSummary) (*gatewayv1.TunnelSummary, error) {
	if summary == nil {
		return nil, errors.New("tunnel update summary is required")
	}
	identifier := strings.TrimSpace(summary.GetId())
	if identifier == "" {
		identifier = strings.TrimSpace(summary.GetSlug())
	}
	if identifier == "" {
		return nil, ErrTunnelNotFound
	}
	targetURL := strings.TrimSpace(summary.GetTargetUrl())
	if targetURL == "" {
		return nil, errors.New("target_url is required")
	}
	now := time.Now()
	online := m.IsOnline()
	var expiresAt time.Time
	if summary.GetExpiresAt() > 0 {
		expiresAt = time.Unix(summary.GetExpiresAt(), 0)
	}

	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()

	tunnelID := identifier
	if bySlug := m.tunnels.tunnelIDBySlug[identifier]; bySlug != "" {
		tunnelID = bySlug
	}
	record := m.tunnels.tunnelsByID[tunnelID]
	if record == nil || record.closed {
		return nil, ErrTunnelNotFound
	}
	if isTunnelExpired(record, now) {
		return nil, ErrTunnelExpired
	}
	record.name = strings.TrimSpace(summary.GetName())
	record.targetURL = targetURL
	if publicURL := normalizeTunnelPublicURL(summary.GetPublicUrl()); publicURL != "" {
		record.publicURL = publicURL
	}
	record.projectPathKey = strings.TrimSpace(summary.GetProjectPathKey())
	record.expiresAt = expiresAt
	return tunnelSummaryLocked(record, now, online), nil
}

func (m *Manager) AcquireTunnel(slug string, streamID string) (*TunnelStreamLease, error) {
	slug = strings.TrimSpace(slug)
	streamID = strings.TrimSpace(streamID)
	if slug == "" || streamID == "" {
		return nil, ErrTunnelNotFound
	}
	if !m.IsOnline() {
		return nil, ErrAgentOffline
	}
	now := time.Now()
	online := true

	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()

	tunnelID := m.tunnels.tunnelIDBySlug[slug]
	record := m.tunnels.tunnelsByID[tunnelID]
	if record == nil || record.closed {
		return nil, ErrTunnelNotFound
	}
	if isTunnelExpired(record, now) {
		return nil, ErrTunnelExpired
	}
	if record.activeConnections >= MaxTunnelConnections {
		return nil, ErrTunnelOverLimit
	}
	stream := &tunnelStream{
		streamID: streamID,
		tunnelID: record.id,
		ch:       make(chan *gatewayv1.TunnelFrame, tunnelStreamChannelDepth),
		done:     make(chan struct{}),
	}
	if existing := m.tunnels.streams[streamID]; existing != nil {
		existing.close()
	}
	m.tunnels.streams[streamID] = stream
	record.activeConnections += 1

	return &TunnelStreamLease{
		manager: m,
		stream:  stream,
		tunnel:  tunnelSummaryLocked(record, now, online),
	}, nil
}

func (m *Manager) CloseTunnel(identifier string) (*gatewayv1.TunnelSummary, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return nil, ErrTunnelNotFound
	}
	now := time.Now()
	online := m.IsOnline()

	var summary *gatewayv1.TunnelSummary
	var cancelFrames []*gatewayv1.TunnelFrame
	m.tunnels.mu.Lock()
	tunnelID := identifier
	if bySlug := m.tunnels.tunnelIDBySlug[identifier]; bySlug != "" {
		tunnelID = bySlug
	}
	record := m.tunnels.tunnelsByID[tunnelID]
	if record == nil || record.closed {
		m.tunnels.mu.Unlock()
		return nil, ErrTunnelNotFound
	}
	record.closed = true
	summary = tunnelSummaryLocked(record, now, online)
	delete(m.tunnels.tunnelsByID, record.id)
	delete(m.tunnels.tunnelIDBySlug, record.slug)
	for streamID, stream := range m.tunnels.streams {
		if stream == nil || stream.tunnelID != record.id {
			continue
		}
		delete(m.tunnels.streams, streamID)
		stream.close()
		cancelFrames = append(cancelFrames, &gatewayv1.TunnelFrame{
			StreamId: stream.streamID,
			TunnelId: record.id,
			Slug:     record.slug,
			Kind:     gatewayv1.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
		})
	}
	m.tunnels.mu.Unlock()

	for _, frame := range cancelFrames {
		_ = m.SendTunnelFrameToAgent(frame)
	}
	return summary, nil
}

func (m *Manager) ResumeTunnel(input *gatewayv1.TunnelControlRequest) (*gatewayv1.TunnelSummary, error) {
	if input == nil {
		return nil, errors.New("resume tunnel input is required")
	}
	now := time.Now()
	online := m.IsOnline()
	id := strings.TrimSpace(input.GetTunnelId())
	slug := strings.TrimSpace(input.GetSlug())
	if id == "" && slug == "" {
		return nil, ErrTunnelNotFound
	}

	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()
	if id == "" {
		id = m.tunnels.tunnelIDBySlug[slug]
	}
	record := m.tunnels.tunnelsByID[id]
	if record == nil || record.closed {
		return nil, ErrTunnelNotFound
	}
	if slug != "" && record.slug != slug {
		return nil, ErrTunnelNotFound
	}
	if isTunnelExpired(record, now) {
		return nil, ErrTunnelExpired
	}
	if targetURL := strings.TrimSpace(input.GetTargetUrl()); targetURL != "" {
		record.targetURL = targetURL
	}
	if name := strings.TrimSpace(input.GetName()); name != "" {
		record.name = name
	}
	if projectPathKey := strings.TrimSpace(input.GetProjectPathKey()); projectPathKey != "" {
		record.projectPathKey = projectPathKey
	}
	return tunnelSummaryLocked(record, now, online), nil
}

func (m *Manager) SendTunnelFrameToAgent(frame *gatewayv1.TunnelFrame) error {
	if frame == nil {
		return errors.New("tunnel frame is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), tunnelAgentSendTimeout)
	defer cancel()
	return m.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{
		RequestId: fmt.Sprintf("tunnel-frame-%s", strings.TrimSpace(frame.GetStreamId())),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_TunnelFrame{
			TunnelFrame: frame,
		},
	})
}

func (m *Manager) dispatchTunnelFrame(frame *gatewayv1.TunnelFrame) {
	if frame == nil {
		return
	}
	streamID := strings.TrimSpace(frame.GetStreamId())
	if streamID == "" {
		return
	}
	m.tunnels.mu.Lock()
	stream := m.tunnels.streams[streamID]
	m.tunnels.mu.Unlock()
	if stream == nil {
		return
	}
	stream.send(frame)
}

func (m *Manager) handleAgentTunnelControl(
	session *AgentSession,
	requestID string,
	request *gatewayv1.TunnelControlRequest,
) {
	if session == nil || request == nil {
		return
	}
	response := m.handleAgentTunnelControlInner(request)
	ctx, cancel := context.WithTimeout(context.Background(), tunnelAgentSendTimeout)
	defer cancel()
	_ = session.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_TunnelControlResp{
			TunnelControlResp: response,
		},
	})
}

func (m *Manager) handleAgentTunnelControlInner(
	request *gatewayv1.TunnelControlRequest,
) *gatewayv1.TunnelControlResponse {
	action := strings.ToLower(strings.TrimSpace(request.GetAction()))
	if action == "" {
		return tunnelControlError("invalid_action", "tunnel action is required")
	}
	switch action {
	case "list":
		return &gatewayv1.TunnelControlResponse{
			Action:  action,
			Tunnels: m.ListTunnels(),
		}
	case "create":
		tunnel, err := m.CreateTunnelFromAgent(request)
		if err != nil {
			return tunnelControlErrorFor(action, err)
		}
		return &gatewayv1.TunnelControlResponse{
			Action:  action,
			Tunnel:  tunnel,
			Tunnels: m.ListTunnels(),
		}
	case "update":
		tunnel, err := m.UpdateTunnelFromAgent(request)
		if err != nil {
			return tunnelControlErrorFor(action, err)
		}
		return &gatewayv1.TunnelControlResponse{
			Action:  action,
			Tunnel:  tunnel,
			Tunnels: m.ListTunnels(),
		}
	case "probe":
		identifier := request.GetTunnelId()
		if strings.TrimSpace(identifier) == "" {
			identifier = request.GetSlug()
		}
		tunnel, err := m.ProbeTunnel(context.Background(), identifier, request.GetPublicBaseUrl())
		if err != nil {
			return tunnelControlErrorFor(action, err)
		}
		return &gatewayv1.TunnelControlResponse{
			Action:  action,
			Tunnel:  tunnel,
			Tunnels: m.ListTunnels(),
		}
	case "close":
		identifier := request.GetTunnelId()
		if strings.TrimSpace(identifier) == "" {
			identifier = request.GetSlug()
		}
		tunnel, err := m.CloseTunnel(identifier)
		if err != nil {
			return tunnelControlErrorFor(action, err)
		}
		return &gatewayv1.TunnelControlResponse{
			Action:  action,
			Tunnel:  tunnel,
			Tunnels: m.ListTunnels(),
		}
	case "resume":
		tunnel, err := m.ResumeTunnel(request)
		if err != nil {
			return tunnelControlErrorFor(action, err)
		}
		return &gatewayv1.TunnelControlResponse{
			Action:  action,
			Tunnel:  tunnel,
			Tunnels: m.ListTunnels(),
		}
	default:
		return tunnelControlError("invalid_action", "unsupported tunnel action")
	}
}

func (m *Manager) releaseTunnelStream(stream *tunnelStream) {
	if stream == nil {
		return
	}
	m.tunnels.mu.Lock()
	if existing := m.tunnels.streams[stream.streamID]; existing == stream {
		delete(m.tunnels.streams, stream.streamID)
	}
	if record := m.tunnels.tunnelsByID[stream.tunnelID]; record != nil && record.activeConnections > 0 {
		record.activeConnections -= 1
	}
	stream.close()
	m.tunnels.mu.Unlock()
}

func normalizeTunnelTTL(input uint32) (uint32, error) {
	switch input {
	case 0:
		return 0, nil
	case 900, 3600, 14400:
		return input, nil
	default:
		return 0, errors.New("ttl_seconds must be one of 0, 900, 3600, or 14400")
	}
}

func tunnelUnix(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.Unix()
}

func generateTunnelID() string {
	return "tun_" + strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "") + "_" + randomURLToken(8)
}

func generateTunnelSlug() (string, error) {
	token := randomURLToken(tunnelSlugEntropyBytes)
	if token == "" {
		return "", errors.New("generate tunnel slug failed")
	}
	return token, nil
}

func randomURLToken(byteCount int) string {
	if byteCount <= 0 {
		return ""
	}
	buf := make([]byte, byteCount)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func normalizeTunnelPublicURL(input string) string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	if !strings.HasSuffix(parsed.Path, "/") {
		parsed.Path += "/"
	}
	return parsed.String()
}

func buildTunnelPublicURL(publicBaseURL string, slug string) string {
	base := strings.TrimSpace(publicBaseURL)
	if base == "" || strings.TrimSpace(slug) == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/t/" + strings.TrimSpace(slug) + "/"
	return parsed.String()
}

func isTunnelExpired(record *tunnelRecord, now time.Time) bool {
	return record == nil || (!record.expiresAt.IsZero() && !record.expiresAt.After(now))
}

func tunnelSummaryLocked(record *tunnelRecord, now time.Time, online bool) *gatewayv1.TunnelSummary {
	if record == nil {
		return &gatewayv1.TunnelSummary{Status: "expired"}
	}
	status := "active"
	if record.closed || isTunnelExpired(record, now) {
		status = "expired"
	} else if !online {
		status = "offline"
	}
	activeConnections := uint32(0)
	if record.activeConnections > 0 {
		activeConnections = uint32(record.activeConnections)
	}
	return &gatewayv1.TunnelSummary{
		Id:                record.id,
		Slug:              record.slug,
		Name:              record.name,
		TargetUrl:         record.targetURL,
		PublicUrl:         record.publicURL,
		CreatedAt:         record.createdAt.Unix(),
		ExpiresAt:         tunnelUnix(record.expiresAt),
		ActiveConnections: activeConnections,
		Status:            status,
		ProjectPathKey:    record.projectPathKey,
		Diagnostics:       cloneTunnelDiagnostics(record.diagnostics),
	}
}

func cloneTunnelSummary(summary *gatewayv1.TunnelSummary) *gatewayv1.TunnelSummary {
	if summary == nil {
		return nil
	}
	return &gatewayv1.TunnelSummary{
		Id:                summary.GetId(),
		Slug:              summary.GetSlug(),
		Name:              summary.GetName(),
		TargetUrl:         summary.GetTargetUrl(),
		PublicUrl:         summary.GetPublicUrl(),
		CreatedAt:         summary.GetCreatedAt(),
		ExpiresAt:         summary.GetExpiresAt(),
		ActiveConnections: summary.GetActiveConnections(),
		Status:            summary.GetStatus(),
		ProjectPathKey:    strings.TrimSpace(summary.GetProjectPathKey()),
		Diagnostics:       cloneTunnelDiagnostics(summary.GetDiagnostics()),
	}
}

func cloneTunnelDiagnostics(input []*gatewayv1.TunnelDiagnostic) []*gatewayv1.TunnelDiagnostic {
	if len(input) == 0 {
		return nil
	}
	out := make([]*gatewayv1.TunnelDiagnostic, 0, len(input))
	for _, item := range input {
		if item == nil {
			continue
		}
		out = append(out, &gatewayv1.TunnelDiagnostic{
			Protocol:   strings.TrimSpace(item.GetProtocol()),
			Status:     strings.TrimSpace(item.GetStatus()),
			StatusCode: item.GetStatusCode(),
			ErrorCode:  strings.TrimSpace(item.GetErrorCode()),
			Message:    strings.TrimSpace(item.GetMessage()),
			CheckedAt:  item.GetCheckedAt(),
		})
	}
	return out
}

func sortTunnelSummaries(summaries []*gatewayv1.TunnelSummary) {
	for i := 1; i < len(summaries); i++ {
		current := summaries[i]
		j := i - 1
		for j >= 0 && summaries[j].GetCreatedAt() > current.GetCreatedAt() {
			summaries[j+1] = summaries[j]
			j--
		}
		summaries[j+1] = current
	}
}

func tunnelControlError(code string, message string) *gatewayv1.TunnelControlResponse {
	return &gatewayv1.TunnelControlResponse{
		ErrorCode:    strings.TrimSpace(code),
		ErrorMessage: strings.TrimSpace(message),
	}
}

func tunnelControlErrorFor(action string, err error) *gatewayv1.TunnelControlResponse {
	code := "failed"
	switch {
	case errors.Is(err, ErrTunnelNotFound):
		code = "not_found"
	case errors.Is(err, ErrTunnelExpired):
		code = "expired"
	case errors.Is(err, ErrTunnelLimitExceeded):
		code = "limit_exceeded"
	case errors.Is(err, ErrTunnelOverLimit):
		code = "over_limit"
	case errors.Is(err, ErrAgentOffline):
		code = "agent_offline"
	}
	return &gatewayv1.TunnelControlResponse{
		Action:       strings.TrimSpace(action),
		ErrorCode:    code,
		ErrorMessage: err.Error(),
	}
}
