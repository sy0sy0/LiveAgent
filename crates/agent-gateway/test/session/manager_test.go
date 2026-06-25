package session_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newTestSessionManager() *session.Manager {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	return sm
}

func startRunningChatCommandRun(
	t *testing.T,
	sm *session.Manager,
	requestID string,
	conversationID string,
) session.ChatRunSnapshot {
	t.Helper()
	snapshot, created, err := sm.StartPendingChatCommandRun(requestID, conversationID, "")
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun: %v", err)
	}
	if !created {
		t.Fatalf("StartPendingChatCommandRun created = false for %q", requestID)
	}
	dispatchChatControl(sm, requestID, conversationID, "started", session.ChatRunStateRunning)
	if next, ok := sm.ChatRunSnapshot(requestID, conversationID); ok {
		return next
	}
	return snapshot
}

func activeChatRunConversationIDs(sm *session.Manager) []string {
	summaries := sm.ActiveChatRunSummaries()
	ids := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		if summary.ConversationID != "" {
			ids = append(ids, summary.ConversationID)
		}
	}
	return ids
}

func dispatchChatControl(
	sm *session.Manager,
	requestID string,
	conversationID string,
	controlType string,
	state string,
) {
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: requestID,
		Payload: &gatewayv1.AgentEnvelope_ChatControl{
			ChatControl: &gatewayv1.ChatControlEvent{
				RequestId:      requestID,
				ConversationId: conversationID,
				Type:           controlType,
				State:          state,
			},
		},
	})
}

func assertDoneClosed(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for session done to close")
	}
}

func assertDoneOpen(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Fatalf("session done is closed")
	default:
	}
}

func TestClearSessionDoesNotCloseReplacement(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(first)
	second := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(second)

	assertDoneClosed(t, first.Done())
	assertDoneOpen(t, second.Done())

	sm.ClearSession(first)
	if status := sm.Status(); !status.Online {
		t.Fatalf("status online = false after clearing stale session")
	}
	assertDoneOpen(t, second.Done())

	env := &gatewayv1.GatewayEnvelope{RequestId: "still-current"}
	if err := sm.SendToAgent(env); err != nil {
		t.Fatalf("SendToAgent after stale ClearSession: %v", err)
	}
	select {
	case got := <-second.Outbound():
		if got.GetRequestId() != "still-current" {
			t.Fatalf("request id = %q, want still-current", got.GetRequestId())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for current session outbound message")
	}

	sm.ClearSession(second)
	assertDoneClosed(t, second.Done())
	if status := sm.Status(); status.Online {
		t.Fatalf("status online = true after clearing current session")
	}
	if err := sm.SendToAgent(env); !errors.Is(err, session.ErrAgentOffline) {
		t.Fatalf("SendToAgent after clearing current session = %v, want ErrAgentOffline", err)
	}
}

func TestClearSessionIfHeartbeatStaleClosesOnlyCurrentSession(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(first)
	second := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(second)

	time.Sleep(time.Millisecond)
	if sm.ClearSessionIfHeartbeatStale(first, time.Nanosecond) {
		t.Fatalf("stale first session should not close replacement session")
	}
	assertDoneOpen(t, second.Done())
	if status := sm.Status(); !status.Online {
		t.Fatalf("status online = false after stale old-session heartbeat timeout")
	}

	time.Sleep(time.Millisecond)
	if !sm.ClearSessionIfHeartbeatStale(second, time.Nanosecond) {
		t.Fatalf("current stale session was not cleared")
	}
	assertDoneClosed(t, second.Done())
	if status := sm.Status(); status.Online {
		t.Fatalf("status online = true after current session heartbeat timeout")
	}
	if err := sm.SendToAgent(&gatewayv1.GatewayEnvelope{RequestId: "after-timeout"}); !errors.Is(err, session.ErrAgentOffline) {
		t.Fatalf("SendToAgent after heartbeat timeout = %v, want ErrAgentOffline", err)
	}
}

func TestChatRuntimeReadyRequiresFreshRuntimeHeartbeat(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)

	if status := sm.Status(); !status.Online || status.ChatRuntimeReady {
		t.Fatalf("initial status = %#v, want online without chat runtime readiness", status)
	}

	sm.UpdateRuntimeStatus(sess, &gatewayv1.RuntimeStatusEvent{
		WorkerId:       "runtime-1",
		State:          "ready",
		Visible:        true,
		ActiveRunCount: 0,
		Timestamp:      time.Now().Unix(),
	})
	if status := sm.Status(); !status.ChatRuntimeReady ||
		status.RuntimeState != "ready" ||
		status.RuntimeWorkerID != "runtime-1" ||
		status.RuntimeLastHeartbeat == 0 {
		t.Fatalf("ready runtime status = %#v", status)
	}

	sm.UpdateRuntimeStatus(sess, &gatewayv1.RuntimeStatusEvent{
		WorkerId:  "runtime-1",
		State:     "suspended",
		Timestamp: time.Now().Unix(),
	})
	if status := sm.Status(); status.ChatRuntimeReady || status.RuntimeState != "suspended" {
		t.Fatalf("suspended runtime status = %#v, want not ready", status)
	}

	sm.UpdateRuntimeStatus(sess, &gatewayv1.RuntimeStatusEvent{
		WorkerId:  "runtime-1",
		State:     "busy",
		Timestamp: time.Now().Unix(),
	})
	if !sm.ChatRuntimeReady() {
		t.Fatalf("busy runtime should be ready to manage chat runs")
	}

	sm.ClearSession(sess)
	if status := sm.Status(); status.ChatRuntimeReady || status.RuntimeState != "" {
		t.Fatalf("cleared session status = %#v, want runtime readiness reset", status)
	}
}

