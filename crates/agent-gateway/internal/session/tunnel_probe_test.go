package session

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBuildTunnelProbeURLUsesTunnelPathAndWebSocketScheme(t *testing.T) {
	t.Parallel()

	got, err := buildTunnelProbeURL("https://gateway.example/t/slug/", "ws", true)
	if err != nil {
		t.Fatalf("buildTunnelProbeURL: %v", err)
	}
	if got != "wss://gateway.example/t/slug/.liveagent-tunnel-probe/ws" {
		t.Fatalf("probe URL = %q", got)
	}
}

func TestProbePublicTunnelWebSocketClassifiesHTML200AsPathOrUpgradeMiss(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<html>not a websocket</html>"))
	}))
	defer server.Close()

	diagnostic := probePublicTunnelWebSocket(context.Background(), server.URL+"/t/slug/", 123)
	if diagnostic.GetStatus() != "failed" {
		t.Fatalf("status = %q, want failed", diagnostic.GetStatus())
	}
	if diagnostic.GetStatusCode() != http.StatusOK {
		t.Fatalf("status code = %d, want 200", diagnostic.GetStatusCode())
	}
	if diagnostic.GetErrorCode() != "path_or_upgrade_missed" {
		t.Fatalf("error code = %q, want path_or_upgrade_missed", diagnostic.GetErrorCode())
	}
}