func TestChatRunSeqContinuesWithinConversation(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	if _, created, err := sm.StartPendingChatCommandRun("request-1", "conversation-1", "client-1"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-1 created=%v err=%v", created, err)
	}
	sm.MarkChatRunControl("request-1", "conversation-1", "accepted", "", "")
	sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
		"type":    "user_message",
		"message": "first",
	})
	sm.MarkChatRunControl("request-1", "conversation-1", "completed", "", "")
	if snapshot, ok := sm.ChatRunSnapshot("request-1", "conversation-1"); !ok || snapshot.LatestSeq != 3 {
		t.Fatalf("first snapshot = %#v ok=%v, want latest seq 3", snapshot, ok)
	}

	next, created, err := sm.StartPendingChatCommandRun("request-2", "conversation-1", "client-2")
	if err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-2 created=%v err=%v", created, err)
	}
	if next.LatestSeq != 3 {
		t.Fatalf("second run initial snapshot = %#v, want latest seq 3", next)
	}
	sm.MarkChatRunControl("request-2", "conversation-1", "accepted", "", "")
	if snapshot, ok := sm.ChatRunSnapshot("request-2", "conversation-1"); !ok || snapshot.LatestSeq != 4 {
		t.Fatalf("second snapshot = %#v ok=%v, want latest seq 4", snapshot, ok)
	}

	ch, _, cleanup, replaySnapshot, err := sm.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun conversation replay: %v", err)
	}
	defer cleanup()
	if replaySnapshot.RequestID != "request-2" || replaySnapshot.LatestSeq != 4 {
		t.Fatalf("conversation replay snapshot = %#v, want latest run request-2 seq 4", replaySnapshot)
	}
	got := make([]string, 0, 4)
	for len(got) < 4 {
		select {
		case event := <-ch:
			eventType := ""
			if event.Control != nil {
				eventType = event.Control.GetType()
			} else if event.Payload != nil {
				eventType, _ = event.Payload["type"].(string)
			}
			got = append(got, fmt.Sprintf("%s:%d:%s", event.RequestID, event.Seq, eventType))
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for conversation replay, got %#v", got)
		}
	}
	want := []string{
		"request-1:1:accepted",
		"request-1:2:user_message",
		"request-1:3:completed",
		"request-2:4:accepted",
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("conversation replay = %#v, want %#v", got, want)
		}
	}
}

func TestSubscribeChatRunConversationReplayAttachesLatestLiveRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, created, err := sm.StartPendingChatCommandRun("request-1", "conversation-1", "client-1"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-1 created=%v err=%v", created, err)
	}
	sm.MarkChatRunControl("request-1", "conversation-1", "accepted", "", "")
	sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
		"type":    "user_message",
		"message": "first",
	})
	sm.MarkChatRunControl("request-1", "conversation-1", "completed", "", "")
	if _, created, err := sm.StartPendingChatCommandRun("request-2", "conversation-1", "client-2"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-2 created=%v err=%v", created, err)
	}
	sm.MarkChatRunControl("request-2", "conversation-1", "accepted", "", "")

	ch, done, cleanup, replaySnapshot, err := sm.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun conversation replay: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)
	if replaySnapshot.RequestID != "request-2" || replaySnapshot.LatestSeq != 4 {
		t.Fatalf("conversation replay snapshot = %#v, want live request-2 seq 4", replaySnapshot)
	}

	got := make([]string, 0, 4)
	for len(got) < 4 {
		select {
		case event := <-ch:
			eventType := ""
			if event.Control != nil {
				eventType = event.Control.GetType()
			} else if event.Payload != nil {
				eventType, _ = event.Payload["type"].(string)
			}
			got = append(got, fmt.Sprintf("%s:%d:%s", event.RequestID, event.Seq, eventType))
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for conversation replay, got %#v", got)
		}
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-2",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"second"}`,
			},
		},
	})
	select {
	case event := <-ch:
		if event.RequestID != "request-2" || event.Seq != 5 || event.Event == nil || event.Event.GetType() != gatewayv1.ChatEvent_TOKEN {
			t.Fatalf("live event after replay = %#v, want request-2 token seq 5", event)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for live event after conversation replay, got %#v", got)
	}
}

type blockingAppendChatEventStore struct {
	mu            sync.Mutex
	appendCalls   int
	appendEntered chan struct{}
	releaseFirst  chan struct{}
}

func newBlockingAppendChatEventStore() *blockingAppendChatEventStore {
	return &blockingAppendChatEventStore{
		appendEntered: make(chan struct{}),
		releaseFirst:  make(chan struct{}),
	}
}

func (s *blockingAppendChatEventStore) StartRun(input session.ChatRunStoreStart) (session.ChatRunSnapshot, bool, error) {
	return session.ChatRunSnapshot{
		RequestID:       input.RequestID,
		ConversationID:  input.ConversationID,
		ClientRequestID: input.ClientRequestID,
		Workdir:         input.Workdir,
		RunEpoch:        1,
		State:           session.ChatRunStateQueued,
	}, true, nil
}

func (s *blockingAppendChatEventStore) AppendEvents(inputs []session.ChatRunEventAppend) error {
	if len(inputs) == 0 {
		return nil
	}
	s.mu.Lock()
	s.appendCalls += 1
	call := s.appendCalls
	s.mu.Unlock()
	if call == 1 {
		close(s.appendEntered)
		<-s.releaseFirst
	}
	return nil
}

func (s *blockingAppendChatEventStore) Replay(string, string, int64, int) (session.ChatRunSnapshot, []*session.ChatBroadcastEvent, bool, error) {
	return session.ChatRunSnapshot{}, nil, false, nil
}

func (s *blockingAppendChatEventStore) Close() error {
	return nil
}

func TestChatEventStoreAppendDoesNotHoldChatLock(t *testing.T) {
	t.Parallel()

	store := newBlockingAppendChatEventStore()
	sm, err := session.NewManagerWithChatEventStore(store)
	if err != nil {
		t.Fatalf("NewManagerWithChatEventStore: %v", err)
	}
	if _, created, err := sm.StartPendingChatCommandRun("request-1", "conversation-1", "client-1"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun created=%v err=%v", created, err)
	}

	firstDone := make(chan struct{})
	go func() {
		sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
			"type":    "user_message",
			"message": "first",
		})
		close(firstDone)
	}()

	select {
	case <-store.appendEntered:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first append to block")
	}

	secondDone := make(chan struct{})
	go func() {
		sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
			"type":    "projection_updated",
			"message": "second",
		})
		close(secondDone)
	}()

	select {
	case <-secondDone:
	case <-time.After(time.Second):
		t.Fatal("second chat payload blocked behind event store append")
	}

	snapshot, ok := sm.ChatRunSnapshot("request-1", "conversation-1")
	if !ok || snapshot.LatestSeq != 2 {
		t.Fatalf("snapshot = %#v ok=%v, want latest seq 2 while first append is still blocked", snapshot, ok)
	}

	close(store.releaseFirst)
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first append to finish")
	}
}

func TestStartAcceptedChatCommandUsesInMemoryConversationSeqDuringPersistLag(t *testing.T) {
	t.Parallel()

	store := newBlockingAppendChatEventStore()
	sm, err := session.NewManagerWithChatEventStore(store)
	if err != nil {
		t.Fatalf("NewManagerWithChatEventStore: %v", err)
	}
	if _, created, err := sm.StartPendingChatCommandRun("request-1", "conversation-1", "client-1"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-1 created=%v err=%v", created, err)
	}

	firstDone := make(chan struct{})
	go func() {
		sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
			"type":    "user_message",
			"message": "first",
		})
		close(firstDone)
	}()

	select {
	case <-store.appendEntered:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first append to block")
	}

	next, created, acceptedSeq, err := sm.StartAcceptedChatCommandRun(
		"request-2",
		"conversation-1",
		"client-2",
		"",
		nil,
	)
	if err != nil || !created {
		t.Fatalf("StartAcceptedChatCommandRun request-2 created=%v err=%v", created, err)
	}
	if acceptedSeq != 2 || next.LatestSeq != 2 {
		t.Fatalf("second run snapshot = %#v acceptedSeq=%d, want seq 2", next, acceptedSeq)
	}

	close(store.releaseFirst)
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first append to finish")
	}
}

func TestClearSessionIfHeartbeatStalePreservesOpenChatRuns(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)
	if _, _, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil {
		t.Fatalf("StartPendingChatCommandRun: %v", err)
	}
	ch, done, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	time.Sleep(time.Millisecond)
	if !sm.ClearSessionIfHeartbeatStale(sess, time.Nanosecond) {
		t.Fatalf("current stale session was not cleared")
	}
	assertDoneOpen(t, done)
	select {
	case event := <-ch:
		t.Fatalf("unexpected chat event after heartbeat timeout: %#v", event)
	default:
	}
	got := activeChatRunConversationIDs(sm)
	want := []string{"conversation-1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("active chat runs after heartbeat timeout = %#v, want %#v", got, want)
	}
}

func TestDispatchFromStaleSessionIsIgnored(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(first)
	second := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(second)

	ch, done, cleanup, err := sm.RegisterStream("request-1")
	if err != nil {
		t.Fatalf("RegisterStream: %v", err)
	}
	defer cleanup()

	staleEnv := &gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_Error{
			Error: &gatewayv1.ErrorResponse{Code: 500, Message: "stale"},
		},
	}
	sm.DispatchFromAgentForSession(first, staleEnv)
	select {
	case got := <-ch:
		t.Fatalf("received stale session envelope: %#v", got)
	case <-done:
		t.Fatalf("stream closed while current session is still active")
	case <-time.After(50 * time.Millisecond):
	}

	currentEnv := &gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_Error{
			Error: &gatewayv1.ErrorResponse{Code: 500, Message: "current"},
		},
	}
	sm.DispatchFromAgentForSession(second, currentEnv)
	select {
	case got := <-ch:
		if got.GetError().GetMessage() != "current" {
			t.Fatalf("error message = %q, want current", got.GetError().GetMessage())
		}
	case <-done:
		t.Fatalf("stream closed before current session dispatch")
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for current session envelope")
	}
}

func TestSendToAgentUnblocksWhenSessionCloses(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)

	errCh := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				errCh <- fmt.Errorf("panic: %v", recovered)
			}
		}()
		for i := 0; i < 128; i += 1 {
			_ = sm.SendToAgent(&gatewayv1.GatewayEnvelope{RequestId: fmt.Sprintf("request-%d", i)})
		}
		errCh <- nil
	}()

	time.Sleep(10 * time.Millisecond)
	sm.ClearSession(sess)

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatalf("SendToAgent did not unblock after session close")
	}
}

func TestSendToAgentContextReturnsWhenOutboundQueueIsFull(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)

	for i := 0; i < 64; i += 1 {
		if err := sm.SendToAgent(&gatewayv1.GatewayEnvelope{RequestId: fmt.Sprintf("queued-%d", i)}); err != nil {
			t.Fatalf("prime outbound queue: %v", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	err := sm.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{RequestId: "blocked"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SendToAgentContext with full queue = %v, want context deadline exceeded", err)
	}
	if status := sm.Status(); status.Online {
		t.Fatalf("status online = true after SendToAgentContext timeout")
	}
}

func TestRemoveChatRunByConversationReleasesBufferedRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	startRunningChatCommandRun(t, sm, "request-1", "conversation-1")

	ch, done, cleanup, snapshot, err := sm.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun before remove: %v", err)
	}
	if snapshot.RequestID != "request-1" {
		t.Fatalf("snapshot request id = %q, want request-1", snapshot.RequestID)
	}

	sm.RemoveChatRunByConversation("conversation-1")
	assertDoneClosed(t, done)
	cleanup()
	select {
	case event := <-ch:
		t.Fatalf("unexpected replay event after remove: %#v", event)
	default:
	}

	_, missingDone, missingCleanup, _, err := sm.SubscribeChatRun("", "conversation-1", 0)
	defer missingCleanup()
	assertDoneClosed(t, missingDone)
	if !errors.Is(err, session.ErrChatRunNotFound) {
		t.Fatalf("SubscribeChatRun after remove = %v, want ErrChatRunNotFound", err)
	}
}

func TestStartPendingChatCommandRunReusesExistingRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first, created, err := sm.StartPendingChatCommandRun(
		"request-1",
		"",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun first: %v", err)
	}
	if !created {
		t.Fatalf("first run created = false, want true")
	}
	if first.RequestID != "request-1" {
		t.Fatalf("first request id = %q, want request-1", first.RequestID)
	}
	if first.ClientRequestID != "client-submit-1" {
		t.Fatalf("first client request id = %q, want client-submit-1", first.ClientRequestID)
	}

	duplicate, created, err := sm.StartPendingChatCommandRun(
		"request-2",
		"",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun duplicate: %v", err)
	}
	if created {
		t.Fatalf("duplicate run created = true, want false")
	}
	if duplicate.RequestID != "request-1" {
		t.Fatalf("duplicate request id = %q, want original request-1", duplicate.RequestID)
	}

	_, missingDone, missingCleanup, _, err := sm.SubscribeChatRun("request-2", "", 0)
	defer missingCleanup()
	assertDoneClosed(t, missingDone)
	if !errors.Is(err, session.ErrChatRunNotFound) {
		t.Fatalf("SubscribeChatRun duplicate request = %v, want ErrChatRunNotFound", err)
	}

	sm.RemoveChatRun("request-1")
	restarted, created, err := sm.StartPendingChatCommandRun(
		"request-3",
		"",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun after remove: %v", err)
	}
	if !created {
		t.Fatalf("restarted run created = false, want true")
	}
	if restarted.RequestID != "request-3" {
		t.Fatalf("restarted request id = %q, want request-3", restarted.RequestID)
	}
}

func TestPendingChatRunIsAdvertisedBeforeStartedEvent(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	snapshot, created, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
		"/workspace",
	)
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun: %v", err)
	}
	if !created || snapshot.RequestID != "request-1" {
		t.Fatalf("pending run = %#v created=%v", snapshot, created)
	}
	if got := activeChatRunConversationIDs(sm); fmt.Sprint(got) != fmt.Sprint([]string{"conversation-1"}) {
		t.Fatalf("pending active chat runs = %#v, want conversation-1", got)
	}

	ch, _, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	dispatchChatControl(sm, "request-1", "conversation-1", "delivered", session.ChatRunStateDelivered)
	if got := activeChatRunConversationIDs(sm); fmt.Sprint(got) != fmt.Sprint([]string{"conversation-1"}) {
		t.Fatalf("delivered active chat runs = %#v, want conversation-1", got)
	}
	if sm.FailStartingChatRun("request-1", "desktop did not accept") {
		t.Fatalf("accepted pending run should not fail the accept watchdog")
	}

	dispatchChatControl(sm, "request-1", "conversation-1", "started", session.ChatRunStateRunning)

	got := activeChatRunConversationIDs(sm)
	want := []string{"conversation-1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("active chat runs after started = %#v, want %#v", got, want)
	}
	select {
	case event := <-ch:
		if event.Control == nil || event.Control.GetType() != "delivered" {
			t.Fatalf("first control event = %#v, want delivered", event)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for delivered control event")
	}
	select {
	case event := <-ch:
		if event.Control == nil || event.Control.GetType() != "started" {
			t.Fatalf("second control event = %#v, want started", event)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for started control event")
	}
}

func TestFailStartingChatRunBroadcastsErrorAndClearsActiveSummary(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, _, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil {
		t.Fatalf("StartPendingChatCommandRun: %v", err)
	}
	ch, _, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	if !sm.FailStartingChatRun("request-1", "desktop did not accept") {
		t.Fatalf("FailStartingChatRun returned false")
	}

	select {
	case event := <-ch:
		if event.Event.GetType() != gatewayv1.ChatEvent_ERROR {
			t.Fatalf("event type = %v, want ERROR", event.Event.GetType())
		}
		if !strings.Contains(event.Event.GetData(), "desktop did not accept") {
			t.Fatalf("event data = %q", event.Event.GetData())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for starting run failure event")
	}
	if got := activeChatRunConversationIDs(sm); len(got) != 0 {
		t.Fatalf("active chat runs after failed start = %#v, want empty", got)
	}
	if status := sm.Status(); status.Online {
		t.Fatalf("status online = true after chat run failed before desktop accept")
	}
}

func TestFailUnstartedChatRunBroadcastsErrorUnlessStarted(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, _, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil {
		t.Fatalf("StartPendingChatCommandRun request-1: %v", err)
	}
	ch, _, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	if sm.FailUnstartedChatRun("request-1", "desktop app did not start") {
		t.Fatalf("unaccepted pending run should not fail the render-start watchdog")
	}
	dispatchChatControl(sm, "request-1", "conversation-1", "delivered", session.ChatRunStateDelivered)

	if !sm.FailUnstartedChatRun("request-1", "desktop app did not start") {
		t.Fatalf("FailUnstartedChatRun returned false for accepted pending run")
	}
	select {
	case event := <-ch:
		if event.Control == nil || event.Control.GetType() != "delivered" {
			t.Fatalf("event = %#v, want delivered control", event)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for delivered control event")
	}
	select {
	case event := <-ch:
		if event.Event == nil || event.Event.GetType() != gatewayv1.ChatEvent_ERROR {
			t.Fatalf("event = %#v, want ERROR", event)
		}
		if !strings.Contains(event.Event.GetData(), "desktop app did not start") {
			t.Fatalf("event data = %q", event.Event.GetData())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for unstarted run failure event")
	}

	if _, _, err := sm.StartPendingChatCommandRun(
		"request-2",
		"conversation-2",
		"client-submit-2",
	); err != nil {
		t.Fatalf("StartPendingChatCommandRun request-2: %v", err)
	}
	dispatchChatControl(sm, "request-2", "conversation-2", "started", session.ChatRunStateRunning)
	if sm.FailUnstartedChatRun("request-2", "desktop app did not start") {
		t.Fatalf("started run should not fail the render-start watchdog")
	}
}

func TestTerminalChatRunStateIsImmutable(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, _, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil {
		t.Fatalf("StartPendingChatCommandRun: %v", err)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_ERROR,
				ConversationId: "conversation-1",
				Data:           `{"message":"startup failed"}`,
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatControl{
			ChatControl: &gatewayv1.ChatControlEvent{
				Type:           "completed",
				State:          session.ChatRunStateCompleted,
				RequestId:      "request-1",
				ConversationId: "conversation-1",
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"late token"}`,
			},
		},
	})

	ch, done, cleanup, snapshot, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)
	if snapshot.State != session.ChatRunStateFailed {
		t.Fatalf("terminal state = %q, want %q", snapshot.State, session.ChatRunStateFailed)
	}

	select {
	case event := <-ch:
		if event.Event == nil || event.Event.GetType() != gatewayv1.ChatEvent_ERROR {
			t.Fatalf("replayed event = %#v, want ERROR", event)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for replayed error event")
	}
	select {
	case event := <-ch:
		t.Fatalf("terminal completion control should be ignored after failure: %#v", event)
	default:
	}
}

func TestDesktopBroadcastChatEventCreatesAttachableRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "desktop-run-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"hello"}`,
			},
		},
	})

	ch, done, cleanup, snapshot, err := sm.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)
	if snapshot.RequestID != "desktop-run-1" {
		t.Fatalf("snapshot request id = %q, want desktop-run-1", snapshot.RequestID)
	}

	select {
	case event := <-ch:
		if event.Seq != 1 {
			t.Fatalf("event seq = %d, want 1", event.Seq)
		}
		if event.Event.GetType() != gatewayv1.ChatEvent_TOKEN {
			t.Fatalf("event type = %v, want TOKEN", event.Event.GetType())
		}
		if event.Event.GetConversationId() != "conversation-1" {
			t.Fatalf("conversation id = %q, want conversation-1", event.Event.GetConversationId())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for replayed desktop chat event")
	}
}

func TestChatRuntimeSnapshotCreatesAttachableConversationRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "runtime-snapshot-1",
		Payload: &gatewayv1.AgentEnvelope_ChatRuntimeSnapshot{
			ChatRuntimeSnapshot: &gatewayv1.ChatRuntimeSnapshot{
				ConversationId:         "conversation-1",
				RunId:                  "run-1",
				ClientRequestId:        "client-1",
				WorkerId:               "gui-live",
				State:                  session.ChatRunStateRunning,
				Cwd:                    "/workspace",
				Revision:               1,
				EntriesJson:            `[{"id":"u1","kind":"user","text":"hello","attachments":[]},{"id":"a1","kind":"assistant","text":"partial","round":1}]`,
				ToolStatus:             "Thinking...",
				ToolStatusIsCompaction: false,
			},
		},
	})

	summaries := sm.ActiveChatRunSummaries()
	if len(summaries) != 1 ||
		summaries[0].ConversationID != "conversation-1" ||
		summaries[0].RequestID != "run-1" ||
		summaries[0].Workdir != "/workspace" {
		t.Fatalf("active summaries = %#v, want snapshot-backed run-1", summaries)
	}

	ch, done, cleanup, snapshot, err := sm.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)
	if snapshot.RequestID != "run-1" || snapshot.State != session.ChatRunStateRunning || snapshot.Done {
		t.Fatalf("snapshot = %#v, want running run-1", snapshot)
	}

	select {
	case event := <-ch:
		if event.RequestID != "run-1" || event.Seq != 1 {
			t.Fatalf("runtime snapshot event = %#v, want run-1 seq 1", event)
		}
		eventType, _ := event.Payload["type"].(string)
		if eventType != "runtime_snapshot" {
			t.Fatalf("payload type = %q, want runtime_snapshot", eventType)
		}
		entriesJSON, _ := event.Payload["entries_json"].(string)
		if !strings.Contains(entriesJSON, "partial") {
			t.Fatalf("entries_json = %q, want partial assistant text", entriesJSON)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for runtime snapshot replay")
	}
}

func TestChatRuntimeSnapshotTerminalClosesSubscribers(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	sm.ApplyChatRuntimeSnapshot(&gatewayv1.ChatRuntimeSnapshot{
		ConversationId: "conversation-1",
		RunId:          "run-1",
		State:          session.ChatRunStateRunning,
		Revision:       1,
		EntriesJson:    `[{"id":"u1","kind":"user","text":"hello","attachments":[]}]`,
	})

	ch, done, cleanup, _, err := sm.SubscribeChatRun("run-1", "conversation-1", 1)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)

	sm.ApplyChatRuntimeSnapshot(&gatewayv1.ChatRuntimeSnapshot{
		ConversationId: "conversation-1",
		RunId:          "run-1",
		State:          session.ChatRunStateCompleted,
		Revision:       2,
		EntriesJson:    `[{"id":"u1","kind":"user","text":"hello","attachments":[]},{"id":"a1","kind":"assistant","text":"done","round":1}]`,
	})

	select {
	case event := <-ch:
		eventType, _ := event.Payload["type"].(string)
		state, _ := event.Payload["state"].(string)
		if eventType != "runtime_snapshot" || state != session.ChatRunStateCompleted {
			t.Fatalf("terminal snapshot event = %#v, want completed runtime_snapshot", event)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for terminal runtime snapshot")
	}
	assertDoneClosed(t, done)
	if summaries := sm.ActiveChatRunSummaries(); len(summaries) != 0 {
		t.Fatalf("active summaries after terminal snapshot = %#v, want empty", summaries)
	}
}

func TestChatRuntimeSnapshotIgnoresStaleRunningAfterTerminal(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	sm.ApplyChatRuntimeSnapshot(&gatewayv1.ChatRuntimeSnapshot{
		ConversationId: "conversation-1",
		RunId:          "run-1",
		State:          session.ChatRunStateRunning,
		Revision:       1,
		EntriesJson:    `[{"id":"u1","kind":"user","text":"hello","attachments":[]}]`,
	})
	sm.ApplyChatRuntimeSnapshot(&gatewayv1.ChatRuntimeSnapshot{
		ConversationId: "conversation-1",
		RunId:          "run-1",
		State:          session.ChatRunStateCompleted,
		Revision:       2,
		EntriesJson:    `[{"id":"u1","kind":"user","text":"hello","attachments":[]},{"id":"a1","kind":"assistant","text":"done","round":1}]`,
	})
	sm.ApplyChatRuntimeSnapshot(&gatewayv1.ChatRuntimeSnapshot{
		ConversationId: "conversation-1",
		RunId:          "run-1",
		State:          session.ChatRunStateRunning,
		Revision:       1,
		EntriesJson:    `[{"id":"u1","kind":"user","text":"hello","attachments":[]},{"id":"a1","kind":"assistant","text":"stale","round":1}]`,
	})

	if summaries := sm.ActiveChatRunSummaries(); len(summaries) != 0 {
		t.Fatalf("active summaries after stale running snapshot = %#v, want empty", summaries)
	}
	snapshot, ok := sm.ChatRunSnapshot("run-1", "conversation-1")
	if !ok || snapshot.State != session.ChatRunStateCompleted || !snapshot.Done || snapshot.LatestSeq != 2 {
		t.Fatalf("snapshot after stale running = %#v ok=%v, want completed seq 2", snapshot, ok)
	}
}

func TestChatRuntimeSnapshotTerminalCanFollowDoneEvent(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	sm.ApplyChatRuntimeSnapshot(&gatewayv1.ChatRuntimeSnapshot{
		ConversationId: "conversation-1",
		RunId:          "run-1",
		State:          session.ChatRunStateRunning,
		Revision:       1,
		EntriesJson:    `[{"id":"u1","kind":"user","text":"hello","attachments":[]}]`,
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "run-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-1",
				Data:           `{}`,
			},
		},
	})
	sm.ApplyChatRuntimeSnapshot(&gatewayv1.ChatRuntimeSnapshot{
		ConversationId: "conversation-1",
		RunId:          "run-1",
		State:          session.ChatRunStateCompleted,
		Revision:       2,
		EntriesJson:    `[{"id":"u1","kind":"user","text":"hello","attachments":[]},{"id":"a1","kind":"assistant","text":"final","round":1}]`,
	})

	ch, _, cleanup, snapshot, err := sm.SubscribeChatRun("run-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	if snapshot.State != session.ChatRunStateCompleted || !snapshot.Done || snapshot.LatestSeq != 3 {
		t.Fatalf("snapshot = %#v, want completed seq 3", snapshot)
	}

	gotRuntimeSnapshots := 0
	gotFinalSnapshot := false
	for gotRuntimeSnapshots < 2 {
		select {
		case event := <-ch:
			if event.Payload == nil {
				continue
			}
			eventType, _ := event.Payload["type"].(string)
			if eventType != "runtime_snapshot" {
				continue
			}
			gotRuntimeSnapshots += 1
			entriesJSON, _ := event.Payload["entries_json"].(string)
			if strings.Contains(entriesJSON, "final") {
				gotFinalSnapshot = true
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for final runtime snapshot")
		}
	}
	if !gotFinalSnapshot {
		t.Fatalf("final runtime snapshot was not replayed")
	}
}

func TestHistoryRunningDoesNotCreateAttachableConversationRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "history-sync-1",
		Payload: &gatewayv1.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv1.HistorySyncEvent{
				Kind:           "running",
				ConversationId: "conversation-1",
				Conversation: &gatewayv1.ConversationSummary{
					Id:  "conversation-1",
					Cwd: "/workspace",
				},
			},
		},
	})

	summaries := sm.ActiveChatRunSummaries()
	if len(summaries) != 0 {
		t.Fatalf("active summaries = %#v, want empty", summaries)
	}

	_, done, cleanup, _, err := sm.SubscribeChatRun("", "conversation-1", 0)
	defer cleanup()
	assertDoneClosed(t, done)
	if !errors.Is(err, session.ErrChatRunNotFound) {
		t.Fatalf("SubscribeChatRun = %v, want ErrChatRunNotFound", err)
	}
}

func TestHistoryRunningDoesNotPromoteDesktopQueuedCommandRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))

	if _, created, _, err := sm.StartAcceptedChatCommandRun("request-queued", "conversation-1", "client-1", "/workspace", []map[string]any{{
		"type":    "user_message",
		"message": "queued prompt",
	}}); err != nil || !created {
		t.Fatalf("StartAcceptedChatCommandRun queued created=%v err=%v", created, err)
	}
	dispatchChatControl(sm, "request-queued", "conversation-1", "queued_in_gui", session.ChatRunStateDesktopQueued)

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "history-sync-1",
		Payload: &gatewayv1.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv1.HistorySyncEvent{
				Kind:           "running",
				ConversationId: "conversation-1",
				Conversation: &gatewayv1.ConversationSummary{
					Id:  "conversation-1",
					Cwd: "/workspace",
				},
			},
		},
	})

	queuedSnapshot, ok := sm.ChatRunSnapshot("request-queued", "conversation-1")
	if !ok || queuedSnapshot.State != session.ChatRunStateDesktopQueued || queuedSnapshot.Workdir != "/workspace" {
		t.Fatalf("queued snapshot = %#v, ok=%v; want desktop queued request with workdir", queuedSnapshot, ok)
	}

	if summaries := sm.ActiveChatRunSummaries(); len(summaries) != 0 {
		t.Fatalf("active summaries = %#v, want queued GUI request hidden from live runs", summaries)
	}

	historyEvents, cleanupHistoryEvents := sm.SubscribeHistorySync()
	defer cleanupHistoryEvents()

	dispatchChatControl(sm, "request-queued", "conversation-1", "started", session.ChatRunStateRunning)

	select {
	case event := <-historyEvents:
		if event.GetKind() != "running" || event.GetConversationId() != "conversation-1" {
			t.Fatalf("history event after queued start = %#v, want running conversation-1", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for running history event after queued request started")
	}

	summaries := sm.ActiveChatRunSummaries()
	if len(summaries) != 1 ||
		summaries[0].ConversationID != "conversation-1" ||
		summaries[0].RequestID != "request-queued" ||
		summaries[0].FirstSeq != 1 ||
		summaries[0].LatestSeq != 4 {
		t.Fatalf("active summaries after started = %#v, want request-queued replay cursor", summaries)
	}

	ch, done, cleanup, snapshot, err := sm.SubscribeChatRun("request-queued", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)
	if snapshot.RequestID != "request-queued" || snapshot.State != session.ChatRunStateRunning {
		t.Fatalf("snapshot = %#v, want running request-queued", snapshot)
	}

	got := make([]string, 0, 4)
	for len(got) < 4 {
		select {
		case event := <-ch:
			eventType := ""
			if event.Control != nil {
				eventType = event.Control.GetType()
			} else if event.Payload != nil {
				eventType, _ = event.Payload["type"].(string)
			}
			got = append(got, fmt.Sprintf("%s:%d:%s", event.RequestID, event.Seq, eventType))
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for promoted queued replay, got %#v", got)
		}
	}
	want := []string{
		"request-queued:1:accepted",
		"request-queued:2:user_message",
		"request-queued:3:queued_in_gui",
		"request-queued:4:started",
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("promoted queued replay = %#v, want %#v", got, want)
		}
	}
}

func TestQueuedRunStartedHistoryEventSurvivesFullSubscriberQueue(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))

	historyEvents, cleanupHistoryEvents := sm.SubscribeHistorySync()
	defer cleanupHistoryEvents()

	for index := 0; index < 40; index += 1 {
		conversationID := fmt.Sprintf("filler-%02d", index)
		sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
			RequestId: fmt.Sprintf("history-filler-%02d", index),
			Payload: &gatewayv1.AgentEnvelope_HistorySync{
				HistorySync: &gatewayv1.HistorySyncEvent{
					Kind:           "upsert",
					ConversationId: conversationID,
					Conversation: &gatewayv1.ConversationSummary{
						Id: conversationID,
					},
				},
			},
		})
	}

	if _, created, _, err := sm.StartAcceptedChatCommandRun("request-queued", "conversation-1", "client-1", "/workspace", []map[string]any{{
		"type":    "user_message",
		"message": "queued prompt",
	}}); err != nil || !created {
		t.Fatalf("StartAcceptedChatCommandRun queued created=%v err=%v", created, err)
	}
	dispatchChatControl(sm, "request-queued", "conversation-1", "queued_in_gui", session.ChatRunStateDesktopQueued)
	dispatchChatControl(sm, "request-queued", "conversation-1", "started", session.ChatRunStateRunning)

	select {
	case event := <-historyEvents:
		if event.GetKind() != "running" || event.GetConversationId() != "conversation-1" {
			t.Fatalf("first history event after subscriber queue pressure = %#v, want running conversation-1", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for running history event after subscriber queue pressure")
	}
}

func TestCriticalHistoryEventDoesNotDrainEarlierCriticalEvent(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))

	historyEvents, cleanupHistoryEvents := sm.SubscribeHistorySync()
	defer cleanupHistoryEvents()

	if _, created, err := sm.StartPendingChatCommandRun("request-a", "conversation-a", "client-a"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-a created=%v err=%v", created, err)
	}
	dispatchChatControl(sm, "request-a", "conversation-a", "started", session.ChatRunStateRunning)

	for index := 0; index < 40; index += 1 {
		conversationID := fmt.Sprintf("filler-%02d", index)
		sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
			RequestId: fmt.Sprintf("history-filler-%02d", index),
			Payload: &gatewayv1.AgentEnvelope_HistorySync{
				HistorySync: &gatewayv1.HistorySyncEvent{
					Kind:           "upsert",
					ConversationId: conversationID,
					Conversation: &gatewayv1.ConversationSummary{
						Id: conversationID,
					},
				},
			},
		})
	}

	if _, created, err := sm.StartPendingChatCommandRun("request-b", "conversation-b", "client-b"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-b created=%v err=%v", created, err)
	}
	dispatchChatControl(sm, "request-b", "conversation-b", "started", session.ChatRunStateRunning)

	seen := make([]string, 0, 2)
	deadline := time.After(time.Second)
	for len(seen) < 2 {
		select {
		case event := <-historyEvents:
			if event.GetKind() == "running" {
				seen = append(seen, event.GetConversationId())
			}
		case <-deadline:
			t.Fatalf("timed out waiting for running events, saw %#v", seen)
		}
	}
	want := []string{"conversation-a", "conversation-b"}
	if fmt.Sprint(seen) != fmt.Sprint(want) {
		t.Fatalf("running history events = %#v, want %#v", seen, want)
	}
}

func TestStartedRunKeepsConversationOwnerWhenPreviousRunEmitsLateEvent(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	startRunningChatCommandRun(t, sm, "request-old", "conversation-1")
	if _, created, err := sm.StartPendingChatCommandRun("request-new", "conversation-1", "client-new"); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun new created=%v err=%v", created, err)
	}
	dispatchChatControl(sm, "request-new", "conversation-1", "started", session.ChatRunStateRunning)

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-old",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"late old token"}`,
			},
		},
	})

	summaries := sm.ActiveChatRunSummaries()
	if len(summaries) != 1 ||
		summaries[0].ConversationID != "conversation-1" ||
		summaries[0].RequestID != "request-new" {
		t.Fatalf("active summaries = %#v, want request-new", summaries)
	}

	_, done, cleanup, snapshot, err := sm.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)
	if snapshot.RequestID != "request-new" {
		t.Fatalf("conversation snapshot request id = %q, want request-new", snapshot.RequestID)
	}
}

func TestCompletedHistoryUpsertDoesNotPreemptTerminalChatEvent(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	started := startRunningChatCommandRun(t, sm, "request-1", "conversation-1")

	ch, done, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", started.LatestSeq)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-1",
				Data:           `{}`,
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "history-sync-1",
		Payload: &gatewayv1.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv1.HistorySyncEvent{
				Kind:           "upsert",
				ConversationId: "conversation-1",
				Conversation: &gatewayv1.ConversationSummary{
					Id: "conversation-1",
				},
			},
		},
	})

	assertDoneOpen(t, done)
	select {
	case event := <-ch:
		if event.Event.GetType() != gatewayv1.ChatEvent_DONE {
			t.Fatalf("event type = %v, want DONE", event.Event.GetType())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for terminal chat event")
	}

	_, missingDone, missingCleanup, _, err := sm.SubscribeChatRun("", "conversation-1", 0)
	defer missingCleanup()
	assertDoneClosed(t, missingDone)
	if !errors.Is(err, session.ErrChatRunNotFound) {
		t.Fatalf("SubscribeChatRun after release = %v, want ErrChatRunNotFound", err)
	}
}

func TestActiveChatRunSummariesReturnOpenRuns(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	startRunningChatCommandRun(t, sm, "request-b", "conversation-b")
	startRunningChatCommandRun(t, sm, "request-a", "conversation-a")
	startRunningChatCommandRun(t, sm, "request-empty", "")
	startRunningChatCommandRun(t, sm, "request-a-duplicate", "conversation-a")

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-b",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-b",
				Data:           `{}`,
			},
		},
	})

	got := activeChatRunConversationIDs(sm)
	want := []string{"conversation-a"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("active chat run conversation ids = %#v, want %#v", got, want)
	}
}

func TestClearSessionPreservesOpenChatRuns(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)
	first, created, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun: %v", err)
	}
	if !created || first.RequestID != "request-1" {
		t.Fatalf("first run = %#v created=%v", first, created)
	}

	ch, done, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	sm.ClearSession(sess)
	assertDoneClosed(t, sess.Done())
	assertDoneOpen(t, done)

	select {
	case event := <-ch:
		t.Fatalf("unexpected chat event after session clear: %#v", event)
	default:
	}

	got := activeChatRunConversationIDs(sm)
	want := []string{"conversation-1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("active chat runs after disconnect = %#v, want %#v", got, want)
	}

	restarted, created, err := sm.StartPendingChatCommandRun(
		"request-2",
		"conversation-1",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun retry: %v", err)
	}
	if created || restarted.RequestID != "request-1" {
		t.Fatalf("retry run = %#v created=%v, want preserved request-1", restarted, created)
	}

	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	sm.ApplyChatRuntimeSnapshot(&gatewayv1.ChatRuntimeSnapshot{
		ConversationId: "conversation-1",
		RunId:          "request-1",
		State:          session.ChatRunStateRunning,
		EntriesJson:    `[{"id":"u1","kind":"user","text":"hello","attachments":[]}]`,
		Revision:       1,
	})
	if snapshot, ok := sm.ChatRunSnapshot("request-1", "conversation-1"); !ok || snapshot.State != session.ChatRunStateRunning || snapshot.Done {
		t.Fatalf("snapshot after reconnect = %#v ok=%v, want running request-1", snapshot, ok)
	}
}

func TestStaleClearSessionDoesNotFailReplacementChatRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(first)
	second := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(second)

	startRunningChatCommandRun(t, sm, "request-current", "conversation-current")
	sm.ClearSession(first)

	got := activeChatRunConversationIDs(sm)
	want := []string{"conversation-current"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("active chat runs after stale clear = %#v, want %#v", got, want)
	}
	assertDoneOpen(t, second.Done())
}

func TestChatQueueEventsReplayLatestSnapshotToNewSubscribers(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "queue-event-1",
		Payload: &gatewayv1.AgentEnvelope_ChatQueueEvent{
			ChatQueueEvent: &gatewayv1.ChatQueueEvent{
				ConversationId: " conversation-1 ",
				SnapshotJson:   `{"conversationId":"conversation-1","revision":2,"items":[{"id":"queue-1"}]}`,
				Revision:       2,
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "queue-event-stale",
		Payload: &gatewayv1.AgentEnvelope_ChatQueueEvent{
			ChatQueueEvent: &gatewayv1.ChatQueueEvent{
				ConversationId: "conversation-1",
				SnapshotJson:   `{"conversationId":"conversation-1","revision":1,"items":[]}`,
				Revision:       1,
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "queue-event-zero",
		Payload: &gatewayv1.AgentEnvelope_ChatQueueEvent{
			ChatQueueEvent: &gatewayv1.ChatQueueEvent{
				ConversationId: "conversation-1",
				SnapshotJson:   `{"conversationId":"conversation-1","revision":0,"items":[]}`,
				Revision:       0,
			},
		},
	})

	cached, ok := sm.ChatQueueSnapshot("conversation-1")
	if !ok || cached.GetRevision() != 2 || !strings.Contains(cached.GetSnapshotJson(), "queue-1") {
		t.Fatalf("cached queue snapshot = %#v ok=%v, want revision 2 with queue-1", cached, ok)
	}

	events, cleanup := sm.SubscribeChatQueueEvents()
	defer cleanup()
	select {
	case event := <-events:
		if event.GetConversationId() != "conversation-1" ||
			event.GetRevision() != 2 ||
			!strings.Contains(event.GetSnapshotJson(), "queue-1") {
			t.Fatalf("replayed queue snapshot = %#v, want latest revision 2", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for replayed queue snapshot")
	}
}

func TestChatQueueSnapshotAllowsNewSessionToResetRevision(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "queue-event-1",
		Payload: &gatewayv1.AgentEnvelope_ChatQueueEvent{
			ChatQueueEvent: &gatewayv1.ChatQueueEvent{
				ConversationId: "conversation-1",
				SnapshotJson:   `{"conversationId":"conversation-1","revision":5,"items":[{"id":"queue-1"}]}`,
				Revision:       5,
			},
		},
	})

	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "queue-event-reset",
		Payload: &gatewayv1.AgentEnvelope_ChatQueueEvent{
			ChatQueueEvent: &gatewayv1.ChatQueueEvent{
				ConversationId: "conversation-1",
				SnapshotJson:   `{"conversationId":"conversation-1","revision":0,"items":[]}`,
				Revision:       0,
			},
		},
	})

	cached, ok := sm.ChatQueueSnapshot("conversation-1")
	if !ok || cached.GetRevision() != 0 || strings.Contains(cached.GetSnapshotJson(), "queue-1") {
		t.Fatalf("cached queue snapshot after new session = %#v ok=%v, want empty revision 0", cached, ok)
	}
}
