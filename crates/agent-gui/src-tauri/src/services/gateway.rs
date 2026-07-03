use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, Once};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_stream::wrappers::ReceiverStream;
use tonic::metadata::MetadataValue;
use tonic::transport::{ClientTlsConfig, Endpoint};
use uuid::Uuid;

use crate::commands::chat_history::{self, ChatHistorySummary};
use crate::commands::settings::{
    apply_ssh_patch_with_conn, load_gateway_settings_sync_snapshot, load_remote_settings,
    normalize_remote_settings_payload, open_db, redact_gateway_settings_sync_payload,
    reset_runtime_ssh_known_host, RemoteSettingsPayload, PROVIDER_API_KEY_UPDATES_FIELD,
    SSH_PATCH_FIELD, SSH_SECRET_UPDATES_FIELD,
};
use crate::runtime::project_path::{
    project_path_key as normalize_project_path_key, project_path_keys_equal,
};
use crate::runtime::sftp::{
    SftpActionResponse, SftpEntry, SftpEventPayload, SftpListResponse, SftpSessionRegistry,
    SftpStatResponse, SftpTransferResponse, SftpTransferState,
};
use crate::runtime::terminal::{
    terminal_shell_options, SshTerminalTabRecord, SshTerminalTabsSnapshot, TerminalEventPayload,
    TerminalSessionRecord, TerminalSessionRegistry, TerminalShellOption, TerminalSnapshotResponse,
    TerminalSshCreateResponse, TerminalStreamEventPayload, TerminalStreamSnapshotResponse,
};
use crate::services::chat_run_ledger::{ChatRunLedger, ChatRunLedgerEntry, ChatRunLedgerState};
use crate::services::cron::CronManager;
use crate::services::gateway_bridge;
use crate::services::memory::MemoryStore;
use crate::services::tunnel::{TunnelProxy, TunnelStore};

pub mod proto {
    tonic::include_proto!("liveagent.gateway.v1");
}

const UI_ONLY_SETTINGS_SYNC_FIELDS: &[&str] = &[
    "skills",
    "chatRuntimeControls",
    "customSettings",
    "selectedModel",
    "theme",
    "locale",
];
const GATEWAY_GRPC_MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const GATEWAY_RECONNECT_DELAY: Duration = Duration::from_secs(5);
const GATEWAY_TERMINAL_STREAM_RECONNECT_MIN: Duration = Duration::from_millis(250);
const GATEWAY_TERMINAL_STREAM_RECONNECT_MAX: Duration = Duration::from_secs(5);
const GATEWAY_TERMINAL_STREAM_STABLE_AFTER: Duration = Duration::from_secs(30);
const GATEWAY_TERMINAL_STREAM_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(5);
const GATEWAY_CHAT_LEASE_MS: u64 = 15_000;
const GATEWAY_CHAT_RUNNING_LEASE_MS: u64 = 30 * 60_000;
const GATEWAY_CHAT_LEASE_SWEEP_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatusSnapshot {
    pub online: bool,
    pub enabled: bool,
    pub configured: bool,
    pub gateway_url: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub connected_since: Option<i64>,
    pub last_heartbeat: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySelectedModelEvent {
    pub custom_provider_id: String,
    pub model: String,
    pub provider_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatRuntimeControlsEvent {
    pub thinking_enabled: bool,
    pub native_web_search_enabled: bool,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayUploadedFileEvent {
    pub relative_path: String,
    pub absolute_path: String,
    pub file_name: String,
    pub kind: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatMessageRefEvent {
    pub segment_index: i32,
    pub message_index: i32,
    pub segment_id: String,
    pub message_id: String,
    pub role: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatRequestEvent {
    pub request_id: String,
    pub conversation_id: String,
    pub client_request_id: String,
    pub message: String,
    pub rebased: bool,
    pub base_message_ref: Option<GatewayChatMessageRefEvent>,
    pub selected_model: Option<GatewaySelectedModelEvent>,
    pub runtime_controls: Option<GatewayChatRuntimeControlsEvent>,
    pub execution_mode: String,
    pub workdir: String,
    pub selected_system_tools: Vec<String>,
    pub uploaded_files: Vec<GatewayUploadedFileEvent>,
    pub queue_policy: String,
}

fn is_complete_user_chat_message_ref(ref_value: &proto::ChatMessageRef) -> bool {
    ref_value.segment_index >= 0
        && ref_value.message_index >= 0
        && !ref_value.segment_id.trim().is_empty()
        && !ref_value.message_id.trim().is_empty()
        && ref_value.role.trim() == "user"
        && !ref_value.content_hash.trim().is_empty()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayChatCancelEvent {
    request_id: String,
    conversation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatQueueRequestEvent {
    pub request_id: String,
    pub action: String,
    pub conversation_id: String,
    pub item_id: String,
    pub direction: String,
    pub revision: u64,
    pub draft_json: String,
    pub uploaded_files_json: String,
    pub request_json: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatQueueResponseInput {
    pub request_id: String,
    #[serde(default)]
    pub accepted: bool,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub snapshot_json: String,
    #[serde(default)]
    pub item_json: String,
    #[serde(default)]
    pub error_code: String,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatQueueEventInput {
    pub conversation_id: String,
    pub snapshot_json: String,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatRuntimeSnapshot {
    pub conversation_id: String,
    pub run_id: String,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub worker_id: Option<String>,
    pub state: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub entries_json: String,
    #[serde(default)]
    pub tool_status: Option<String>,
    #[serde(default)]
    pub tool_status_is_compaction: bool,
}

#[derive(Debug, Clone)]
struct RemoteChatInboxRecord {
    request: GatewayChatRequestEvent,
    state: String,
    lease_owner: Option<String>,
    lease_expires_at: Option<Instant>,
    attempt: u32,
    started: bool,
    last_error: Option<String>,
    created_at: Instant,
    updated_at: Instant,
}

#[derive(Debug, Clone)]
struct RemoteChatEnqueueOutcome {
    request_id: String,
    conversation_id: String,
    control_type: &'static str,
    should_wake_runtime: bool,
    inserted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatClaimedRequest {
    pub request_id: String,
    pub client_request_id: String,
    pub conversation_id: String,
    pub state: String,
    pub attempt: u32,
    pub lease_ms: u64,
    pub request: GatewayChatRequestEvent,
}

pub const CHAT_HISTORY_SYNC_EVENT: &str = "chat-history:changed";
pub const GATEWAY_SETTINGS_SYNC_EVENT: &str = "gateway:settings-sync";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHistorySyncConversation {
    pub id: String,
    pub title: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
    pub is_pinned: bool,
    pub pinned_at: Option<i64>,
    pub is_shared: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHistorySyncEvent {
    pub kind: String,
    pub conversation_id: String,
    pub conversation: Option<GatewayHistorySyncConversation>,
}

pub struct GatewayController {
    app_handle: tauri::AppHandle,
    cron_manager: Arc<CronManager>,
    memory_store: Arc<MemoryStore>,
    terminal_registry: Arc<TerminalSessionRegistry>,
    sftp_registry: Arc<SftpSessionRegistry>,
    config_tx: watch::Sender<RemoteSettingsPayload>,
    runner_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    status: Mutex<GatewayStatusSnapshot>,
    outbound_tx: Mutex<Option<mpsc::Sender<proto::AgentEnvelope>>>,
    terminal_stream_tx: Mutex<Option<mpsc::Sender<proto::TerminalStreamFrame>>>,
    settings_snapshot: Mutex<Option<Value>>,
    remote_chat_inbox: Mutex<HashMap<String, RemoteChatInboxRecord>>,
    chat_run_ledger: Mutex<ChatRunLedger>,
    pub(crate) tunnel_store: TunnelStore,
    pub(crate) tunnel_proxy: TunnelProxy,
    pending_chat_queue_requests: Mutex<HashMap<String, oneshot::Sender<proto::ChatQueueResponse>>>,
    terminal_forwarder_once: Once,
    terminal_stream_forwarder_once: Once,
    sftp_forwarder_once: Once,
    remote_chat_inbox_sweeper_once: Once,
    pub(crate) tunnel_store_once: Once,
}

impl GatewayController {
    pub fn new(
        app_handle: tauri::AppHandle,
        cron_manager: Arc<CronManager>,
        memory_store: Arc<MemoryStore>,
        terminal_registry: Arc<TerminalSessionRegistry>,
        sftp_registry: Arc<SftpSessionRegistry>,
    ) -> Self {
        let initial_config = RemoteSettingsPayload::default();
        let (config_tx, _) = watch::channel(initial_config);
        let tunnel_store = TunnelStore::new(app_handle.clone());
        Self {
            app_handle,
            cron_manager,
            memory_store,
            terminal_registry,
            sftp_registry,
            config_tx,
            runner_task: Mutex::new(None),
            status: Mutex::new(GatewayStatusSnapshot {
                online: false,
                enabled: false,
                configured: false,
                gateway_url: String::new(),
                agent_id: fallback_agent_id(),
                session_id: None,
                connected_since: None,
                last_heartbeat: None,
                last_error: None,
            }),
            outbound_tx: Mutex::new(None),
            terminal_stream_tx: Mutex::new(None),
            settings_snapshot: Mutex::new(None),
            remote_chat_inbox: Mutex::new(HashMap::new()),
            chat_run_ledger: Mutex::new(ChatRunLedger::new()),
            tunnel_store,
            tunnel_proxy: TunnelProxy::new(),
            pending_chat_queue_requests: Mutex::new(HashMap::new()),
            terminal_forwarder_once: Once::new(),
            terminal_stream_forwarder_once: Once::new(),
            sftp_forwarder_once: Once::new(),
            remote_chat_inbox_sweeper_once: Once::new(),
            tunnel_store_once: Once::new(),
        }
    }

    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        self.start_terminal_forwarder();
        self.start_terminal_stream_forwarder();
        self.start_sftp_forwarder();
        self.start_remote_chat_inbox_sweeper();
        self.start_tunnel_store();
        self.ensure_runner()
    }

    fn start_terminal_forwarder(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.terminal_forwarder_once.call_once(move || {
            let (receiver, guard) = controller.terminal_registry.subscribe();
            thread::spawn(move || {
                let _guard = guard;
                while let Ok(event) = receiver.recv() {
                    let envelope = build_terminal_event_envelope(event.payload);
                    let Ok(sender) = controller.current_outbound_sender() else {
                        continue;
                    };
                    if let Err(error) = sender.blocking_send(envelope) {
                        eprintln!("send gateway terminal event failed: {error}");
                    }
                }
            });
        });
    }

    fn start_terminal_stream_forwarder(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.terminal_stream_forwarder_once.call_once(move || {
            let (receiver, guard) = controller.terminal_registry.subscribe_stream();
            thread::spawn(move || {
                let _guard = guard;
                while let Ok(event) = receiver.recv() {
                    let frame = build_terminal_stream_output_frame(event.payload);
                    let Ok(sender) = controller.current_terminal_stream_sender() else {
                        continue;
                    };
                    if let Err(error) = sender.blocking_send(frame) {
                        eprintln!("send gateway terminal stream frame failed: {error}");
                    }
                }
            });
        });
    }

    fn start_sftp_forwarder(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.sftp_forwarder_once.call_once(move || {
            let (receiver, guard) = controller.sftp_registry.subscribe();
            thread::spawn(move || {
                let _guard = guard;
                while let Ok(event) = receiver.recv() {
                    let envelope = build_sftp_event_envelope(event.payload);
                    let Ok(sender) = controller.current_outbound_sender() else {
                        continue;
                    };
                    if let Err(error) = sender.blocking_send(envelope) {
                        eprintln!("send gateway SFTP event failed: {error}");
                    }
                }
            });
        });
    }

    fn start_remote_chat_inbox_sweeper(self: &Arc<Self>) {
        let controller = Arc::clone(self);
        self.remote_chat_inbox_sweeper_once.call_once(move || {
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(GATEWAY_CHAT_LEASE_SWEEP_INTERVAL).await;
                    if let Err(error) = controller.expire_remote_chat_leases().await {
                        eprintln!("expire gateway remote chat leases failed: {error}");
                    }
                    if let Err(error) = controller.flush_unsent_chat_run_terminals().await {
                        eprintln!("flush gateway chat run terminals failed: {error}");
                    }
                }
            });
        });
    }

    fn spawn_runner(
        self: &Arc<Self>,
        runner_task: &mut Option<tauri::async_runtime::JoinHandle<()>>,
    ) {
        let receiver = self.config_tx.subscribe();
        let controller = Arc::clone(self);
        *runner_task = Some(tauri::async_runtime::spawn(async move {
            controller.run(receiver).await;
        }));
    }

    fn ensure_runner(self: &Arc<Self>) -> Result<(), String> {
        let mut runner_task = self
            .runner_task
            .lock()
            .map_err(|_| "gateway runner task lock poisoned".to_string())?;
        let should_spawn = runner_task
            .as_ref()
            .map(|task| task.inner().is_finished())
            .unwrap_or(true);
        if !should_spawn {
            return Ok(());
        }

        self.spawn_runner(&mut runner_task);
        Ok(())
    }

    fn restart_runner(self: &Arc<Self>) -> Result<(), String> {
        self.set_outbound_sender(None);
        self.set_terminal_stream_sender(None);
        let mut runner_task = self
            .runner_task
            .lock()
            .map_err(|_| "gateway runner task lock poisoned".to_string())?;
        if let Some(task) = runner_task.take() {
            task.abort();
        }
        self.spawn_runner(&mut runner_task);
        Ok(())
    }

    pub async fn reload_from_db(self: &Arc<Self>) -> Result<(), String> {
        let config = tauri::async_runtime::spawn_blocking(move || {
            let conn = open_db()?;
            load_remote_settings(&conn)
        })
        .await
        .map_err(|e| format!("reload remote settings join failed: {e}"))??;
        self.apply_config(config)
    }

    pub fn apply_config(self: &Arc<Self>, config: RemoteSettingsPayload) -> Result<(), String> {
        let normalized = normalize_remote_settings_payload(config);
        let previous = self.config_tx.borrow().clone();
        let config_changed = previous != normalized;
        let should_run_remote = normalized.enabled && is_remote_configured(&normalized);
        self.config_tx.send_replace(normalized.clone());
        self.publish_status(|status| {
            status.enabled = normalized.enabled;
            status.configured = is_remote_configured(&normalized);
            status.gateway_url = normalized.gateway_url.clone();
            status.agent_id = effective_agent_id(&normalized);
            if !normalized.enabled {
                set_disconnected_status(status, &normalized, None);
            } else if config_changed {
                set_disconnected_status(status, &normalized, None);
            }
        });
        if should_run_remote {
            self.restart_runner()?;
        } else {
            self.ensure_runner()?;
        }
        Ok(())
    }

    pub fn disconnect_runtime(self: &Arc<Self>) -> Result<(), String> {
        let mut config = self.config_tx.borrow().clone();
        config.enabled = false;
        self.apply_config(config)
    }

    pub fn status(&self) -> GatewayStatusSnapshot {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or(GatewayStatusSnapshot {
                online: false,
                enabled: false,
                configured: false,
                gateway_url: String::new(),
                agent_id: fallback_agent_id(),
                session_id: None,
                connected_since: None,
                last_heartbeat: None,
                last_error: Some("gateway status lock poisoned".to_string()),
            })
    }

    pub async fn send_chat_event(
        &self,
        request_id: String,
        event: Value,
        worker_id: Option<String>,
    ) -> Result<(), String> {
        // Terminal events must bypass the lease-freshness check: an expired but
        // still-owned lease may no longer be "current", yet dropping the run's
        // done/error signal here would leave the WebUI streaming forever.
        let is_terminal = chat_event_is_terminal(&event);
        if !self.renew_remote_chat_request_lease(&request_id, worker_id.as_deref(), !is_terminal)? {
            return Ok(());
        }
        let conversation_id = chat_event_conversation_id(&event);
        if is_terminal {
            let state = if chat_event_type(&event) == Some("done") {
                ChatRunLedgerState::Completed
            } else {
                ChatRunLedgerState::Failed
            };
            // Carry the error text into the ledger so a retransmitted terminal
            // control event still surfaces it after the original send failed.
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            // Record the terminal before attempting the send so a failed send
            // is retransmitted by the ledger flush loop.
            self.ledger_mark_run_terminal(&request_id, &conversation_id, state, "", message)?;
        } else {
            self.ledger_touch_run(&request_id, &conversation_id)?;
        }
        let envelope = build_chat_event_envelope(request_id.clone(), event)?;
        let result = self.send_agent_envelope(envelope).await;
        if is_terminal && result.is_ok() {
            self.ledger_mark_run_terminal_sent(&request_id)?;
        }
        result
    }

    pub async fn publish_history_sync(&self, event: GatewayHistorySyncEvent) {
        if let Err(error) = self.app_handle.emit(CHAT_HISTORY_SYNC_EVENT, event.clone()) {
            eprintln!("emit chat history sync failed: {error}");
        }

        if !self.status().online {
            return;
        }

        let envelope = match build_history_sync_envelope(event) {
            Ok(envelope) => envelope,
            Err(error) => {
                eprintln!("build gateway history sync envelope failed: {error}");
                return;
            }
        };

        if let Err(error) = self.send_agent_envelope(envelope).await {
            eprintln!("send gateway history sync event failed: {error}");
        }
    }

    pub async fn publish_chat_runtime_snapshot(
        &self,
        snapshot: GatewayChatRuntimeSnapshot,
    ) -> Result<(), String> {
        let run_id = snapshot.run_id.trim().to_string();
        let conversation_id = snapshot.conversation_id.trim().to_string();
        let terminal_state = match snapshot.state.trim() {
            "completed" => Some(ChatRunLedgerState::Completed),
            "failed" => Some(ChatRunLedgerState::Failed),
            "cancelled" => Some(ChatRunLedgerState::Cancelled),
            _ => None,
        };
        if !run_id.is_empty() {
            match terminal_state {
                Some(state) => {
                    self.ledger_mark_run_terminal(&run_id, &conversation_id, state, "", "")?;
                }
                None if snapshot.state.trim() == "running" => {
                    self.ledger_touch_run(&run_id, &conversation_id)?;
                }
                None => {}
            }
        }
        let envelope = build_chat_runtime_snapshot_envelope(snapshot)?;
        let result = self.send_agent_envelope(envelope).await;
        if terminal_state.is_some() && !run_id.is_empty() && result.is_ok() {
            self.ledger_mark_run_terminal_sent(&run_id)?;
        }
        result
    }

    pub async fn publish_settings_sync(&self, payload: Value) -> Result<(), String> {
        let snapshot = self.store_settings_snapshot(payload)?;

        if !self.status().online {
            return Ok(());
        }

        let envelope = build_settings_sync_envelope(snapshot)?;
        self.send_agent_envelope(envelope).await
    }

    async fn run(self: Arc<Self>, mut config_rx: watch::Receiver<RemoteSettingsPayload>) {
        loop {
            let config = config_rx.borrow().clone();
            if !config.enabled || !is_remote_configured(&config) {
                self.set_outbound_sender(None);
                self.set_terminal_stream_sender(None);
                self.publish_status(|status| {
                    set_disconnected_status(status, &config, None);
                });
                if config_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            let current_config = config.clone();
            let connect_result = self
                .connect_and_serve(current_config.clone(), &mut config_rx)
                .await;
            let latest_config = config_rx.borrow().clone();
            let reconfigured = latest_config != current_config;

            self.set_outbound_sender(None);
            self.set_terminal_stream_sender(None);
            if reconfigured {
                self.publish_status(|status| {
                    set_disconnected_status(status, &latest_config, None);
                });
                continue;
            }

            self.publish_status(|status| match connect_result.as_ref() {
                Ok(()) => set_disconnected_status(status, &current_config, None),
                Err(error) => set_disconnected_status(status, &current_config, Some(error.clone())),
            });

            if config_rx.has_changed().unwrap_or(false) {
                continue;
            }

            if !current_config.auto_reconnect {
                if config_rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            tokio::select! {
                changed = config_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
                _ = tokio::time::sleep(GATEWAY_RECONNECT_DELAY) => {}
            }
        }
    }

    async fn connect_and_serve(
        self: &Arc<Self>,
        config: RemoteSettingsPayload,
        config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    ) -> Result<(), String> {
        let grpc_url = build_grpc_url(&config)?;
        let endpoint = build_endpoint(&grpc_url)?;
        let channel = endpoint.connect_lazy();

        let mut client = proto::agent_gateway_client::AgentGatewayClient::new(channel)
            .max_decoding_message_size(GATEWAY_GRPC_MAX_MESSAGE_BYTES)
            .max_encoding_message_size(GATEWAY_GRPC_MAX_MESSAGE_BYTES);
        let mut auth_request = tonic::Request::new(proto::AuthRequest {
            token: config.token.clone(),
            agent_id: effective_agent_id(&config),
            agent_version: crate::app_version().to_string(),
        });
        insert_bearer_metadata(auth_request.metadata_mut(), &config.token)?;

        let auth_call = client.authenticate(auth_request);
        let auth_response = match await_abortable_on_reconfigure(&config, config_rx, async move {
            tokio::time::timeout(Duration::from_secs(10), auth_call)
                .await
                .map_err(|_| "gateway authenticate timed out".to_string())?
                .map_err(|e| format!("gateway authenticate failed: {e}"))
                .map(|response| response.into_inner())
        })
        .await?
        {
            Some(response) => response,
            None => return Ok(()),
        };
        if !auth_response.success {
            return Err(if auth_response.message.trim().is_empty() {
                "gateway authentication failed".to_string()
            } else {
                auth_response.message
            });
        }

        let terminal_client = client.clone();

        let (outbound_tx, outbound_rx) = mpsc::channel::<proto::AgentEnvelope>(4096);
        self.set_outbound_sender(Some(outbound_tx));
        let (terminal_stop_tx, terminal_stop_rx) = watch::channel(false);
        let terminal_task =
            self.spawn_terminal_stream(terminal_client, config.clone(), terminal_stop_rx);

        let serve_result = async {
            let mut connect_request = tonic::Request::new(ReceiverStream::new(outbound_rx));
            insert_bearer_metadata(connect_request.metadata_mut(), &config.token)?;

            let connect_call = client.agent_connect(connect_request);
            let response = match await_abortable_on_reconfigure(&config, config_rx, async move {
                tokio::time::timeout(Duration::from_secs(10), connect_call)
                    .await
                    .map_err(|_| "open gateway stream timed out".to_string())?
                    .map_err(|e| format!("open gateway stream failed: {e}"))
            })
            .await?
            {
                Some(response) => response,
                None => return Ok(()),
            };
            let mut inbound = response.into_inner();

            let connected_at = now_unix_seconds();
            self.publish_status(|status| {
                status.online = true;
                status.enabled = true;
                status.configured = true;
                status.gateway_url = config.gateway_url.clone();
                status.agent_id = effective_agent_id(&config);
                status.session_id = Some(auth_response.session_id.clone());
                status.connected_since = Some(connected_at);
                status.last_heartbeat = Some(connected_at);
                status.last_error = None;
            });

            if let Err(error) = self.publish_current_settings_sync().await {
                eprintln!("publish gateway settings sync failed: {error}");
            }
            if let Err(error) = self.publish_current_terminal_sessions().await {
                eprintln!("publish gateway terminal sessions failed: {error}");
            }
            if let Err(error) = self.publish_desired_tunnels().await {
                eprintln!("publish gateway tunnel desired state failed: {error}");
            }
            if let Err(error) = self.republish_chat_run_states().await {
                eprintln!("republish gateway chat run states failed: {error}");
            }
            self.spawn_tunnel_probes(None, false);

            let timeout_seconds = i64::try_from(config.heartbeat_interval.max(5)).unwrap_or(30) * 3;

            loop {
                tokio::select! {
                    changed = config_rx.changed() => {
                        if changed.is_err() {
                            return Ok(());
                        }
                        let next = config_rx.borrow().clone();
                        if next != config {
                            return Ok(());
                        }
                    }
                    message = tokio::time::timeout(
                        Duration::from_secs(u64::try_from(timeout_seconds.max(5)).unwrap_or(15)),
                        inbound.message(),
                    ) => {
                        match message {
                            Err(_) => return Err("gateway heartbeat timed out".to_string()),
                            Ok(Err(err)) => return Err(format!("gateway stream receive failed: {err}")),
                            Ok(Ok(None)) => return Err("gateway stream closed".to_string()),
                            Ok(Ok(Some(envelope))) => {
                                self.touch_heartbeat();
                                self.handle_gateway_envelope(envelope).await?;
                            }
                        }
                    }
                }
            }
        }
        .await;

        let _ = terminal_stop_tx.send(true);
        terminal_task.abort();
        self.set_terminal_stream_sender(None);
        serve_result
    }

    fn spawn_terminal_stream(
        self: &Arc<Self>,
        client: proto::agent_gateway_client::AgentGatewayClient<tonic::transport::Channel>,
        config: RemoteSettingsPayload,
        stop_rx: watch::Receiver<bool>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let controller = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            controller
                .run_terminal_stream(client, config, stop_rx)
                .await;
        })
    }

    async fn run_terminal_stream(
        self: Arc<Self>,
        client: proto::agent_gateway_client::AgentGatewayClient<tonic::transport::Channel>,
        config: RemoteSettingsPayload,
        mut stop_rx: watch::Receiver<bool>,
    ) {
        let mut reconnect_delay = GATEWAY_TERMINAL_STREAM_RECONNECT_MIN;

        loop {
            if *stop_rx.borrow() {
                break;
            }

            let attempt_started = Instant::now();
            let result = Arc::clone(&self)
                .run_terminal_stream_once(client.clone(), config.clone(), stop_rx.clone())
                .await;
            if *stop_rx.borrow() {
                break;
            }
            self.set_terminal_stream_sender(None);

            if attempt_started.elapsed() >= GATEWAY_TERMINAL_STREAM_STABLE_AFTER {
                reconnect_delay = GATEWAY_TERMINAL_STREAM_RECONNECT_MIN;
            }
            match result {
                Ok(()) => eprintln!("gateway terminal stream closed; reconnecting"),
                Err(error) => eprintln!("gateway terminal stream stopped: {error}; reconnecting"),
            }

            let delay = reconnect_delay;
            reconnect_delay =
                std::cmp::min(reconnect_delay * 2, GATEWAY_TERMINAL_STREAM_RECONNECT_MAX);
            tokio::select! {
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        break;
                    }
                }
                _ = tokio::time::sleep(delay) => {}
            }
        }

        self.set_terminal_stream_sender(None);
    }

    async fn run_terminal_stream_once(
        self: Arc<Self>,
        mut client: proto::agent_gateway_client::AgentGatewayClient<tonic::transport::Channel>,
        config: RemoteSettingsPayload,
        mut stop_rx: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let (terminal_tx, terminal_rx) = mpsc::channel::<proto::TerminalStreamFrame>(4096);

        let result = async {
            queue_terminal_stream_handshake_frame(&terminal_tx)?;
            let mut request = tonic::Request::new(ReceiverStream::new(terminal_rx));
            insert_bearer_metadata(request.metadata_mut(), &config.token)?;
            let response = tokio::select! {
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        return Ok(());
                    }
                    return Ok(());
                }
                response = client.agent_terminal_connect(request) => {
                    response.map_err(|error| {
                        format_gateway_terminal_stream_rpc_error("open", &error, &config)
                    })?
                }
            };
            self.set_terminal_stream_sender(Some(terminal_tx.clone()));
            let mut inbound = response.into_inner();
            let mut keepalive = tokio::time::interval(GATEWAY_TERMINAL_STREAM_KEEPALIVE_INTERVAL);
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            keepalive.tick().await;
            loop {
                tokio::select! {
                    changed = stop_rx.changed() => {
                        if changed.is_err() || *stop_rx.borrow() {
                            return Ok(());
                        }
                    }
                    _ = keepalive.tick() => {
                        queue_terminal_stream_keepalive_frame(&terminal_tx).await?;
                    }
                    message = inbound.message() => {
                        match message {
                            Ok(Some(frame)) => {
                                if let Err(error) = self.handle_terminal_stream_frame(frame).await {
                                    eprintln!("handle gateway terminal stream frame failed: {error}");
                                }
                            }
                            Ok(None) => return Ok(()),
                            Err(error) => {
                                return Err(format_gateway_terminal_stream_rpc_error("receive", &error, &config))
                            }
                        }
                    }
                }
            }
        }
        .await;

        self.clear_terminal_stream_sender_if_current(&terminal_tx);
        result
    }

    async fn handle_terminal_stream_frame(
        &self,
        frame: proto::TerminalStreamFrame,
    ) -> Result<(), String> {
        let kind = frame.kind.trim().to_ascii_lowercase();
        let stream_id = frame.stream_id.clone();
        let session_id = frame.session_id.clone();
        let project_path_key = frame.project_path_key.clone();
        let result = match kind.as_str() {
            "attach" => {
                self.ensure_terminal_stream_allowed(&frame)?;
                let snapshot = self.terminal_registry.stream_attach(
                    frame.session_id.clone(),
                    optional_proto_usize(frame.max_bytes),
                )?;
                self.send_terminal_stream_frame(terminal_stream_snapshot_to_proto(
                    stream_id.clone(),
                    snapshot,
                ))
                .await
            }
            "input" => {
                self.ensure_terminal_stream_allowed(&frame)?;
                self.terminal_registry
                    .input_bytes_from_remote(frame.session_id.clone(), frame.data.clone())?;
                Ok(())
            }
            "resize" => {
                self.ensure_terminal_stream_allowed(&frame)?;
                self.terminal_registry.stream_resize(
                    frame.session_id.clone(),
                    optional_proto_u16(frame.cols).unwrap_or(80),
                    optional_proto_u16(frame.rows).unwrap_or(24),
                )?;
                Ok(())
            }
            "detach" => Ok(()),
            "" => Err("terminal stream frame kind is required".to_string()),
            other => Err(format!("unsupported terminal stream frame: {other}")),
        };

        if let Err(error) = result {
            let _ = self
                .send_terminal_stream_frame(terminal_stream_error_frame(
                    stream_id,
                    session_id,
                    project_path_key,
                    error.clone(),
                ))
                .await;
            return Err(error);
        }
        Ok(())
    }

    async fn send_terminal_stream_frame(
        &self,
        frame: proto::TerminalStreamFrame,
    ) -> Result<(), String> {
        let sender = self.current_terminal_stream_sender()?;
        sender
            .send(frame)
            .await
            .map_err(|error| format!("send terminal stream frame failed: {error}"))
    }

    async fn handle_gateway_envelope(
        self: &Arc<Self>,
        envelope: proto::GatewayEnvelope,
    ) -> Result<(), String> {
        let request_id = envelope.request_id.clone();

        match envelope.payload {
            Some(proto::gateway_envelope::Payload::Ping(ping)) => {
                self.send_agent_envelope(proto::AgentEnvelope {
                    request_id,
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::Pong(proto::PongResponse {
                        timestamp: ping.timestamp,
                    })),
                })
                .await
            }
            Some(proto::gateway_envelope::Payload::TunnelState(snapshot)) => {
                self.handle_tunnel_state_snapshot(snapshot);
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TunnelMutation(mutation)) => {
                self.handle_tunnel_mutation_request(request_id, mutation);
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TunnelFrame(frame)) => {
                self.tunnel_proxy.handle_frame(self, frame)
            }
            Some(proto::gateway_envelope::Payload::ChatCommand(command)) => {
                self.handle_chat_command(request_id, command).await
            }
            Some(proto::gateway_envelope::Payload::ChatQueue(request)) => {
                self.handle_chat_queue_request(request_id, request).await
            }
            Some(proto::gateway_envelope::Payload::CronManage(request)) => {
                let should_refresh_settings =
                    matches!(request.action.trim(), "create" | "update" | "delete");
                match gateway_bridge::handle_cron_manage(Arc::clone(&self.cron_manager), request)
                    .await
                {
                    Ok(response) => {
                        let send_result = self
                            .send_agent_envelope(proto::AgentEnvelope {
                                request_id,
                                timestamp: now_unix_seconds(),
                                payload: Some(proto::agent_envelope::Payload::CronManageResp(
                                    response,
                                )),
                            })
                            .await;
                        if send_result.is_ok() && should_refresh_settings {
                            if let Err(error) = self.refresh_settings_sync_from_db().await {
                                eprintln!(
                                    "refresh gateway settings sync after cron manage failed: {error}"
                                );
                            }
                        }
                        send_result
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryList(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_list(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryListResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.list handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryWorkdirs(_request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_workdirs().await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryWorkdirsResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.workdirs handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryGet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_get(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryGetResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.get handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryPrefix(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_prefix(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryPrefixResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.prefix handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryRename(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_rename(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryRenameResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.rename handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryPin(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_pin(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryPinResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.pin handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareGet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_get(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareGetResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.get handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareSet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_set(request).await {
                        Ok(response) => {
                            if let Some(share) = response.share.as_ref() {
                                match chat_history::chat_history_get_summary_inner(
                                    share.conversation_id.clone(),
                                )
                                .await
                                {
                                    Ok(summary) => {
                                        controller
                                            .publish_history_sync(build_history_sync_upsert(
                                                &summary,
                                            ))
                                            .await;
                                    }
                                    Err(error) => {
                                        eprintln!(
                                            "publish history share sync event failed: {error}"
                                        )
                                    }
                                }
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareSetResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.set handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareResolve(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_resolve(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareResolveResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            let code = history_share_resolve_error_code(&error);
                            controller
                                .send_error_response(request_id.clone(), code, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.resolve handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryDelete(request)) => {
                let deleted_conversation_id = request.conversation_id.trim().to_string();
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_delete(request).await {
                        Ok(response) => {
                            controller
                                .publish_history_sync(build_history_sync_delete(
                                    deleted_conversation_id,
                                ))
                                .await;
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryDeleteResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.delete handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::ProviderList(_request)) => {
                match gateway_bridge::handle_provider_list().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ProviderListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsGet(_request)) => {
                match self.current_settings_snapshot().await {
                    Ok(snapshot) => {
                        let settings_json = match serialize_settings_sync_payload(&snapshot) {
                            Ok(settings_json) => settings_json,
                            Err(error) => {
                                return self.send_error_response(request_id, 500, error).await;
                            }
                        };
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SettingsGetResp(
                                proto::SettingsGetResponse { settings_json },
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsUpdate(request)) => {
                match parse_settings_sync_payload(&request.settings_json) {
                    Ok(snapshot) => {
                        if snapshot.get(SSH_PATCH_FIELD).is_some() {
                            let patch_payload = snapshot.clone();
                            let apply_response =
                                match tauri::async_runtime::spawn_blocking(move || {
                                    let mut conn = open_db()?;
                                    apply_ssh_patch_with_conn(&mut conn, patch_payload)
                                })
                                .await
                                .map_err(|e| format!("settings ssh patch join failed: {e}"))
                                {
                                    Ok(Ok(response)) => response,
                                    Ok(Err(error)) | Err(error) => {
                                        return self
                                            .send_error_response(request_id, 500, error)
                                            .await;
                                    }
                                };
                            if let Some(conflict) = apply_response.conflict {
                                return self
                                    .send_agent_envelope(proto::AgentEnvelope {
                                        request_id,
                                        timestamp: now_unix_seconds(),
                                        payload: Some(
                                            proto::agent_envelope::Payload::SettingsUpdateResp(
                                                proto::SettingsUpdateResponse {
                                                    accepted: false,
                                                    message: conflict,
                                                },
                                            ),
                                        ),
                                    })
                                    .await;
                            }

                            let fresh_snapshot = match self.current_settings_snapshot().await {
                                Ok(snapshot) => snapshot,
                                Err(error) => {
                                    return self.send_error_response(request_id, 500, error).await;
                                }
                            };
                            let merged_ssh =
                                fresh_snapshot.get("ssh").cloned().unwrap_or(Value::Null);
                            let event_payload =
                                match build_local_settings_update_event_payload_with_ssh(
                                    snapshot.clone(),
                                    merged_ssh,
                                ) {
                                    Ok(payload) => payload,
                                    Err(error) => {
                                        return self
                                            .send_error_response(request_id, 400, error)
                                            .await;
                                    }
                                };
                            if let Err(error) = self
                                .app_handle
                                .emit(GATEWAY_SETTINGS_SYNC_EVENT, event_payload)
                            {
                                return self
                                    .send_error_response(
                                        request_id,
                                        500,
                                        format!("emit gateway settings sync failed: {error}"),
                                    )
                                    .await;
                            }
                            if let Err(error) = self.publish_settings_sync(fresh_snapshot).await {
                                eprintln!("publish gateway ssh settings sync failed: {error}");
                            }
                            return self
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id,
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::SettingsUpdateResp(
                                            proto::SettingsUpdateResponse {
                                                accepted: true,
                                                message: "ok".to_string(),
                                            },
                                        ),
                                    ),
                                })
                                .await;
                        }

                        let event_payload =
                            match build_local_settings_update_event_payload(snapshot.clone()) {
                                Ok(payload) => payload,
                                Err(error) => {
                                    return self.send_error_response(request_id, 400, error).await;
                                }
                            };
                        let public_update = match redact_gateway_settings_sync_payload(snapshot) {
                            Ok(payload) => payload,
                            Err(error) => {
                                return self.send_error_response(request_id, 400, error).await;
                            }
                        };
                        // The update is a partial payload (only changed fields, e.g.
                        // {"theme":"dark"}). Overlay it onto the current full snapshot;
                        // storing it as-is would drop every other cached field and let
                        // rebuilt snapshots revert UI-only settings like theme.
                        let current_snapshot = match self.current_settings_snapshot().await {
                            Ok(snapshot) => snapshot,
                            Err(error) => {
                                return self.send_error_response(request_id, 500, error).await;
                            }
                        };
                        let merged_snapshot = match merge_settings_update_into_snapshot(
                            current_snapshot,
                            public_update,
                        ) {
                            Ok(payload) => payload,
                            Err(error) => {
                                return self.send_error_response(request_id, 400, error).await;
                            }
                        };
                        if let Err(error) = self.store_settings_snapshot(merged_snapshot) {
                            return self.send_error_response(request_id, 500, error).await;
                        }
                        match self
                            .app_handle
                            .emit(GATEWAY_SETTINGS_SYNC_EVENT, event_payload)
                        {
                            Ok(()) => {
                                self.send_agent_envelope(proto::AgentEnvelope {
                                    request_id,
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::SettingsUpdateResp(
                                            proto::SettingsUpdateResponse {
                                                accepted: true,
                                                message: "ok".to_string(),
                                            },
                                        ),
                                    ),
                                })
                                .await
                            }
                            Err(error) => {
                                self.send_error_response(
                                    request_id,
                                    500,
                                    format!("emit gateway settings sync failed: {error}"),
                                )
                                .await
                            }
                        }
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsResetSshKnownHost(request)) => {
                let host = request.host.trim().to_string();
                let port = match u16::try_from(request.port) {
                    Ok(port) if port > 0 => port,
                    _ => {
                        return self
                            .send_error_response(
                                request_id,
                                400,
                                "SSH port must be between 1 and 65535".to_string(),
                            )
                            .await;
                    }
                };
                match reset_runtime_ssh_known_host(&host, port) {
                    Ok(deleted) => {
                        let deleted = u32::try_from(deleted).unwrap_or(u32::MAX);
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::SettingsResetSshKnownHostResp(
                                    proto::SettingsResetSshKnownHostResponse { deleted },
                                ),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsRoots(_request)) => {
                match gateway_bridge::handle_fs_roots().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsRootsResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsListDirs(request)) => {
                match gateway_bridge::handle_fs_list_dirs(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsListDirsResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsCreateProjectFolder(request)) => {
                match gateway_bridge::handle_fs_create_project_folder(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::FsCreateProjectFolderResp(response),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsList(request)) => {
                match gateway_bridge::handle_fs_list(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsListResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsReadEditableText(request)) => {
                match gateway_bridge::handle_fs_read_editable_text(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsReadEditableTextResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsReadWorkspaceImage(request)) => {
                match gateway_bridge::handle_fs_read_workspace_image(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::FsReadWorkspaceImageResp(response),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsWriteText(request)) => {
                match gateway_bridge::handle_fs_write_text(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsWriteTextResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsCreateDir(request)) => {
                match gateway_bridge::handle_fs_create_dir(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsCreateDirResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsRename(request)) => {
                match gateway_bridge::handle_fs_rename(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsRenameResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsDelete(request)) => {
                match gateway_bridge::handle_fs_delete(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsDeleteResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillFilesList(_request)) => {
                match gateway_bridge::handle_skill_files_list().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillFilesListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FileMentionList(request)) => {
                match gateway_bridge::handle_file_mention_list(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FileMentionListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::UploadReadableFiles(request)) => {
                match gateway_bridge::handle_upload_readable_files(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::UploadReadableFilesResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::UploadedImagePreview(request)) => {
                self.spawn_uploaded_image_preview_response(request_id, request)
            }
            Some(proto::gateway_envelope::Payload::MemoryManage(request)) => {
                match gateway_bridge::handle_memory_manage(Arc::clone(&self.memory_store), request)
                    .await
                {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::MemoryManageResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillMetadataRead(request)) => {
                match gateway_bridge::handle_skill_metadata_read(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillMetadataReadResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillTextRead(request)) => {
                match gateway_bridge::handle_skill_text_read(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillTextReadResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillManage(request)) => {
                match gateway_bridge::handle_skill_manage(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillManageResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::GitRequest(request)) => {
                match gateway_bridge::handle_git_request(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::GitResponse(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::TerminalRequest(request)) => {
                match self.handle_terminal_request(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::TerminalResponse(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SftpRequest(request)) => {
                match self.handle_sftp_request(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SftpResponse(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            None => Ok(()),
        }
    }

    async fn handle_sftp_request(
        &self,
        request: proto::SftpRequest,
    ) -> Result<proto::SftpResponse, String> {
        if !self.config_tx.borrow().enable_web_ssh_terminal {
            return Err("web SSH SFTP is disabled in desktop Remote settings".to_string());
        }
        let action = request.action.trim().to_ascii_lowercase();
        match action.as_str() {
            "list" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let path = sftp_side_path(&side, &request.local_path, &request.remote_path);
                let response = self
                    .sftp_registry
                    .list(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        Some(path),
                    )
                    .await?;
                Ok(sftp_list_response_to_proto(action, response))
            }
            "stat" | "probe" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let path = sftp_side_path(&side, &request.local_path, &request.remote_path);
                let response = self
                    .sftp_registry
                    .stat(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        Some(path),
                    )
                    .await?;
                Ok(sftp_stat_response_to_proto(action, response))
            }
            "mkdir" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let path = sftp_side_path(&side, &request.local_path, &request.remote_path);
                let response = self
                    .sftp_registry
                    .mkdir(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        path,
                    )
                    .await?;
                Ok(sftp_action_response_to_proto(action, response))
            }
            "rename" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let response = self
                    .sftp_registry
                    .rename(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        request.from_path,
                        request.to_path,
                    )
                    .await?;
                Ok(sftp_action_response_to_proto(action, response))
            }
            "delete" => {
                let side = if request.direction.trim().is_empty() {
                    "remote".to_string()
                } else {
                    request.direction
                };
                let path = sftp_side_path(&side, &request.local_path, &request.remote_path);
                let response = self
                    .sftp_registry
                    .delete(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        side,
                        path,
                        request.recursive,
                    )
                    .await?;
                Ok(sftp_action_response_to_proto(action, response))
            }
            "transfer" => {
                let response = self
                    .sftp_registry
                    .transfer(
                        request.session_id,
                        Some(request.project_path_key),
                        request.workdir,
                        request.direction,
                        request.from_path,
                        request.target_path,
                        request.recursive,
                        request.overwrite,
                    )
                    .await?;
                Ok(sftp_transfer_response_to_proto(action, response))
            }
            "cancel" => {
                self.sftp_registry
                    .cancel_transfer(request.session_id, request.from_path)?;
                Ok(proto::SftpResponse {
                    action,
                    path: String::new(),
                    entries: Vec::new(),
                    entry: None,
                    exists: false,
                    transfer: None,
                })
            }
            _ => Err(format!("unsupported sftp action: {action}")),
        }
    }

    async fn handle_terminal_request(
        &self,
        request: proto::TerminalRequest,
    ) -> Result<proto::TerminalResponse, String> {
        let action = request.action.trim().to_ascii_lowercase();
        self.ensure_terminal_request_allowed(&action, &request)?;
        match action.as_str() {
            "shell_options" => {
                let options = terminal_shell_options();
                Ok(proto::TerminalResponse {
                    action,
                    sessions: Vec::new(),
                    session: None,
                    output: Vec::new(),
                    truncated: false,
                    shell_options: options
                        .options
                        .into_iter()
                        .map(terminal_shell_option_to_proto)
                        .collect(),
                    default_shell: options.default_shell,
                    output_start_offset: 0,
                    output_end_offset: 0,
                    ssh_prompt: None,
                    latency_ms: 0,
                    ssh_tabs: None,
                })
            }
            "list" => {
                let project_path_key = normalize_project_path_key(&request.project_path_key);
                let project_filter = (!project_path_key.is_empty()).then_some(project_path_key);
                let config = self.config_tx.borrow().clone();
                let sessions = self
                    .terminal_registry
                    .list(project_filter)
                    .sessions
                    .into_iter()
                    .filter(|session| {
                        if session.kind.trim() == "ssh" {
                            config.enable_web_ssh_terminal
                        } else {
                            config.enable_web_terminal
                        }
                    })
                    .map(terminal_session_to_proto)
                    .collect();
                Ok(proto::TerminalResponse {
                    action,
                    sessions,
                    session: None,
                    output: Vec::new(),
                    truncated: false,
                    shell_options: Vec::new(),
                    default_shell: String::new(),
                    output_start_offset: 0,
                    output_end_offset: 0,
                    ssh_prompt: None,
                    latency_ms: 0,
                    ssh_tabs: None,
                })
            }
            "create" => {
                let project_path_key =
                    required_terminal_project_path_key(&request.project_path_key)?;
                let snapshot = self.terminal_registry.create(
                    request.cwd,
                    Some(project_path_key),
                    optional_proto_text(request.shell),
                    optional_proto_text(request.title),
                    optional_proto_u16(request.cols),
                    optional_proto_u16(request.rows),
                )?;
                Ok(terminal_create_snapshot_response_to_proto(action, snapshot))
            }
            "create_ssh" => {
                let project_path_key =
                    required_terminal_project_path_key(&request.project_path_key)?;
                let response = self
                    .terminal_registry
                    .clone()
                    .create_ssh(
                        request.cwd,
                        Some(project_path_key),
                        request.ssh_host_id,
                        optional_proto_text(request.title),
                        optional_proto_u16(request.cols),
                        optional_proto_u16(request.rows),
                        request.sftp_enabled,
                    )
                    .await?;
                Ok(terminal_ssh_create_response_to_proto(action, response))
            }
            "answer_ssh_prompt" => {
                let response = self
                    .terminal_registry
                    .clone()
                    .answer_ssh_prompt(
                        request.prompt_id,
                        optional_proto_text(request.prompt_answer),
                        request.trust_host_key,
                    )
                    .await?;
                Ok(terminal_ssh_create_response_to_proto(action, response))
            }
            "ssh_latency" => {
                self.ensure_terminal_session_in_project(
                    &request.session_id,
                    &request.project_path_key,
                )?;
                let latency = self
                    .terminal_registry
                    .ssh_latency(request.session_id)
                    .await?;
                Ok(proto::TerminalResponse {
                    action,
                    sessions: Vec::new(),
                    session: None,
                    output: Vec::new(),
                    truncated: false,
                    shell_options: Vec::new(),
                    default_shell: String::new(),
                    output_start_offset: 0,
                    output_end_offset: 0,
                    ssh_prompt: None,
                    latency_ms: latency.latency_ms,
                    ssh_tabs: None,
                })
            }
            "cancel_ssh_prompt" => {
                self.terminal_registry
                    .cancel_ssh_prompt(request.prompt_id)?;
                Ok(proto::TerminalResponse {
                    action,
                    sessions: Vec::new(),
                    session: None,
                    output: Vec::new(),
                    truncated: false,
                    shell_options: Vec::new(),
                    default_shell: String::new(),
                    output_start_offset: 0,
                    output_end_offset: 0,
                    ssh_prompt: None,
                    latency_ms: 0,
                    ssh_tabs: None,
                })
            }
            "ssh_tabs_list" => {
                let project_path_key =
                    required_terminal_project_path_key(&request.project_path_key)?;
                let snapshot = self
                    .terminal_registry
                    .ssh_terminal_tabs_list(project_path_key)?;
                Ok(terminal_ssh_tabs_response_to_proto(action, snapshot))
            }
            "ssh_tab_open" => {
                let snapshot = self
                    .terminal_registry
                    .ssh_terminal_tab_open(request.session_id, request.tab_kind)?;
                Ok(terminal_ssh_tabs_response_to_proto(action, snapshot))
            }
            "ssh_tab_close" => {
                let snapshot = self
                    .terminal_registry
                    .ssh_terminal_tab_close(request.tab_id)?;
                Ok(terminal_ssh_tabs_response_to_proto(action, snapshot))
            }
            "rename" => {
                self.ensure_terminal_session_in_project(
                    &request.session_id,
                    &request.project_path_key,
                )?;
                let session = self
                    .terminal_registry
                    .rename(request.session_id, request.title)?;
                Ok(terminal_record_response_to_proto(action, session))
            }
            "close" => {
                self.ensure_terminal_session_in_project(
                    &request.session_id,
                    &request.project_path_key,
                )?;
                let session = self.terminal_registry.close(request.session_id)?;
                self.sftp_registry.close_session(&session.id);
                Ok(terminal_record_response_to_proto(action, session))
            }
            "close_project" => {
                let project_path_key =
                    required_terminal_project_path_key(&request.project_path_key)?;
                let config = self.config_tx.borrow().clone();
                let sessions: Vec<TerminalSessionRecord> = self
                    .terminal_registry
                    .list(Some(project_path_key))
                    .sessions
                    .into_iter()
                    .filter(|session| {
                        if session.kind.trim() == "ssh" {
                            config.enable_web_ssh_terminal
                        } else {
                            config.enable_web_terminal
                        }
                    })
                    .filter_map(|session| self.terminal_registry.close(session.id).ok())
                    .collect();
                for session in &sessions {
                    self.sftp_registry.close_session(&session.id);
                }
                Ok(terminal_list_response_to_proto(action, sessions))
            }
            "" => Err("terminal action is required".to_string()),
            other => Err(format!("unsupported terminal action: {other}")),
        }
    }

    fn ensure_terminal_session_in_project(
        &self,
        session_id: &str,
        project_path_key: &str,
    ) -> Result<(), String> {
        let project_path_key = required_terminal_project_path_key(project_path_key)?;
        let session = self
            .terminal_registry
            .session_record(session_id.trim().to_string())?;
        if !project_path_keys_equal(&session.project_path_key, &project_path_key) {
            return Err("terminal session is outside the requested project".to_string());
        }
        Ok(())
    }

    fn ensure_terminal_request_allowed(
        &self,
        action: &str,
        request: &proto::TerminalRequest,
    ) -> Result<(), String> {
        let config = self.config_tx.borrow().clone();
        match action {
            "create_ssh" | "answer_ssh_prompt" | "cancel_ssh_prompt" | "ssh_tabs_list"
            | "ssh_tab_open" | "ssh_tab_close" => {
                if config.enable_web_ssh_terminal {
                    Ok(())
                } else {
                    Err("web SSH terminal is disabled in desktop Remote settings".to_string())
                }
            }
            "list" => {
                if config.enable_web_terminal || config.enable_web_ssh_terminal {
                    Ok(())
                } else {
                    Err("web terminal is disabled in desktop Remote settings".to_string())
                }
            }
            "attach" | "input" | "resize" | "rename" | "close" | "ssh_latency" => {
                let session = self
                    .terminal_registry
                    .session_record(request.session_id.trim().to_string())?;
                let allowed = if session.kind.trim() == "ssh" {
                    config.enable_web_ssh_terminal
                } else {
                    config.enable_web_terminal
                };
                if allowed {
                    Ok(())
                } else if session.kind.trim() == "ssh" {
                    Err("web SSH terminal is disabled in desktop Remote settings".to_string())
                } else {
                    Err("web terminal is disabled in desktop Remote settings".to_string())
                }
            }
            "close_project" => {
                if config.enable_web_terminal || config.enable_web_ssh_terminal {
                    Ok(())
                } else {
                    Err("web terminal is disabled in desktop Remote settings".to_string())
                }
            }
            _ => {
                if config.enable_web_terminal {
                    Ok(())
                } else {
                    Err("web terminal is disabled in desktop Remote settings".to_string())
                }
            }
        }
    }

    fn ensure_terminal_stream_allowed(
        &self,
        frame: &proto::TerminalStreamFrame,
    ) -> Result<(), String> {
        let action = frame.kind.trim().to_ascii_lowercase();
        let request = proto::TerminalRequest {
            action: action.clone(),
            session_id: frame.session_id.clone(),
            project_path_key: frame.project_path_key.clone(),
            cols: frame.cols,
            rows: frame.rows,
            max_bytes: frame.max_bytes,
            ..Default::default()
        };
        match action.as_str() {
            "attach" | "input" | "resize" => {
                self.ensure_terminal_session_in_project(
                    &request.session_id,
                    &request.project_path_key,
                )?;
                self.ensure_terminal_request_allowed(&action, &request)
            }
            other => Err(format!("unsupported terminal stream frame: {other}")),
        }
    }

    pub(crate) async fn send_agent_envelope(
        &self,
        envelope: proto::AgentEnvelope,
    ) -> Result<(), String> {
        let sender = self.current_outbound_sender()?;
        send_agent_envelope_to(sender, envelope).await
    }

    fn current_outbound_sender(&self) -> Result<mpsc::Sender<proto::AgentEnvelope>, String> {
        self.outbound_tx
            .lock()
            .map_err(|_| "gateway outbound sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway outbound stream is offline".to_string())
    }

    fn current_terminal_stream_sender(
        &self,
    ) -> Result<mpsc::Sender<proto::TerminalStreamFrame>, String> {
        self.terminal_stream_tx
            .lock()
            .map_err(|_| "gateway terminal stream sender lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway terminal stream is offline".to_string())
    }

    fn spawn_uploaded_image_preview_response(
        &self,
        request_id: String,
        request: proto::UploadedImagePreviewRequest,
    ) -> Result<(), String> {
        let sender = self.current_outbound_sender()?;
        tauri::async_runtime::spawn(async move {
            let envelope = match gateway_bridge::handle_uploaded_image_preview(request).await {
                Ok(response) => proto::AgentEnvelope {
                    request_id,
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::UploadedImagePreviewResp(
                        response,
                    )),
                },
                Err(error) => build_error_response_envelope(request_id, 500, error),
            };
            if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                eprintln!("send gateway uploaded image preview response failed: {error}");
            }
        });
        Ok(())
    }

    async fn send_error_response(
        &self,
        request_id: String,
        code: i32,
        message: String,
    ) -> Result<(), String> {
        self.send_agent_envelope(build_error_response_envelope(request_id, code, message))
            .await
    }

    fn set_outbound_sender(&self, sender: Option<mpsc::Sender<proto::AgentEnvelope>>) {
        if let Ok(mut slot) = self.outbound_tx.lock() {
            *slot = sender;
        }
    }

    fn set_terminal_stream_sender(&self, sender: Option<mpsc::Sender<proto::TerminalStreamFrame>>) {
        if let Ok(mut slot) = self.terminal_stream_tx.lock() {
            *slot = sender;
        }
    }

    fn clear_terminal_stream_sender_if_current(
        &self,
        sender: &mpsc::Sender<proto::TerminalStreamFrame>,
    ) {
        if let Ok(mut slot) = self.terminal_stream_tx.lock() {
            if slot
                .as_ref()
                .map(|current| current.same_channel(sender))
                .unwrap_or(false)
            {
                *slot = None;
            }
        }
    }

    fn touch_heartbeat(&self) {
        self.publish_status(|status| {
            status.last_heartbeat = Some(now_unix_seconds());
        });
    }

    fn publish_status(&self, mutate: impl FnOnce(&mut GatewayStatusSnapshot)) {
        let next = if let Ok(mut status) = self.status.lock() {
            mutate(&mut status);
            status.clone()
        } else {
            return;
        };
        let _ = self.app_handle.emit("gateway:status", next);
    }

    async fn publish_current_settings_sync(&self) -> Result<(), String> {
        let snapshot = self.current_settings_snapshot().await?;
        self.publish_settings_sync(snapshot).await
    }

    async fn publish_current_terminal_sessions(&self) -> Result<(), String> {
        let sessions = self.terminal_registry.list(None).sessions;
        for session in sessions {
            self.send_agent_envelope(build_terminal_event_envelope(TerminalEventPayload {
                kind: "created".to_string(),
                session_id: session.id.clone(),
                project_path_key: session.project_path_key.clone(),
                session: Some(session),
                data: None,
                output_start_offset: None,
                output_end_offset: None,
                ssh_tabs: None,
            }))
            .await?;
        }
        Ok(())
    }

    pub async fn refresh_settings_sync_from_db(&self) -> Result<Value, String> {
        let snapshot = self.current_settings_snapshot().await?;
        self.app_handle
            .emit(GATEWAY_SETTINGS_SYNC_EVENT, snapshot.clone())
            .map_err(|e| format!("emit gateway settings sync failed: {e}"))?;
        self.publish_settings_sync(snapshot.clone()).await?;
        Ok(snapshot)
    }

    async fn handle_chat_command(
        self: &Arc<Self>,
        request_id: String,
        command: proto::ChatCommandRequest,
    ) -> Result<(), String> {
        match command.r#type.trim() {
            "chat.submit" => {
                let Some(request) = command.request else {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            String::new(),
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.submit requires request payload".to_string(),
                        )
                        .await;
                };
                let event_payload =
                    Self::build_gateway_chat_request_event(request_id, request, false, None);
                self.enqueue_gateway_chat_request(event_payload).await
            }
            "chat.edit_resend" => {
                let Some(request) = command.request else {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            String::new(),
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.edit_resend requires request payload".to_string(),
                        )
                        .await;
                };
                let conversation_id = request.conversation_id.trim().to_string();
                let Some(base_message_ref) = command.base_message_ref else {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            conversation_id,
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.edit_resend requires base_message_ref".to_string(),
                        )
                        .await;
                };
                if !is_complete_user_chat_message_ref(&base_message_ref) {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            conversation_id,
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.edit_resend requires a complete stable base_message_ref"
                                .to_string(),
                        )
                        .await;
                }
                if conversation_id.is_empty() {
                    return self
                        .send_gateway_chat_control_event_with_details(
                            request_id,
                            String::new(),
                            "failed",
                            "invalid_chat_command".to_string(),
                            "chat.edit_resend requires conversation_id".to_string(),
                        )
                        .await;
                }
                let event_payload = Self::build_gateway_chat_request_event(
                    request_id,
                    request,
                    true,
                    Some(base_message_ref),
                );
                self.enqueue_gateway_chat_request(event_payload).await
            }
            "chat.cancel" => {
                let conversation_id = command
                    .cancel
                    .map(|cancel| cancel.conversation_id)
                    .or_else(|| command.request.map(|request| request.conversation_id))
                    .unwrap_or_default();
                self.cancel_remote_chat_request(&request_id, &conversation_id)?;
                self.send_gateway_chat_control_event(
                    request_id.clone(),
                    conversation_id.clone(),
                    "cancelled",
                )
                .await?;
                self.app_handle
                    .emit(
                        "gateway:chat-cancel",
                        GatewayChatCancelEvent {
                            request_id,
                            conversation_id,
                        },
                    )
                    .map_err(|e| format!("emit gateway chat cancel failed: {e}"))
            }
            other => {
                self.send_gateway_chat_control_event_with_details(
                    request_id,
                    command
                        .request
                        .map(|request| request.conversation_id)
                        .unwrap_or_default(),
                    "failed",
                    "unsupported_chat_command".to_string(),
                    format!("unsupported chat command: {other}"),
                )
                .await
            }
        }
    }

    async fn enqueue_gateway_chat_request(
        &self,
        event_payload: GatewayChatRequestEvent,
    ) -> Result<(), String> {
        let enqueue_outcome = self.enqueue_remote_chat_request(event_payload)?;
        if let Err(error) = self
            .send_gateway_chat_control_event(
                enqueue_outcome.request_id.clone(),
                enqueue_outcome.conversation_id.clone(),
                enqueue_outcome.control_type,
            )
            .await
        {
            if enqueue_outcome.inserted {
                self.remove_remote_chat_request(&enqueue_outcome.request_id)?;
            }
            return Err(error);
        }
        if enqueue_outcome.should_wake_runtime {
            self.app_handle
                .emit(
                    "gateway:chat-request-ready",
                    json!({ "requestId": enqueue_outcome.request_id }),
                )
                .map_err(|e| format!("emit gateway chat request ready failed: {e}"))?;
        }
        Ok(())
    }

    fn build_gateway_chat_request_event(
        request_id: String,
        request: proto::ChatRequest,
        rebased: bool,
        base_message_ref: Option<proto::ChatMessageRef>,
    ) -> GatewayChatRequestEvent {
        let proto::ChatRequest {
            conversation_id,
            client_request_id,
            message,
            selected_model,
            runtime_controls,
            execution_mode,
            workdir,
            selected_system_tools,
            uploaded_files,
            queue_policy,
        } = request;
        let selected_model = selected_model.map(|selected_model| GatewaySelectedModelEvent {
            custom_provider_id: selected_model.custom_provider_id,
            model: selected_model.model,
            provider_type: selected_model.provider_type,
        });
        let runtime_controls =
            runtime_controls.map(|runtime_controls| GatewayChatRuntimeControlsEvent {
                thinking_enabled: runtime_controls.thinking_enabled,
                native_web_search_enabled: runtime_controls.native_web_search_enabled,
                reasoning: runtime_controls.reasoning,
            });
        let base_message_ref =
            base_message_ref.map(|base_message_ref| GatewayChatMessageRefEvent {
                segment_index: base_message_ref.segment_index,
                message_index: base_message_ref.message_index,
                segment_id: base_message_ref.segment_id,
                message_id: base_message_ref.message_id,
                role: base_message_ref.role,
                content_hash: base_message_ref.content_hash,
            });
        GatewayChatRequestEvent {
            request_id,
            conversation_id,
            client_request_id,
            message,
            rebased,
            base_message_ref,
            selected_model,
            runtime_controls,
            execution_mode,
            workdir,
            selected_system_tools,
            uploaded_files: uploaded_files
                .into_iter()
                .map(|file| GatewayUploadedFileEvent {
                    relative_path: file.relative_path,
                    absolute_path: file.absolute_path,
                    file_name: file.file_name,
                    kind: file.kind,
                    size_bytes: file.size_bytes,
                })
                .collect(),
            queue_policy,
        }
    }

    async fn current_settings_snapshot(&self) -> Result<Value, String> {
        let cached_snapshot = self
            .settings_snapshot
            .lock()
            .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?
            .clone();

        let db_snapshot = tauri::async_runtime::spawn_blocking(move || {
            let conn = open_db()?;
            load_gateway_settings_sync_snapshot(&conn)
        })
        .await
        .map_err(|e| format!("load gateway settings snapshot join failed: {e}"))??;

        let snapshot = merge_settings_sync_snapshot(db_snapshot, cached_snapshot.as_ref())?;
        self.store_settings_snapshot(snapshot)
    }

    fn store_settings_snapshot(&self, payload: Value) -> Result<Value, String> {
        let snapshot =
            redact_gateway_settings_sync_payload(normalize_settings_sync_payload(payload)?)?;
        let mut guard = self
            .settings_snapshot
            .lock()
            .map_err(|_| "gateway settings snapshot lock poisoned".to_string())?;
        *guard = Some(snapshot.clone());
        Ok(snapshot)
    }

    fn enqueue_remote_chat_request(
        &self,
        request: GatewayChatRequestEvent,
    ) -> Result<RemoteChatEnqueueOutcome, String> {
        let request_id = request.request_id.trim();
        if request_id.is_empty() {
            return Ok(RemoteChatEnqueueOutcome {
                request_id: String::new(),
                conversation_id: String::new(),
                control_type: "delivered",
                should_wake_runtime: false,
                inserted: false,
            });
        }
        let request_id = request_id.to_string();
        let client_request_id = request.client_request_id.trim().to_string();
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;

        let existing_request_id = if inbox.contains_key(&request_id) {
            Some(request_id.clone())
        } else if client_request_id.is_empty() {
            None
        } else {
            inbox.iter().find_map(|(candidate_request_id, record)| {
                if record.request.client_request_id.trim() == client_request_id {
                    Some(candidate_request_id.clone())
                } else {
                    None
                }
            })
        };

        if let Some(existing_request_id) = existing_request_id {
            let now = Instant::now();
            let record = inbox
                .get_mut(&existing_request_id)
                .ok_or_else(|| "remote chat request disappeared while enqueueing".to_string())?;
            Self::merge_duplicate_remote_chat_request(record, request, now);
            return Ok(RemoteChatEnqueueOutcome {
                request_id: existing_request_id,
                conversation_id: record.request.conversation_id.clone(),
                control_type: Self::remote_chat_record_control_type(record),
                should_wake_runtime: Self::remote_chat_record_should_wake_runtime(record, now),
                inserted: false,
            });
        }

        let now = Instant::now();
        inbox.insert(
            request_id.clone(),
            RemoteChatInboxRecord {
                request,
                state: "queued".to_string(),
                lease_owner: None,
                lease_expires_at: None,
                attempt: 0,
                started: false,
                last_error: None,
                created_at: now,
                updated_at: now,
            },
        );
        let conversation_id = inbox
            .get(request_id.as_str())
            .map(|record| record.request.conversation_id.clone())
            .unwrap_or_default();
        Ok(RemoteChatEnqueueOutcome {
            request_id,
            conversation_id,
            control_type: "delivered",
            should_wake_runtime: true,
            inserted: true,
        })
    }

    fn remove_remote_chat_request(&self, request_id: &str) -> Result<(), String> {
        let request_id = request_id.trim();
        if request_id.is_empty() {
            return Ok(());
        }
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
        inbox.remove(request_id);
        Ok(())
    }

    fn cancel_remote_chat_request(
        &self,
        request_id: &str,
        conversation_id: &str,
    ) -> Result<(), String> {
        let request_id = request_id.trim();
        let conversation_id = conversation_id.trim();
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
        if !request_id.is_empty() {
            inbox.remove(request_id);
        }
        if !conversation_id.is_empty() {
            inbox.retain(|_, record| {
                record.request.conversation_id.trim() != conversation_id
                    || !Self::remote_chat_record_should_cancel_for_conversation(record)
            });
        }
        Ok(())
    }

    fn merge_duplicate_remote_chat_request(
        record: &mut RemoteChatInboxRecord,
        request: GatewayChatRequestEvent,
        now: Instant,
    ) {
        // A reconnect can replay the same gateway request while the JS runner is
        // already processing it. Preserve local lease/owner/started state and
        // only fill metadata that may have been absent in the original payload.
        if !record.started && record.state.trim() == "queued" {
            let canonical_request_id = record.request.request_id.clone();
            record.request = request;
            record.request.request_id = canonical_request_id;
            record.updated_at = now;
            return;
        }
        if record.request.client_request_id.trim().is_empty()
            && !request.client_request_id.trim().is_empty()
        {
            record.request.client_request_id = request.client_request_id.clone();
        }
        if record.request.conversation_id.trim().is_empty()
            && !request.conversation_id.trim().is_empty()
        {
            record.request.conversation_id = request.conversation_id.clone();
        }
        record.updated_at = now;
    }

    fn remote_chat_record_control_type(record: &RemoteChatInboxRecord) -> &'static str {
        if record.started {
            return "started";
        }
        match record.state.trim() {
            "claimed" => "claimed",
            "starting" => "starting",
            "queued_in_gui" => "queued_in_gui",
            "running" => "started",
            "failed" => "failed",
            "cancelled" => "cancelled",
            "completed" => "completed",
            _ => "delivered",
        }
    }

    fn remote_chat_record_should_wake_runtime(
        record: &RemoteChatInboxRecord,
        now: Instant,
    ) -> bool {
        if record.started {
            return false;
        }
        match record.state.trim() {
            "queued" | "delivered" => true,
            "claimed" | "starting" => record
                .lease_expires_at
                .map(|expires_at| now >= expires_at)
                .unwrap_or(true),
            _ => false,
        }
    }

    fn remote_chat_record_should_cancel_for_conversation(record: &RemoteChatInboxRecord) -> bool {
        if record.started {
            return true;
        }
        matches!(record.state.trim(), "claimed" | "starting" | "running")
    }

    fn remote_chat_record_has_current_lease(
        record: &RemoteChatInboxRecord,
        worker_id: &str,
        now: Instant,
    ) -> bool {
        if worker_id.trim().is_empty() {
            return false;
        }
        if record.lease_owner.as_deref() != Some(worker_id) {
            return false;
        }
        record
            .lease_expires_at
            .map(|expires_at| now < expires_at)
            .unwrap_or(false)
    }

    fn remote_chat_record_is_owned_by_worker(
        record: &RemoteChatInboxRecord,
        worker_id: &str,
    ) -> bool {
        !worker_id.trim().is_empty() && record.lease_owner.as_deref() == Some(worker_id)
    }

    fn remote_chat_record_lease_ms(record: &RemoteChatInboxRecord) -> u64 {
        if record.started {
            GATEWAY_CHAT_RUNNING_LEASE_MS
        } else {
            GATEWAY_CHAT_LEASE_MS
        }
    }

    fn renew_remote_chat_request_lease(
        &self,
        request_id: &str,
        worker_id: Option<&str>,
        require_current: bool,
    ) -> Result<bool, String> {
        let request_id = request_id.trim();
        if request_id.is_empty() {
            return Ok(true);
        }
        let worker_id = worker_id.unwrap_or_default().trim();
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
        let Some(record) = inbox.get(request_id) else {
            return Ok(true);
        };
        let now = Instant::now();
        if require_current && !Self::remote_chat_record_has_current_lease(record, worker_id, now) {
            return Ok(false);
        }
        if !require_current && !Self::remote_chat_record_is_owned_by_worker(record, worker_id) {
            return Ok(false);
        }
        let lease_ms = Self::remote_chat_record_lease_ms(record);
        if let Some(record) = inbox.get_mut(request_id) {
            record.lease_expires_at = Some(now + Duration::from_millis(lease_ms));
            record.updated_at = now;
        }
        Ok(true)
    }

    pub async fn claim_next_chat_request(
        &self,
        worker_id: String,
        lease_ms: Option<u64>,
    ) -> Result<Option<GatewayChatClaimedRequest>, String> {
        let worker_id = worker_id.trim().to_string();
        if worker_id.is_empty() {
            return Err("worker_id is required".to_string());
        }
        let lease_ms = lease_ms
            .unwrap_or(GATEWAY_CHAT_LEASE_MS)
            .clamp(1_000, 120_000);
        let now = Instant::now();
        let claimed = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let mut selected_request_id: Option<String> = None;
            let mut selected_created_at: Option<Instant> = None;
            for (request_id, record) in inbox.iter() {
                let state = record.state.trim();
                let lease_expired = record
                    .lease_expires_at
                    .map(|expires_at| now >= expires_at)
                    .unwrap_or(true);
                if state == "queued"
                    || ((state == "claimed" || state == "starting")
                        && lease_expired
                        && !record.started)
                {
                    if selected_created_at
                        .map(|created_at| record.created_at < created_at)
                        .unwrap_or(true)
                    {
                        selected_request_id = Some(request_id.clone());
                        selected_created_at = Some(record.created_at);
                    }
                }
            }
            selected_request_id.and_then(|request_id| {
                inbox.get_mut(&request_id).map(|record| {
                    record.state = "claimed".to_string();
                    record.lease_owner = Some(worker_id.clone());
                    record.lease_expires_at = Some(now + Duration::from_millis(lease_ms));
                    record.attempt = record.attempt.saturating_add(1);
                    record.updated_at = now;
                    GatewayChatClaimedRequest {
                        request_id: record.request.request_id.clone(),
                        client_request_id: record.request.client_request_id.clone(),
                        conversation_id: record.request.conversation_id.clone(),
                        state: record.state.clone(),
                        attempt: record.attempt,
                        lease_ms,
                        request: record.request.clone(),
                    }
                })
            })
        };
        if let Some(claimed) = claimed.as_ref() {
            self.send_gateway_chat_control_event(
                claimed.request_id.clone(),
                claimed.conversation_id.clone(),
                "claimed",
            )
            .await?;
        }
        Ok(claimed)
    }

    pub async fn mark_chat_request_started(
        &self,
        request_id: String,
        conversation_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let now = Instant::now();
            let record = inbox
                .get_mut(&request_id)
                .ok_or_else(|| "remote chat request lease is no longer active".to_string())?;
            let queued_in_gui = record.state.trim() == "queued_in_gui" && !record.started;
            if !queued_in_gui
                && !Self::remote_chat_record_has_current_lease(record, &worker_id, now)
            {
                return Err("remote chat request lease is no longer active".to_string());
            }
            if record.started {
                return Ok(());
            }
            record.state = "running".to_string();
            record.started = true;
            record.lease_owner = Some(worker_id);
            if !conversation_id.is_empty() {
                record.request.conversation_id = conversation_id.clone();
            }
            record.lease_expires_at =
                Some(now + Duration::from_millis(GATEWAY_CHAT_RUNNING_LEASE_MS));
            record.updated_at = now;
        }
        self.ledger_mark_run_running(&request_id, &conversation_id)?;
        self.send_gateway_chat_control_event(request_id, conversation_id, "started")
            .await
    }

    pub async fn mark_local_chat_run_started(
        &self,
        request_id: String,
        conversation_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        if request_id.is_empty() || conversation_id.is_empty() {
            return Ok(());
        }
        self.ledger_mark_run_running(&request_id, &conversation_id)?;
        self.send_gateway_chat_control_event(request_id, conversation_id, "started")
            .await
    }

    pub async fn mark_chat_request_queued_in_gui(
        &self,
        request_id: String,
        conversation_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        let should_send = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let Some(record) = inbox.get_mut(&request_id) else {
                return Ok(());
            };
            if record.started {
                return Ok(());
            }
            if !Self::remote_chat_record_is_owned_by_worker(record, &worker_id) {
                return Ok(());
            }
            record.state = "queued_in_gui".to_string();
            record.lease_owner = None;
            record.lease_expires_at = None;
            if !conversation_id.is_empty() {
                record.request.conversation_id = conversation_id.clone();
            }
            record.updated_at = Instant::now();
            true
        };
        if !should_send {
            return Ok(());
        }
        self.send_gateway_chat_control_event(request_id, conversation_id, "queued_in_gui")
            .await
    }

    pub async fn complete_chat_request(
        &self,
        request_id: String,
        conversation_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        let should_send = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let Some(record) = inbox.get(&request_id) else {
                return Ok(());
            };
            if !Self::remote_chat_record_is_owned_by_worker(record, &worker_id) {
                return Ok(());
            }
            inbox.remove(&request_id);
            true
        };
        if !should_send {
            return Ok(());
        }
        // Ledger first: once the inbox record is gone this is the only place
        // that still knows the run finished, and the send below can fail.
        self.ledger_mark_run_terminal(
            &request_id,
            &conversation_id,
            ChatRunLedgerState::Completed,
            "",
            "",
        )?;
        self.send_gateway_chat_control_event(request_id.clone(), conversation_id, "completed")
            .await?;
        self.ledger_mark_run_terminal_sent(&request_id)
    }

    pub async fn fail_chat_request(
        &self,
        request_id: String,
        conversation_id: Option<String>,
        error_code: String,
        message: String,
        terminal: bool,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        let conversation_id = conversation_id.unwrap_or_default();
        // None: inbox record already gone; Some(true): accepted; Some(false): rejected.
        let inbox_outcome = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            match inbox.get_mut(&request_id) {
                None => None,
                Some(record) => {
                    let queued_in_gui = terminal && record.state.trim() == "queued_in_gui";
                    if !queued_in_gui
                        && !Self::remote_chat_record_is_owned_by_worker(record, &worker_id)
                    {
                        Some(false)
                    } else {
                        record.state = if terminal { "failed" } else { "queued" }.to_string();
                        record.lease_owner = None;
                        record.lease_expires_at = None;
                        record.last_error = Some(message.clone());
                        record.updated_at = Instant::now();
                        if terminal {
                            inbox.remove(&request_id);
                        }
                        Some(true)
                    }
                }
            }
        };
        match inbox_outcome {
            Some(false) => return Ok(()),
            Some(true) => {}
            None => {
                // The inbox record can be gone while the run is still live in
                // the ledger (e.g. a complete/fail race removed it). Dropping
                // this terminal would strand the WebUI, so repair via the
                // ledger instead of returning silently.
                if !terminal || !self.ledger_has_live_run(&request_id)? {
                    return Ok(());
                }
            }
        }
        if terminal {
            self.ledger_mark_run_terminal(
                &request_id,
                &conversation_id,
                ChatRunLedgerState::Failed,
                &error_code,
                &message,
            )?;
        }
        self.send_gateway_chat_control_event_with_details(
            request_id.clone(),
            conversation_id,
            "failed",
            error_code,
            message,
        )
        .await?;
        if terminal {
            self.ledger_mark_run_terminal_sent(&request_id)?;
        }
        Ok(())
    }

    pub async fn cancel_chat_request(
        &self,
        request_id: String,
        conversation_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        let should_send = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let Some(record) = inbox.get(&request_id) else {
                return Ok(());
            };
            let queued_in_gui = record.state.trim() == "queued_in_gui";
            if !queued_in_gui && !Self::remote_chat_record_is_owned_by_worker(record, &worker_id) {
                return Ok(());
            }
            inbox.remove(&request_id);
            true
        };
        if !should_send {
            return Ok(());
        }
        // This "cancelled" is a genuine run terminal, not a cancel-request ack:
        // the inbox record is removed above so no other terminal will ever be
        // produced for this request (callers use it to drop queued turns that
        // never start; running runs terminate via done/error/fail instead).
        // First-terminal-wins keeps this from clobbering an earlier outcome.
        self.ledger_mark_run_terminal(
            &request_id,
            &conversation_id,
            ChatRunLedgerState::Cancelled,
            "",
            "",
        )?;
        self.send_gateway_chat_control_event(request_id.clone(), conversation_id, "cancelled")
            .await?;
        self.ledger_mark_run_terminal_sent(&request_id)
    }

    pub fn heartbeat_chat_request(
        &self,
        request_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim();
        let worker_id = worker_id.trim();
        if request_id.is_empty() || worker_id.is_empty() {
            return Ok(());
        }
        {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            if let Some(record) = inbox.get_mut(request_id) {
                if record.lease_owner.as_deref() == Some(worker_id) {
                    let lease_ms = Self::remote_chat_record_lease_ms(record);
                    record.lease_expires_at =
                        Some(Instant::now() + Duration::from_millis(lease_ms));
                    record.updated_at = Instant::now();
                }
            }
        }
        self.ledger_touch_run(request_id, "")
    }

    pub async fn publish_chat_runtime_status(
        &self,
        worker_id: String,
        state: String,
        visible: bool,
        active_run_count: u32,
    ) -> Result<(), String> {
        let worker_id = worker_id.trim().to_string();
        if worker_id.is_empty() {
            return Ok(());
        }
        let state = match state.trim() {
            "draining" => "draining",
            "busy" => "busy",
            "suspended" => "suspended",
            _ => "ready",
        }
        .to_string();
        let (active_reports, finished_reports) = {
            let (now, _now_ms) = chat_run_ledger_now();
            let ledger = self
                .chat_run_ledger
                .lock()
                .map_err(|_| "gateway chat run ledger lock poisoned".to_string())?;
            (ledger.active_reports(now), ledger.recent_terminal_reports())
        };
        let active_run_count =
            active_run_count.max(u32::try_from(active_reports.len()).unwrap_or(u32::MAX));
        let envelope = build_gateway_runtime_status_envelope(
            worker_id,
            state,
            visible,
            active_run_count,
            active_reports
                .iter()
                .map(chat_run_report_from_entry)
                .collect(),
            finished_reports
                .iter()
                .map(chat_run_report_from_entry)
                .collect(),
        );
        match self.send_agent_envelope(envelope).await {
            Ok(()) => Ok(()),
            Err(error) if error.contains("outbound stream is offline") => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn release_chat_request_lease(
        &self,
        request_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim();
        let worker_id = worker_id.trim();
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
        if let Some(record) = inbox.get_mut(request_id) {
            if record.lease_owner.as_deref() == Some(worker_id) && !record.started {
                record.state = "queued".to_string();
                record.lease_owner = None;
                record.lease_expires_at = None;
                record.updated_at = Instant::now();
            }
        }
        Ok(())
    }

    async fn expire_remote_chat_leases(&self) -> Result<(), String> {
        let mut failed: Vec<(String, String)> = Vec::new();
        let mut wake = false;
        {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let now = Instant::now();
            for record in inbox.values_mut() {
                let Some(expires_at) = record.lease_expires_at else {
                    continue;
                };
                if now < expires_at {
                    continue;
                }
                if record.started {
                    record.state = "failed".to_string();
                    failed.push((
                        record.request.request_id.clone(),
                        record.request.conversation_id.clone(),
                    ));
                    continue;
                }
                record.state = "queued".to_string();
                record.lease_owner = None;
                record.lease_expires_at = None;
                record.updated_at = now;
                wake = true;
            }
            for (request_id, _) in &failed {
                inbox.remove(request_id);
            }
        }
        if wake {
            let _ = self.app_handle.emit(
                "gateway:chat-request-ready",
                json!({ "reason": "lease_expired" }),
            );
        }
        for (request_id, conversation_id) in failed {
            self.ledger_mark_run_terminal(
                &request_id,
                &conversation_id,
                ChatRunLedgerState::Failed,
                "desktop_runtime_lease_expired",
                "Desktop chat runtime stopped before completing the remote request.",
            )?;
            // One failed send must not abort the remaining terminals; the
            // ledger flush loop retries anything that stays unsent.
            match self
                .send_gateway_chat_control_event_with_details(
                    request_id.clone(),
                    conversation_id,
                    "failed",
                    "desktop_runtime_lease_expired".to_string(),
                    "Desktop chat runtime stopped before completing the remote request."
                        .to_string(),
                )
                .await
            {
                Ok(()) => self.ledger_mark_run_terminal_sent(&request_id)?,
                Err(error) => {
                    eprintln!("send gateway chat lease-expired terminal failed: {error}");
                }
            }
        }
        Ok(())
    }

    fn with_chat_run_ledger<T>(
        &self,
        f: impl FnOnce(&mut ChatRunLedger) -> T,
    ) -> Result<T, String> {
        let mut ledger = self
            .chat_run_ledger
            .lock()
            .map_err(|_| "gateway chat run ledger lock poisoned".to_string())?;
        Ok(f(&mut ledger))
    }

    fn ledger_mark_run_running(&self, run_id: &str, conversation_id: &str) -> Result<(), String> {
        let (now, now_ms) = chat_run_ledger_now();
        self.with_chat_run_ledger(|ledger| {
            ledger.mark_running(run_id, conversation_id, now, now_ms);
        })
    }

    fn ledger_touch_run(&self, run_id: &str, conversation_id: &str) -> Result<(), String> {
        let (now, now_ms) = chat_run_ledger_now();
        self.with_chat_run_ledger(|ledger| ledger.touch(run_id, conversation_id, now, now_ms))
    }

    fn ledger_mark_run_terminal(
        &self,
        run_id: &str,
        conversation_id: &str,
        state: ChatRunLedgerState,
        error_code: &str,
        message: &str,
    ) -> Result<bool, String> {
        let (now, now_ms) = chat_run_ledger_now();
        self.with_chat_run_ledger(|ledger| {
            ledger.mark_terminal(
                run_id,
                conversation_id,
                state,
                error_code,
                message,
                now,
                now_ms,
            )
        })
    }

    fn ledger_mark_run_terminal_sent(&self, run_id: &str) -> Result<(), String> {
        self.with_chat_run_ledger(|ledger| ledger.mark_terminal_sent(run_id))
    }

    fn ledger_has_live_run(&self, run_id: &str) -> Result<bool, String> {
        self.with_chat_run_ledger(|ledger| {
            ledger
                .get(run_id)
                .map(|entry| !entry.state.is_terminal())
                .unwrap_or(false)
        })
    }

    async fn flush_unsent_chat_run_terminals(&self) -> Result<(), String> {
        if !self.status().online {
            return Ok(());
        }
        let unsent = {
            let (now, now_ms) = chat_run_ledger_now();
            let mut ledger = self
                .chat_run_ledger
                .lock()
                .map_err(|_| "gateway chat run ledger lock poisoned".to_string())?;
            // Sweep first: runs demoted by the TTL become unsent terminals and
            // are picked up by this very flush.
            ledger.sweep(now, now_ms);
            ledger.unsent_terminals()
        };
        for entry in unsent {
            // The gateway cannot anchor a control event without a conversation
            // (it drops them at ingress); such entries only age out.
            if entry.conversation_id.is_empty() {
                continue;
            }
            match self
                .send_gateway_chat_control_event_with_details(
                    entry.run_id.clone(),
                    entry.conversation_id.clone(),
                    entry.state.as_str(),
                    entry.error_code.clone(),
                    entry.message.clone(),
                )
                .await
            {
                Ok(()) => self.ledger_mark_run_terminal_sent(&entry.run_id)?,
                Err(error) => {
                    eprintln!(
                        "flush gateway chat run terminal {} failed: {error}",
                        entry.run_id
                    );
                }
            }
        }
        Ok(())
    }

    async fn republish_chat_run_states(&self) -> Result<(), String> {
        let (active, recent_terminals) = {
            let (now, _now_ms) = chat_run_ledger_now();
            let ledger = self
                .chat_run_ledger
                .lock()
                .map_err(|_| "gateway chat run ledger lock poisoned".to_string())?;
            (ledger.active_reports(now), ledger.recent_terminal_reports())
        };
        for entry in active {
            if entry.conversation_id.is_empty() {
                continue;
            }
            // "started" is idempotent on the gateway; replaying it re-anchors
            // runs the gateway may have lost across a restart.
            if let Err(error) = self
                .send_gateway_chat_control_event(
                    entry.run_id.clone(),
                    entry.conversation_id.clone(),
                    "started",
                )
                .await
            {
                eprintln!(
                    "republish gateway chat run {} failed: {error}",
                    entry.run_id
                );
            }
        }
        // Replay all recent terminals, sent or not: a gateway restart can lose
        // them, and the control events are idempotent server-side. Unsent
        // terminals older than the recent window are covered by the periodic
        // flush a few seconds later.
        for entry in recent_terminals {
            if entry.conversation_id.is_empty() {
                continue;
            }
            if let Err(error) = self
                .send_gateway_chat_control_event_with_details(
                    entry.run_id.clone(),
                    entry.conversation_id.clone(),
                    entry.state.as_str(),
                    entry.error_code.clone(),
                    entry.message.clone(),
                )
                .await
            {
                eprintln!(
                    "republish gateway chat run terminal {} failed: {error}",
                    entry.run_id
                );
            } else {
                self.ledger_mark_run_terminal_sent(&entry.run_id)?;
            }
        }
        Ok(())
    }

    async fn send_gateway_chat_control_event(
        &self,
        request_id: String,
        conversation_id: String,
        event_type: &str,
    ) -> Result<(), String> {
        self.send_gateway_chat_control_event_with_details(
            request_id,
            conversation_id,
            event_type,
            String::new(),
            String::new(),
        )
        .await
    }

    async fn send_gateway_chat_control_event_with_details(
        &self,
        request_id: String,
        conversation_id: String,
        event_type: &str,
        error_code: String,
        message: String,
    ) -> Result<(), String> {
        self.send_agent_envelope(build_gateway_chat_control_event_envelope(
            request_id,
            conversation_id,
            event_type,
            error_code,
            message,
        ))
        .await
    }

    async fn handle_chat_queue_request(
        self: &Arc<Self>,
        request_id: String,
        request: proto::ChatQueueRequest,
    ) -> Result<(), String> {
        let event_payload = GatewayChatQueueRequestEvent {
            request_id: request_id.clone(),
            action: request.action,
            conversation_id: request.conversation_id,
            item_id: request.item_id,
            direction: request.direction,
            revision: request.revision,
            draft_json: request.draft_json,
            uploaded_files_json: request.uploaded_files_json,
            request_json: request.request_json,
        };

        let (tx, rx) = oneshot::channel();
        self.pending_chat_queue_requests
            .lock()
            .map_err(|_| "gateway chat queue request lock poisoned".to_string())?
            .insert(request_id.clone(), tx);

        if let Err(error) = self
            .app_handle
            .emit("gateway:chat-queue-request", event_payload)
        {
            let _ = self
                .pending_chat_queue_requests
                .lock()
                .map(|mut pending| pending.remove(&request_id));
            return self
                .send_chat_queue_response(
                    request_id,
                    proto::ChatQueueResponse {
                        accepted: false,
                        message: format!("emit gateway chat queue request failed: {error}"),
                        error_code: "emit_failed".to_string(),
                        ..Default::default()
                    },
                )
                .await;
        }

        let response = match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => proto::ChatQueueResponse {
                accepted: false,
                message: "chat queue response dropped".to_string(),
                error_code: "response_dropped".to_string(),
                ..Default::default()
            },
            Err(_) => {
                let _ = self
                    .pending_chat_queue_requests
                    .lock()
                    .map(|mut pending| pending.remove(&request_id));
                proto::ChatQueueResponse {
                    accepted: false,
                    message: "chat queue request timed out".to_string(),
                    error_code: "timeout".to_string(),
                    ..Default::default()
                }
            }
        };

        self.send_chat_queue_response(request_id, response).await
    }

    async fn send_chat_queue_response(
        &self,
        request_id: String,
        response: proto::ChatQueueResponse,
    ) -> Result<(), String> {
        self.send_agent_envelope(proto::AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::ChatQueueResp(response)),
        })
        .await
    }

    pub fn respond_chat_queue_request(
        &self,
        input: GatewayChatQueueResponseInput,
    ) -> Result<(), String> {
        let request_id = input.request_id.trim().to_string();
        if request_id.is_empty() {
            return Err("chat queue request_id is required".to_string());
        }
        let sender = self
            .pending_chat_queue_requests
            .lock()
            .map_err(|_| "gateway chat queue request lock poisoned".to_string())?
            .remove(&request_id);
        if let Some(sender) = sender {
            let _ = sender.send(proto::ChatQueueResponse {
                accepted: input.accepted,
                message: input.message,
                snapshot_json: input.snapshot_json,
                item_json: input.item_json,
                error_code: input.error_code,
                revision: input.revision,
            });
        }
        Ok(())
    }

    pub async fn publish_chat_queue_event(
        &self,
        input: GatewayChatQueueEventInput,
    ) -> Result<(), String> {
        self.send_agent_envelope(proto::AgentEnvelope {
            request_id: format!("chat-queue-event-{}", Uuid::new_v4()),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::ChatQueueEvent(
                proto::ChatQueueEvent {
                    conversation_id: input.conversation_id,
                    snapshot_json: input.snapshot_json,
                    revision: input.revision,
                },
            )),
        })
        .await
    }
}

async fn await_abortable_on_reconfigure<T>(
    config: &RemoteSettingsPayload,
    config_rx: &mut watch::Receiver<RemoteSettingsPayload>,
    fut: impl Future<Output = Result<T, String>>,
) -> Result<Option<T>, String> {
    tokio::pin!(fut);

    loop {
        tokio::select! {
            result = &mut fut => return result.map(Some),
            changed = config_rx.changed() => {
                if changed.is_err() {
                    return Ok(None);
                }
                let next = config_rx.borrow().clone();
                if next != *config {
                    return Ok(None);
                }
            }
        }
    }
}

fn merge_settings_sync_snapshot(snapshot: Value, cached: Option<&Value>) -> Result<Value, String> {
    let mut merged = match snapshot {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };

    if let Some(Value::Object(cached_map)) = cached {
        for field in UI_ONLY_SETTINGS_SYNC_FIELDS {
            if let Some(value) = cached_map.get(*field) {
                merged.insert((*field).to_string(), value.clone());
            }
        }
    }

    Ok(Value::Object(merged))
}

fn merge_settings_update_into_snapshot(snapshot: Value, update: Value) -> Result<Value, String> {
    let mut merged = match snapshot {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    let update = match update {
        Value::Object(map) => map,
        _ => return Err("gateway settings update payload must be an object".to_string()),
    };

    for (field, value) in update {
        // Remote settings are desktop-owned (loaded from the local DB on every
        // snapshot rebuild); never let a remote client overwrite them.
        if field == "remote" {
            continue;
        }
        merged.insert(field, value);
    }

    Ok(Value::Object(merged))
}

pub fn build_history_sync_upsert(summary: &ChatHistorySummary) -> GatewayHistorySyncEvent {
    GatewayHistorySyncEvent {
        kind: "upsert".to_string(),
        conversation_id: summary.id.clone(),
        conversation: Some(GatewayHistorySyncConversation {
            id: summary.id.clone(),
            title: summary.title.clone(),
            provider_id: Some(summary.provider_id.clone()),
            model: Some(summary.model.clone()),
            session_id: summary.session_id.clone(),
            cwd: summary.cwd.clone(),
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            message_count: summary.message_count,
            is_pinned: summary.is_pinned,
            pinned_at: summary.pinned_at,
            is_shared: summary.is_shared,
        }),
    }
}

pub fn build_history_sync_delete(conversation_id: impl Into<String>) -> GatewayHistorySyncEvent {
    let conversation_id = conversation_id.into();
    GatewayHistorySyncEvent {
        kind: "delete".to_string(),
        conversation_id,
        conversation: None,
    }
}

fn build_history_sync_upsert_from_proto(
    summary: &proto::ConversationSummary,
) -> GatewayHistorySyncEvent {
    GatewayHistorySyncEvent {
        kind: "upsert".to_string(),
        conversation_id: summary.id.clone(),
        conversation: Some(GatewayHistorySyncConversation {
            id: summary.id.clone(),
            title: summary.title.clone(),
            provider_id: (!summary.provider_id.trim().is_empty())
                .then(|| summary.provider_id.clone()),
            model: (!summary.model.trim().is_empty()).then(|| summary.model.clone()),
            session_id: (!summary.session_id.trim().is_empty()).then(|| summary.session_id.clone()),
            cwd: (!summary.cwd.trim().is_empty()).then(|| summary.cwd.clone()),
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            message_count: i64::from(summary.message_count),
            is_pinned: summary.is_pinned,
            pinned_at: (summary.pinned_at > 0).then_some(summary.pinned_at),
            is_shared: summary.is_shared,
        }),
    }
}

fn optional_proto_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn optional_proto_u16(value: u32) -> Option<u16> {
    if value == 0 {
        None
    } else {
        Some(value.min(u32::from(u16::MAX)) as u16)
    }
}

fn optional_proto_usize(value: u32) -> Option<usize> {
    (value > 0).then_some(value as usize)
}

fn required_terminal_project_path_key(value: &str) -> Result<String, String> {
    let project_path_key = normalize_project_path_key(value);
    if project_path_key.is_empty() {
        return Err("project_path_key is required".to_string());
    }
    Ok(project_path_key)
}

fn terminal_u128_to_u64(value: u128) -> u64 {
    value.min(u128::from(u64::MAX)) as u64
}

fn terminal_session_to_proto(session: TerminalSessionRecord) -> proto::TerminalSession {
    proto::TerminalSession {
        id: session.id,
        project_path_key: normalize_project_path_key(&session.project_path_key),
        cwd: session.cwd,
        shell: session.shell,
        title: session.title,
        pid: session.pid.unwrap_or_default(),
        cols: u32::from(session.cols),
        rows: u32::from(session.rows),
        created_at: terminal_u128_to_u64(session.created_at),
        updated_at: terminal_u128_to_u64(session.updated_at),
        finished_at: session
            .finished_at
            .map(terminal_u128_to_u64)
            .unwrap_or_default(),
        exit_code: session.exit_code.unwrap_or_default(),
        running: session.running,
        kind: if session.kind.trim() == "ssh" {
            "ssh".to_string()
        } else {
            "local".to_string()
        },
        ssh: session.ssh.map(|ssh| proto::TerminalSshMetadata {
            host_id: ssh.host_id,
            host_name: ssh.host_name,
            username: ssh.username,
            host: ssh.host,
            port: u32::from(ssh.port),
            auth_type: ssh.auth_type,
            status: ssh.status,
            reconnect_attempt: u32::from(ssh.reconnect_attempt),
            reconnect_max_attempts: u32::from(ssh.reconnect_max_attempts),
            sftp_enabled: ssh.sftp_enabled,
        }),
    }
}

fn terminal_shell_option_to_proto(option: TerminalShellOption) -> proto::TerminalShellOption {
    proto::TerminalShellOption {
        id: option.id,
        label: option.label,
        command: option.command,
    }
}

fn terminal_list_response_to_proto(
    action: String,
    sessions: Vec<TerminalSessionRecord>,
) -> proto::TerminalResponse {
    proto::TerminalResponse {
        action,
        sessions: sessions
            .into_iter()
            .map(terminal_session_to_proto)
            .collect(),
        session: None,
        output: Vec::new(),
        truncated: false,
        shell_options: Vec::new(),
        default_shell: String::new(),
        output_start_offset: 0,
        output_end_offset: 0,
        ssh_prompt: None,
        latency_ms: 0,
        ssh_tabs: None,
    }
}

fn terminal_record_response_to_proto(
    action: String,
    session: TerminalSessionRecord,
) -> proto::TerminalResponse {
    proto::TerminalResponse {
        action,
        sessions: Vec::new(),
        session: Some(terminal_session_to_proto(session)),
        output: Vec::new(),
        truncated: false,
        shell_options: Vec::new(),
        default_shell: String::new(),
        output_start_offset: 0,
        output_end_offset: 0,
        ssh_prompt: None,
        latency_ms: 0,
        ssh_tabs: None,
    }
}

fn terminal_create_snapshot_response_to_proto(
    action: String,
    snapshot: TerminalSnapshotResponse,
) -> proto::TerminalResponse {
    proto::TerminalResponse {
        action,
        sessions: Vec::new(),
        session: Some(terminal_session_to_proto(snapshot.session)),
        output: snapshot.output_bytes,
        truncated: snapshot.truncated,
        shell_options: Vec::new(),
        default_shell: String::new(),
        output_start_offset: snapshot.output_start_offset,
        output_end_offset: snapshot.output_end_offset,
        ssh_prompt: None,
        latency_ms: 0,
        ssh_tabs: None,
    }
}

fn terminal_ssh_create_response_to_proto(
    action: String,
    response: TerminalSshCreateResponse,
) -> proto::TerminalResponse {
    proto::TerminalResponse {
        action,
        sessions: Vec::new(),
        session: response.session.map(terminal_session_to_proto),
        output: response.output_bytes,
        truncated: response.truncated,
        shell_options: Vec::new(),
        default_shell: String::new(),
        output_start_offset: response.output_start_offset,
        output_end_offset: response.output_end_offset,
        ssh_prompt: response.ssh_prompt.map(|prompt| proto::TerminalSshPrompt {
            id: prompt.id,
            kind: prompt.kind,
            host_id: prompt.host_id,
            host_name: prompt.host_name,
            host: prompt.host,
            port: u32::from(prompt.port),
            message: prompt.message,
            fingerprint_sha256: prompt.fingerprint_sha256,
            key_type: prompt.key_type,
            answer_echo: prompt.answer_echo,
        }),
        latency_ms: 0,
        ssh_tabs: None,
    }
}

fn terminal_ssh_tabs_response_to_proto(
    action: String,
    snapshot: SshTerminalTabsSnapshot,
) -> proto::TerminalResponse {
    proto::TerminalResponse {
        action,
        sessions: Vec::new(),
        session: None,
        output: Vec::new(),
        truncated: false,
        shell_options: Vec::new(),
        default_shell: String::new(),
        output_start_offset: 0,
        output_end_offset: 0,
        ssh_prompt: None,
        latency_ms: 0,
        ssh_tabs: Some(ssh_terminal_tabs_to_proto(snapshot)),
    }
}

fn terminal_stream_snapshot_to_proto(
    stream_id: String,
    snapshot: TerminalStreamSnapshotResponse,
) -> proto::TerminalStreamFrame {
    let project_path_key = normalize_project_path_key(&snapshot.session.project_path_key);
    let session_id = snapshot.session.id.clone();
    proto::TerminalStreamFrame {
        kind: "snapshot".to_string(),
        stream_id,
        session_id,
        project_path_key,
        seq: 0,
        start_offset: snapshot.output_start_offset,
        end_offset: snapshot.output_end_offset,
        cols: u32::from(snapshot.session.cols),
        rows: u32::from(snapshot.session.rows),
        max_bytes: 0,
        truncated: snapshot.truncated,
        error: String::new(),
        session: Some(terminal_session_to_proto(snapshot.session)),
        data: snapshot.bytes,
    }
}

fn build_terminal_stream_output_frame(
    payload: TerminalStreamEventPayload,
) -> proto::TerminalStreamFrame {
    proto::TerminalStreamFrame {
        kind: payload.kind,
        stream_id: String::new(),
        session_id: payload.session_id,
        project_path_key: normalize_project_path_key(&payload.project_path_key),
        seq: 0,
        start_offset: payload.start_offset,
        end_offset: payload.end_offset,
        cols: 0,
        rows: 0,
        max_bytes: 0,
        truncated: false,
        error: String::new(),
        session: None,
        data: payload.bytes,
    }
}

fn terminal_stream_error_frame(
    stream_id: String,
    session_id: String,
    project_path_key: String,
    error: String,
) -> proto::TerminalStreamFrame {
    proto::TerminalStreamFrame {
        kind: "error".to_string(),
        stream_id,
        session_id,
        project_path_key: normalize_project_path_key(&project_path_key),
        seq: 0,
        start_offset: 0,
        end_offset: 0,
        cols: 0,
        rows: 0,
        max_bytes: 0,
        truncated: false,
        error,
        session: None,
        data: Vec::new(),
    }
}

fn ssh_terminal_tab_to_proto(tab: SshTerminalTabRecord) -> proto::TerminalSshTab {
    proto::TerminalSshTab {
        id: tab.id,
        session_id: tab.session_id,
        project_path_key: normalize_project_path_key(&tab.project_path_key),
        kind: tab.kind,
        created_at: tab.created_at as u64,
        updated_at: tab.updated_at as u64,
    }
}

fn ssh_terminal_tabs_to_proto(snapshot: SshTerminalTabsSnapshot) -> proto::TerminalSshTabsSnapshot {
    proto::TerminalSshTabsSnapshot {
        project_path_key: normalize_project_path_key(&snapshot.project_path_key),
        tabs: snapshot
            .tabs
            .into_iter()
            .map(ssh_terminal_tab_to_proto)
            .collect(),
        revision: snapshot.revision,
    }
}

fn sftp_side_path(side: &str, local_path: &str, remote_path: &str) -> String {
    if side.trim().eq_ignore_ascii_case("local") {
        local_path.trim().to_string()
    } else {
        remote_path.trim().to_string()
    }
}

fn sftp_entry_to_proto(entry: SftpEntry) -> proto::SftpEntry {
    proto::SftpEntry {
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        size_bytes: entry.size_bytes,
        mtime: entry.mtime,
    }
}

fn sftp_transfer_to_proto(transfer: SftpTransferState) -> proto::SftpTransfer {
    proto::SftpTransfer {
        id: transfer.id,
        session_id: transfer.session_id,
        direction: transfer.direction,
        status: transfer.status,
        source_path: transfer.source_path,
        target_path: transfer.target_path,
        current_path: transfer.current_path,
        bytes_done: transfer.bytes_done,
        bytes_total: transfer.bytes_total,
        files_done: transfer.files_done,
        files_total: transfer.files_total,
        error: transfer.error.unwrap_or_default(),
    }
}

fn sftp_list_response_to_proto(action: String, response: SftpListResponse) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response.path,
        entries: response
            .entries
            .into_iter()
            .map(sftp_entry_to_proto)
            .collect(),
        entry: None,
        exists: false,
        transfer: None,
    }
}

fn sftp_stat_response_to_proto(action: String, response: SftpStatResponse) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response
            .entry
            .as_ref()
            .map(|entry| entry.path.clone())
            .unwrap_or_default(),
        entries: Vec::new(),
        entry: response.entry.map(sftp_entry_to_proto),
        exists: response.exists,
        transfer: None,
    }
}

fn sftp_action_response_to_proto(
    action: String,
    response: SftpActionResponse,
) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response.path,
        entries: Vec::new(),
        entry: response.entry.map(sftp_entry_to_proto),
        exists: false,
        transfer: response.transfer.map(sftp_transfer_to_proto),
    }
}

fn sftp_transfer_response_to_proto(
    action: String,
    response: SftpTransferResponse,
) -> proto::SftpResponse {
    proto::SftpResponse {
        action,
        path: response.transfer.target_path.clone(),
        entries: Vec::new(),
        entry: None,
        exists: false,
        transfer: Some(sftp_transfer_to_proto(response.transfer)),
    }
}

fn build_terminal_event_envelope(payload: TerminalEventPayload) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id: format!("terminal-event-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::TerminalEvent(
            proto::TerminalEvent {
                kind: payload.kind,
                session_id: payload.session_id,
                project_path_key: normalize_project_path_key(&payload.project_path_key),
                session: payload.session.map(terminal_session_to_proto),
                data: payload.data.unwrap_or_default(),
                output_start_offset: payload.output_start_offset.unwrap_or_default(),
                output_end_offset: payload.output_end_offset.unwrap_or_default(),
                ssh_tabs: payload.ssh_tabs.map(ssh_terminal_tabs_to_proto),
            },
        )),
    }
}

fn build_sftp_event_envelope(payload: SftpEventPayload) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id: format!("sftp-event-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::SftpEvent(
            proto::SftpEvent {
                kind: payload.kind,
                transfer: Some(sftp_transfer_to_proto(payload.transfer)),
            },
        )),
    }
}

async fn send_agent_envelope_to(
    sender: mpsc::Sender<proto::AgentEnvelope>,
    envelope: proto::AgentEnvelope,
) -> Result<(), String> {
    sender
        .send(envelope)
        .await
        .map_err(|_| "gateway outbound stream closed".to_string())
}

fn build_error_response_envelope(
    request_id: String,
    code: i32,
    message: String,
) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id,
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::Error(
            proto::ErrorResponse { code, message },
        )),
    }
}

fn history_share_resolve_error_code(message: &str) -> i32 {
    let normalized = message.trim();
    if normalized.is_empty() {
        return 500;
    }
    if normalized.contains("分享 token 不能为空") {
        return 400;
    }
    if normalized.contains("分享链接不存在或已关闭") || normalized.contains("未找到对应的历史对话")
    {
        return 404;
    }
    500
}

fn build_settings_sync_envelope(payload: Value) -> Result<proto::AgentEnvelope, String> {
    Ok(proto::AgentEnvelope {
        request_id: format!("settings-sync-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::SettingsSync(
            proto::SettingsSyncEvent {
                settings_json: serialize_settings_sync_payload(&payload)?,
            },
        )),
    })
}

fn normalize_settings_sync_payload(payload: Value) -> Result<Value, String> {
    match payload {
        Value::Null => Ok(Value::Object(serde_json::Map::new())),
        Value::Object(_) => Ok(payload),
        _ => Err("gateway settings sync payload must be an object".to_string()),
    }
}

fn build_local_settings_update_event_payload(payload: Value) -> Result<Value, String> {
    let mut event = match payload {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    let provider_api_key_updates = event.remove(PROVIDER_API_KEY_UPDATES_FIELD);
    let ssh_secret_updates = event.remove(SSH_SECRET_UPDATES_FIELD);
    event.remove("remote");
    let mut public_event = match redact_gateway_settings_sync_payload(Value::Object(event))? {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    if let Some(updates) = provider_api_key_updates {
        public_event.insert(PROVIDER_API_KEY_UPDATES_FIELD.to_string(), updates);
    }
    if let Some(updates) = ssh_secret_updates {
        public_event.insert(SSH_SECRET_UPDATES_FIELD.to_string(), updates);
    }
    Ok(Value::Object(public_event))
}

fn build_local_settings_update_event_payload_with_ssh(
    payload: Value,
    ssh: Value,
) -> Result<Value, String> {
    let mut event = match payload {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    let provider_api_key_updates = event.remove(PROVIDER_API_KEY_UPDATES_FIELD);
    let ssh_secret_updates = event.remove(SSH_SECRET_UPDATES_FIELD);
    event.remove("remote");
    event.remove(SSH_PATCH_FIELD);
    event.insert("ssh".to_string(), ssh);
    let mut public_event = match redact_gateway_settings_sync_payload(Value::Object(event))? {
        Value::Object(map) => map,
        _ => return Err("gateway settings sync payload must be an object".to_string()),
    };
    if let Some(updates) = provider_api_key_updates {
        public_event.insert(PROVIDER_API_KEY_UPDATES_FIELD.to_string(), updates);
    }
    if let Some(updates) = ssh_secret_updates {
        public_event.insert(SSH_SECRET_UPDATES_FIELD.to_string(), updates);
    }
    Ok(Value::Object(public_event))
}

fn parse_settings_sync_payload(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let payload = serde_json::from_str::<Value>(trimmed)
        .map_err(|e| format!("parse gateway settings sync payload failed: {e}"))?;
    normalize_settings_sync_payload(payload)
}

fn serialize_settings_sync_payload(payload: &Value) -> Result<String, String> {
    serde_json::to_string(payload)
        .map_err(|e| format!("serialize gateway settings sync payload failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        build_chat_event_envelope, build_chat_runtime_snapshot_envelope, build_endpoint,
        build_gateway_runtime_status_envelope, build_grpc_url,
        build_local_settings_update_event_payload, chat_event_is_terminal,
        format_gateway_terminal_stream_rpc_error, history_share_resolve_error_code,
        merge_settings_sync_snapshot, merge_settings_update_into_snapshot, proto,
        queue_terminal_stream_handshake_frame, required_terminal_project_path_key,
        set_disconnected_status, GatewayChatRequestEvent, GatewayChatRuntimeSnapshot,
        GatewayController, GatewayStatusSnapshot, RemoteChatInboxRecord, GATEWAY_CHAT_LEASE_MS,
        GATEWAY_CHAT_RUNNING_LEASE_MS,
    };
    use crate::commands::settings::RemoteSettingsPayload;
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};

    fn gateway_chat_request(
        request_id: &str,
        client_request_id: &str,
        conversation_id: &str,
        message: &str,
    ) -> GatewayChatRequestEvent {
        GatewayChatRequestEvent {
            request_id: request_id.to_string(),
            conversation_id: conversation_id.to_string(),
            client_request_id: client_request_id.to_string(),
            message: message.to_string(),
            rebased: false,
            base_message_ref: None,
            selected_model: None,
            runtime_controls: None,
            execution_mode: String::new(),
            workdir: String::new(),
            selected_system_tools: Vec::new(),
            uploaded_files: Vec::new(),
            queue_policy: String::new(),
        }
    }

    fn remote_chat_record(
        request: GatewayChatRequestEvent,
        state: &str,
        started: bool,
        now: Instant,
    ) -> RemoteChatInboxRecord {
        RemoteChatInboxRecord {
            request,
            state: state.to_string(),
            lease_owner: Some("worker-1".to_string()),
            lease_expires_at: Some(now + Duration::from_secs(30)),
            attempt: 1,
            started,
            last_error: None,
            created_at: now - Duration::from_secs(10),
            updated_at: now,
        }
    }

    #[test]
    fn gateway_chat_command_mapping_preserves_rebase_signal() {
        let request = proto::ChatRequest {
            conversation_id: "conversation-1".to_string(),
            client_request_id: "client-1".to_string(),
            message: "edited".to_string(),
            execution_mode: "tools".to_string(),
            workdir: "/workspace".to_string(),
            selected_system_tools: vec!["http_get_test".to_string()],
            ..Default::default()
        };

        let event = GatewayController::build_gateway_chat_request_event(
            "run-1".to_string(),
            request,
            true,
            Some(proto::ChatMessageRef {
                segment_index: 2,
                message_index: 4,
                segment_id: "segment-c".to_string(),
                message_id: "user-c".to_string(),
                role: "user".to_string(),
                content_hash: "fnv1a32:00000000".to_string(),
            }),
        );

        assert_eq!(event.request_id, "run-1");
        assert_eq!(event.conversation_id, "conversation-1");
        assert_eq!(event.client_request_id, "client-1");
        assert_eq!(event.message, "edited");
        assert!(event.rebased);
        let base_message_ref = event
            .base_message_ref
            .as_ref()
            .expect("base message ref should be preserved");
        assert_eq!(base_message_ref.segment_index, 2);
        assert_eq!(base_message_ref.message_index, 4);
        assert_eq!(base_message_ref.segment_id, "segment-c");
        assert_eq!(base_message_ref.message_id, "user-c");
        assert_eq!(base_message_ref.role, "user");
        assert_eq!(base_message_ref.content_hash, "fnv1a32:00000000");
        assert_eq!(event.execution_mode, "tools");
        assert_eq!(event.workdir, "/workspace");
        assert_eq!(event.selected_system_tools, vec!["http_get_test"]);
    }

    #[test]
    fn chat_runtime_snapshot_envelope_preserves_live_projection() {
        let envelope = build_chat_runtime_snapshot_envelope(GatewayChatRuntimeSnapshot {
            conversation_id: " conversation-1 ".to_string(),
            run_id: " run-1 ".to_string(),
            client_request_id: Some("client-1".to_string()),
            worker_id: Some("worker-1".to_string()),
            state: " running ".to_string(),
            cwd: Some("/workspace".to_string()),
            updated_at: 1_772_000_000_000,
            revision: 7,
            entries_json: r#"[{"id":"u1","kind":"user","text":"hello","attachments":[]}]"#
                .to_string(),
            tool_status: Some("Thinking...".to_string()),
            tool_status_is_compaction: true,
        })
        .expect("runtime snapshot envelope should be valid");

        assert_eq!(envelope.request_id, "chat-runtime-snapshot-run-1-7");
        match envelope.payload {
            Some(proto::agent_envelope::Payload::ChatRuntimeSnapshot(snapshot)) => {
                assert_eq!(snapshot.conversation_id, "conversation-1");
                assert_eq!(snapshot.run_id, "run-1");
                assert_eq!(snapshot.client_request_id, "client-1");
                assert_eq!(snapshot.worker_id, "worker-1");
                assert_eq!(snapshot.state, "running");
                assert_eq!(snapshot.cwd, "/workspace");
                assert_eq!(snapshot.updated_at, 1_772_000_000_000);
                assert_eq!(snapshot.revision, 7);
                assert!(snapshot.entries_json.contains("hello"));
                assert_eq!(snapshot.tool_status, "Thinking...");
                assert!(snapshot.tool_status_is_compaction);
            }
            other => panic!("unexpected payload: {other:?}"),
        }
    }

    #[test]
    fn chat_runtime_snapshot_envelope_rejects_missing_identity() {
        let err = build_chat_runtime_snapshot_envelope(GatewayChatRuntimeSnapshot {
            conversation_id: "conversation-1".to_string(),
            run_id: " ".to_string(),
            client_request_id: None,
            worker_id: None,
            state: "running".to_string(),
            cwd: None,
            updated_at: 0,
            revision: 1,
            entries_json: String::new(),
            tool_status: None,
            tool_status_is_compaction: false,
        })
        .expect_err("empty run id should be rejected");

        assert!(err.contains("run_id"));
    }

    #[test]
    fn remote_chat_started_records_use_running_lease() {
        let now = Instant::now();
        let queued = remote_chat_record(
            gateway_chat_request("request-1", "client-1", "conversation-1", "hello"),
            "queued",
            false,
            now,
        );
        let running = remote_chat_record(
            gateway_chat_request("request-2", "client-2", "conversation-2", "hello"),
            "running",
            true,
            now,
        );

        assert_eq!(
            GatewayController::remote_chat_record_lease_ms(&queued),
            GATEWAY_CHAT_LEASE_MS
        );
        assert_eq!(
            GatewayController::remote_chat_record_lease_ms(&running),
            GATEWAY_CHAT_RUNNING_LEASE_MS
        );
        assert!(GATEWAY_CHAT_RUNNING_LEASE_MS > GATEWAY_CHAT_LEASE_MS);
    }

    #[test]
    fn duplicate_remote_chat_request_preserves_running_record() {
        let now = Instant::now();
        let mut record = remote_chat_record(
            gateway_chat_request("request-1", "client-1", "conversation-1", "first"),
            "running",
            true,
            now,
        );
        let original_lease_owner = record.lease_owner.clone();
        let original_lease_expires_at = record.lease_expires_at;

        GatewayController::merge_duplicate_remote_chat_request(
            &mut record,
            gateway_chat_request("request-2", "client-1", "conversation-2", "replayed"),
            now + Duration::from_secs(1),
        );

        assert_eq!(record.request.request_id, "request-1");
        assert_eq!(record.request.client_request_id, "client-1");
        assert_eq!(record.request.conversation_id, "conversation-1");
        assert_eq!(record.request.message, "first");
        assert_eq!(record.state, "running");
        assert!(record.started);
        assert_eq!(record.lease_owner, original_lease_owner);
        assert_eq!(record.lease_expires_at, original_lease_expires_at);
        assert_eq!(
            GatewayController::remote_chat_record_control_type(&record),
            "started"
        );
        assert!(!GatewayController::remote_chat_record_should_wake_runtime(
            &record,
            now + Duration::from_secs(1),
        ));
    }

    #[test]
    fn duplicate_queued_remote_chat_request_keeps_canonical_request_id() {
        let now = Instant::now();
        let mut record = remote_chat_record(
            gateway_chat_request("request-1", "client-1", "conversation-1", "first"),
            "queued",
            false,
            now,
        );
        record.lease_owner = None;
        record.lease_expires_at = None;

        GatewayController::merge_duplicate_remote_chat_request(
            &mut record,
            gateway_chat_request("request-2", "client-1", "conversation-2", "replayed"),
            now + Duration::from_secs(1),
        );

        assert_eq!(record.request.request_id, "request-1");
        assert_eq!(record.request.client_request_id, "client-1");
        assert_eq!(record.request.conversation_id, "conversation-2");
        assert_eq!(record.request.message, "replayed");
        assert_eq!(record.state, "queued");
        assert!(!record.started);
        assert!(GatewayController::remote_chat_record_should_wake_runtime(
            &record,
            now + Duration::from_secs(1),
        ));
    }

    #[test]
    fn conversation_cancel_preserves_gui_queued_remote_requests() {
        let now = Instant::now();
        let queued_in_gui = remote_chat_record(
            gateway_chat_request("request-1", "client-1", "conversation-1", "first"),
            "queued_in_gui",
            false,
            now,
        );
        let queued = remote_chat_record(
            gateway_chat_request("request-2", "client-2", "conversation-1", "second"),
            "queued",
            false,
            now,
        );
        let claimed = remote_chat_record(
            gateway_chat_request("request-3", "client-3", "conversation-1", "third"),
            "claimed",
            false,
            now,
        );
        let running = remote_chat_record(
            gateway_chat_request("request-4", "client-4", "conversation-1", "fourth"),
            "running",
            true,
            now,
        );

        assert!(
            !GatewayController::remote_chat_record_should_cancel_for_conversation(&queued_in_gui)
        );
        assert!(!GatewayController::remote_chat_record_should_cancel_for_conversation(&queued));
        assert!(GatewayController::remote_chat_record_should_cancel_for_conversation(&claimed));
        assert!(GatewayController::remote_chat_record_should_cancel_for_conversation(&running));
    }

    #[test]
    fn history_share_resolve_error_code_maps_public_share_failures() {
        assert_eq!(history_share_resolve_error_code("分享 token 不能为空"), 400);
        assert_eq!(
            history_share_resolve_error_code("分享链接不存在或已关闭"),
            404
        );
        assert_eq!(
            history_share_resolve_error_code("未找到对应的历史对话"),
            404
        );
        assert_eq!(
            history_share_resolve_error_code("读取历史对话分享链接失败：db"),
            500
        );
    }

    #[test]
    fn merge_settings_sync_snapshot_keeps_cached_ui_only_fields() {
        let db_snapshot = json!({
            "system": { "executionMode": "agent-dev" },
            "cron": [{ "id": "cron-a" }],
            "theme": "light",
            "locale": "zh-CN",
            "skills": {},
            "chatRuntimeControls": {
                "thinkingEnabled": true,
                "nativeWebSearchEnabled": true,
                "reasoning": "high"
            },
            "customSettings": {},
            "selectedModel": null,
        });
        let cached_snapshot = json!({
            "theme": "dark",
            "locale": "en-US",
            "skills": { "enabled": true },
            "chatRuntimeControls": {
                "thinkingEnabled": false,
                "nativeWebSearchEnabled": false,
                "reasoning": "xhigh"
            },
            "customSettings": {
                "conversationTitleModel": {
                    "customProviderId": "provider-a",
                    "model": "gpt-5-mini"
                }
            },
            "selectedModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            },
        });

        let merged = merge_settings_sync_snapshot(db_snapshot, Some(&cached_snapshot))
            .expect("merge settings sync snapshot");

        assert_eq!(merged["cron"], json!([{ "id": "cron-a" }]));
        assert_eq!(merged["theme"], json!("dark"));
        assert_eq!(merged["locale"], json!("en-US"));
        assert_eq!(merged["skills"], json!({ "enabled": true }));
        assert_eq!(
            merged["chatRuntimeControls"],
            json!({
                "thinkingEnabled": false,
                "nativeWebSearchEnabled": false,
                "reasoning": "xhigh"
            })
        );
        assert_eq!(
            merged["customSettings"],
            json!({
                "conversationTitleModel": {
                    "customProviderId": "provider-a",
                    "model": "gpt-5-mini"
                }
            })
        );
        assert_eq!(
            merged["selectedModel"],
            json!({
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            })
        );
    }

    #[test]
    fn merge_settings_sync_snapshot_without_cache_leaves_ui_only_fields_absent() {
        let db_snapshot = json!({
            "system": { "executionMode": "agent-dev" },
            "cron": [{ "id": "cron-a" }],
        });

        let merged =
            merge_settings_sync_snapshot(db_snapshot, None).expect("merge settings sync snapshot");

        let merged_map = merged.as_object().expect("merged snapshot object");
        assert!(!merged_map.contains_key("theme"));
        assert!(!merged_map.contains_key("locale"));
        assert!(!merged_map.contains_key("selectedModel"));
        assert_eq!(merged["system"], json!({ "executionMode": "agent-dev" }));
    }

    #[test]
    fn merge_settings_update_into_snapshot_keeps_unrelated_fields() {
        let full_snapshot = json!({
            "system": { "executionMode": "agent-dev" },
            "theme": "dark",
            "locale": "en-US",
            "selectedModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            },
            "remote": { "enableWebTerminal": true },
        });
        let partial_update = json!({
            "theme": "system",
            "remote": { "enableWebTerminal": false },
        });

        let merged = merge_settings_update_into_snapshot(full_snapshot, partial_update)
            .expect("merge settings update into snapshot");

        assert_eq!(merged["theme"], json!("system"));
        assert_eq!(merged["locale"], json!("en-US"));
        assert_eq!(
            merged["selectedModel"],
            json!({
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            })
        );
        assert_eq!(merged["system"], json!({ "executionMode": "agent-dev" }));
        // Remote settings are desktop-owned and must not be overwritten by clients.
        assert_eq!(merged["remote"], json!({ "enableWebTerminal": true }));
    }

    #[test]
    fn local_settings_update_event_keeps_private_api_key_updates_only_at_root() {
        let payload = json!({
            "customProviders": [
                {
                    "id": "provider-a",
                    "name": "A",
                    "apiKey": "leaked-key"
                }
            ],
            "remote": {
                "enableWebTerminal": true
            },
            "providerApiKeyUpdates": {
                "provider-a": "new-key"
            }
        });

        let event_payload =
            build_local_settings_update_event_payload(payload).expect("build event payload");
        assert_eq!(event_payload.get("remote"), None);
        assert_eq!(event_payload["customProviders"][0]["apiKey"], Value::Null);
        assert_eq!(
            event_payload["customProviders"][0]["apiKeyConfigured"],
            true
        );
        assert_eq!(
            event_payload["providerApiKeyUpdates"]["provider-a"],
            "new-key"
        );
    }

    #[test]
    fn terminal_project_path_key_is_required_for_gateway_requests() {
        assert_eq!(
            required_terminal_project_path_key(" /workspace/project ").as_deref(),
            Ok("/workspace/project")
        );
        assert_eq!(
            required_terminal_project_path_key(r" C:\Repo\ ").as_deref(),
            Ok("c:/repo")
        );
        assert!(required_terminal_project_path_key(" ").is_err());
    }

    #[test]
    fn set_disconnected_status_resets_runtime_fields_for_new_config() {
        let config = RemoteSettingsPayload {
            enabled: true,
            gateway_url: "https://gateway.example.com".to_string(),
            grpc_port: 50051,
            grpc_endpoint: String::new(),
            token: "dev-token".to_string(),
            agent_id: "agent-new".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
            enable_web_terminal: false,
            enable_web_ssh_terminal: false,
            enable_web_git: false,
            enable_web_tunnels: false,
        };
        let mut status = GatewayStatusSnapshot {
            online: true,
            enabled: true,
            configured: true,
            gateway_url: "https://old-gateway.example.com".to_string(),
            agent_id: "agent-old".to_string(),
            session_id: Some("session-123".to_string()),
            connected_since: Some(123),
            last_heartbeat: Some(456),
            last_error: Some("previous error".to_string()),
        };

        set_disconnected_status(
            &mut status,
            &config,
            Some("connect gateway failed".to_string()),
        );

        assert!(!status.online);
        assert!(status.enabled);
        assert!(status.configured);
        assert_eq!(status.gateway_url, "https://gateway.example.com");
        assert_eq!(status.agent_id, "agent-new");
        assert_eq!(status.session_id, None);
        assert_eq!(status.connected_since, None);
        assert_eq!(status.last_heartbeat, None);
        assert_eq!(status.last_error.as_deref(), Some("connect gateway failed"));
    }

    #[test]
    fn build_https_gateway_endpoint_initializes_tls_provider() {
        build_endpoint("https://agent.cnweb.org:443").expect("build https gateway endpoint");
    }

    #[test]
    fn build_grpc_url_prefers_explicit_endpoint() {
        let config = RemoteSettingsPayload {
            enabled: true,
            gateway_url: "https://gateway.example.com".to_string(),
            grpc_port: 50051,
            grpc_endpoint: "tcp.proxy.rlwy.net:12345".to_string(),
            token: "dev-token".to_string(),
            agent_id: "agent".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
            enable_web_terminal: false,
            enable_web_ssh_terminal: false,
            enable_web_git: false,
            enable_web_tunnels: false,
        };

        let grpc_url = build_grpc_url(&config).expect("build explicit gRPC endpoint");

        assert_eq!(grpc_url, "http://tcp.proxy.rlwy.net:12345");
    }

    #[test]
    fn terminal_stream_handshake_frame_is_gateway_noop() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<proto::TerminalStreamFrame>(1);

        queue_terminal_stream_handshake_frame(&sender).expect("queue terminal stream handshake");

        let frame = receiver
            .try_recv()
            .expect("terminal stream handshake frame");
        assert_eq!(frame.kind, "detach");
        assert!(frame.stream_id.starts_with("desktop-handshake-"));
        assert!(frame.session_id.is_empty());
    }

    #[test]
    fn terminal_stream_h2_error_points_to_grpc_endpoint() {
        let config = RemoteSettingsPayload {
            enabled: true,
            gateway_url: "https://gateway.example.com".to_string(),
            grpc_port: 443,
            grpc_endpoint: String::new(),
            token: "dev-token".to_string(),
            agent_id: "agent".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
            enable_web_terminal: true,
            enable_web_ssh_terminal: true,
            enable_web_git: false,
            enable_web_tunnels: false,
        };

        let message = format_gateway_terminal_stream_rpc_error(
            "receive",
            &tonic::Status::internal("h2 protocol error: http2 error"),
            &config,
        );

        assert!(message.contains("receive failed"));
        assert!(message.contains("HTTP/2 bidi streams"));
        assert!(message.contains("https://gateway.example.com"));
    }

    #[test]
    fn build_chat_event_envelope_preserves_tool_result_arguments() {
        let envelope = build_chat_event_envelope(
            "request-1".to_string(),
            json!({
                "type": "tool_result",
                "conversation_id": "conversation-1",
                "id": "bash-call",
                "name": "Bash",
                "arguments": {
                    "command": "printf live",
                    "cwd": "crates/agent-gateway"
                },
                "content": [{ "type": "text", "text": "live" }],
                "isError": false,
                "round": 1
            }),
        )
        .expect("build chat event envelope");

        let chat_event = match envelope.payload.expect("payload") {
            super::proto::agent_envelope::Payload::ChatEvent(event) => event,
            _ => panic!("expected chat event payload"),
        };
        assert_eq!(chat_event.conversation_id, "conversation-1");
        assert_eq!(
            chat_event.r#type,
            super::proto::chat_event::ChatEventType::ToolResult as i32
        );

        let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
        assert_eq!(data["arguments"]["command"], "printf live");
        assert_eq!(data["arguments"]["cwd"], "crates/agent-gateway");
    }

    #[test]
    fn build_chat_event_envelope_preserves_title_final_flag() {
        let envelope = build_chat_event_envelope(
            "request-1".to_string(),
            json!({
                "type": "token",
                "conversation_id": "conversation-1",
                "text": "",
                "title": "Final title",
                "titleFinal": true
            }),
        )
        .expect("build chat title event envelope");

        let chat_event = match envelope.payload.expect("payload") {
            super::proto::agent_envelope::Payload::ChatEvent(event) => event,
            _ => panic!("expected chat event payload"),
        };
        assert_eq!(chat_event.conversation_id, "conversation-1");
        assert_eq!(
            chat_event.r#type,
            super::proto::chat_event::ChatEventType::Token as i32
        );

        let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
        assert_eq!(data["title"], "Final title");
        assert_eq!(data["titleFinal"], true);
    }

    #[test]
    fn build_chat_event_envelope_preserves_hosted_search_payload() {
        let envelope = build_chat_event_envelope(
            "request-1".to_string(),
            json!({
                "type": "hosted_search",
                "conversation_id": "conversation-1",
                "id": "search-1",
                "provider": "codex",
                "status": "completed",
                "queries": ["设计模式定义"],
                "sources": [
                    {
                        "url": "https://example.com/pattern",
                        "title": "设计模式",
                        "sourceType": "citation"
                    }
                ],
                "updatedAt": 1234,
                "round": 2
            }),
        )
        .expect("build hosted search event envelope");

        let chat_event = match envelope.payload.expect("payload") {
            super::proto::agent_envelope::Payload::ChatEvent(event) => event,
            _ => panic!("expected chat event payload"),
        };
        assert_eq!(chat_event.conversation_id, "conversation-1");
        assert_eq!(
            chat_event.r#type,
            super::proto::chat_event::ChatEventType::HostedSearch as i32
        );

        let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
        assert_eq!(data["id"], "search-1");
        assert_eq!(data["provider"], "codex");
        assert_eq!(data["status"], "completed");
        assert_eq!(data["queries"][0], "设计模式定义");
        assert_eq!(data["sources"][0]["url"], "https://example.com/pattern");
        assert_eq!(data["updatedAt"], 1234);
        assert_eq!(data["round"], 2);
    }

    #[test]
    fn build_chat_event_envelope_preserves_user_message_payload() {
        let envelope = build_chat_event_envelope(
            "request-1".to_string(),
            json!({
                "type": "user_message",
                "conversation_id": "conversation-1",
                "message": "queued prompt",
                "uploaded_files": [
                    {
                        "relativePath": "notes.md",
                        "absolutePath": "/workspace/notes.md",
                        "fileName": "notes.md",
                        "kind": "text",
                        "sizeBytes": 12
                    }
                ],
                "execution_mode": "agent"
            }),
        )
        .expect("build user message event envelope");

        let chat_event = match envelope.payload.expect("payload") {
            super::proto::agent_envelope::Payload::ChatEvent(event) => event,
            _ => panic!("expected chat event payload"),
        };
        assert_eq!(chat_event.conversation_id, "conversation-1");
        assert_eq!(
            chat_event.r#type,
            super::proto::chat_event::ChatEventType::UserMessage as i32
        );

        let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
        assert_eq!(data["message"], "queued prompt");
        assert_eq!(data["uploaded_files"][0]["relativePath"], "notes.md");
        assert_eq!(data["uploaded_files"][0]["kind"], "text");
        assert_eq!(data["execution_mode"], "agent");
    }

    #[test]
    fn chat_event_terminal_detection_covers_done_and_error_only() {
        assert!(chat_event_is_terminal(&json!({ "type": "done" })));
        assert!(chat_event_is_terminal(
            &json!({ "type": "error", "message": "boom" })
        ));
        assert!(chat_event_is_terminal(&json!({ "type": " done " })));
        assert!(!chat_event_is_terminal(
            &json!({ "type": "token", "text": "hi" })
        ));
        assert!(!chat_event_is_terminal(&json!({ "type": "tool_call" })));
        assert!(!chat_event_is_terminal(&json!({ "kind": "done" })));
        assert!(!chat_event_is_terminal(&json!("done")));
    }

    #[test]
    fn runtime_status_envelope_carries_run_reports() {
        let active_run = proto::ChatRunReport {
            run_id: "run-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            state: "running".to_string(),
            error_code: String::new(),
            message: String::new(),
            updated_at: 1_772_000_000_000,
        };
        let finished_run = proto::ChatRunReport {
            run_id: "run-2".to_string(),
            conversation_id: "conversation-2".to_string(),
            state: "failed".to_string(),
            error_code: "desktop_run_lost".to_string(),
            message: "The desktop runtime stopped reporting this run.".to_string(),
            updated_at: 1_772_000_000_500,
        };

        let envelope = build_gateway_runtime_status_envelope(
            "worker-1".to_string(),
            "busy".to_string(),
            true,
            2,
            vec![active_run],
            vec![finished_run],
        );

        let status = match envelope.payload.expect("payload") {
            super::proto::agent_envelope::Payload::RuntimeStatus(status) => status,
            _ => panic!("expected runtime status payload"),
        };
        assert_eq!(status.worker_id, "worker-1");
        assert_eq!(status.state, "busy");
        assert!(status.visible);
        assert_eq!(status.active_run_count, 2);
        assert_eq!(status.active_runs.len(), 1);
        assert_eq!(status.active_runs[0].run_id, "run-1");
        assert_eq!(status.active_runs[0].state, "running");
        assert_eq!(status.active_runs[0].updated_at, 1_772_000_000_000);
        assert_eq!(status.finished_runs.len(), 1);
        assert_eq!(status.finished_runs[0].run_id, "run-2");
        assert_eq!(status.finished_runs[0].state, "failed");
        assert_eq!(status.finished_runs[0].error_code, "desktop_run_lost");
        assert_eq!(
            status.finished_runs[0].message,
            "The desktop runtime stopped reporting this run."
        );
    }
}

fn chat_event_type(event: &Value) -> Option<&str> {
    event.get("type").and_then(Value::as_str).map(str::trim)
}

fn chat_event_is_terminal(event: &Value) -> bool {
    matches!(chat_event_type(event), Some("done") | Some("error"))
}

fn chat_event_conversation_id(event: &Value) -> String {
    event
        .as_object()
        .and_then(|object| {
            optional_string_field(object, "conversation_id")
                .or_else(|| optional_string_field(object, "conversationId"))
        })
        .unwrap_or_default()
}

fn build_chat_event_envelope(
    request_id: String,
    event: Value,
) -> Result<proto::AgentEnvelope, String> {
    let object = event
        .as_object()
        .ok_or_else(|| "gateway chat event payload must be an object".to_string())?;
    let event_type = string_field(object, "type")?;
    let conversation_id = optional_string_field(object, "conversation_id")
        .or_else(|| optional_string_field(object, "conversationId"))
        .unwrap_or_default();

    let (event_kind, data) = match event_type.as_str() {
        "token" => (
            proto::chat_event::ChatEventType::Token as i32,
            json!({
                "text": required_raw_string_field(object, "text")?,
                "title": optional_string_field(object, "title"),
                "titleFinal": object.get("titleFinal").and_then(Value::as_bool).unwrap_or(false),
                "round": optional_number_field(object, "round"),
                "provider": optional_string_field(object, "provider"),
                "model": optional_string_field(object, "model"),
                "api": optional_string_field(object, "api"),
                "stopReason": optional_string_field(object, "stopReason")
                    .or_else(|| optional_string_field(object, "stop_reason")),
                "usage": object.get("usage").cloned().unwrap_or(Value::Null),
                "checkpoint": object.get("checkpoint").cloned().unwrap_or(Value::Null),
            }),
        ),
        "thinking" => (
            proto::chat_event::ChatEventType::Thinking as i32,
            json!({
                "text": required_raw_string_field(object, "text")?,
                "round": optional_number_field(object, "round"),
            }),
        ),
        "tool_call" | "tool_call_delta" => (
            proto::chat_event::ChatEventType::ToolCall as i32,
            json!({
                "type": event_type,
                "id": optional_string_field(object, "id"),
                "name": optional_string_field(object, "name"),
                "arguments": object.get("arguments").cloned().unwrap_or(Value::Null),
                "round": optional_number_field(object, "round"),
            }),
        ),
        "tool_result" => (
            proto::chat_event::ChatEventType::ToolResult as i32,
            json!({
                "id": optional_string_field(object, "id"),
                "name": optional_string_field(object, "name"),
                "arguments": object.get("arguments").cloned().unwrap_or(Value::Null),
                "content": object.get("content").cloned().unwrap_or(Value::Null),
                "details": object.get("details").cloned().unwrap_or(Value::Null),
                "isError": object.get("isError").and_then(Value::as_bool).unwrap_or(false),
                "round": optional_number_field(object, "round"),
            }),
        ),
        "hosted_search" => (
            proto::chat_event::ChatEventType::HostedSearch as i32,
            json!({
                "id": optional_string_field(object, "id"),
                "provider": optional_string_field(object, "provider"),
                "status": optional_string_field(object, "status"),
                "queries": object.get("queries").cloned().unwrap_or(Value::Null),
                "sources": object.get("sources").cloned().unwrap_or(Value::Null),
                "updatedAt": object.get("updatedAt").cloned().unwrap_or(Value::Null),
                "round": optional_number_field(object, "round"),
            }),
        ),
        "user_message" => (
            proto::chat_event::ChatEventType::UserMessage as i32,
            json!({
                "message": required_raw_string_field(object, "message")?,
                "uploaded_files": object.get("uploaded_files")
                    .or_else(|| object.get("uploadedFiles"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "execution_mode": optional_string_field(object, "execution_mode")
                    .or_else(|| optional_string_field(object, "executionMode")),
                "workdir": optional_string_field(object, "workdir"),
                "selected_system_tools": object.get("selected_system_tools")
                    .or_else(|| object.get("selectedSystemTools"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "runtime_controls": object.get("runtime_controls")
                    .or_else(|| object.get("runtimeControls"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "selected_model": object.get("selected_model")
                    .or_else(|| object.get("selectedModel"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "base_message_ref": object.get("base_message_ref")
                    .or_else(|| object.get("baseMessageRef"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "reason": optional_string_field(object, "reason"),
            }),
        ),
        "done" => (
            proto::chat_event::ChatEventType::Done as i32,
            json!({
                "round": optional_number_field(object, "round"),
            }),
        ),
        "error" => (
            proto::chat_event::ChatEventType::Error as i32,
            json!({
                "message": required_string_field(object, "message")?,
                "round": optional_number_field(object, "round"),
            }),
        ),
        "tool_status" => (
            proto::chat_event::ChatEventType::ToolStatus as i32,
            json!({
                "status": object.get("status").cloned().unwrap_or(Value::Null),
                "isCompaction": object.get("isCompaction").and_then(Value::as_bool).unwrap_or(false),
                "round": optional_number_field(object, "round"),
            }),
        ),
        other => return Err(format!("unsupported gateway chat event type: {other}")),
    };

    Ok(proto::AgentEnvelope {
        request_id,
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::ChatEvent(
            proto::ChatEvent {
                r#type: event_kind,
                conversation_id,
                data: serde_json::to_string(&data)
                    .map_err(|e| format!("serialize gateway chat event failed: {e}"))?,
            },
        )),
    })
}

fn build_gateway_chat_control_event_envelope(
    request_id: String,
    conversation_id: String,
    event_type: &str,
    error_code: String,
    message: String,
) -> proto::AgentEnvelope {
    let state = match event_type.trim() {
        "accepted" => "queued",
        "delivered" => "delivered",
        "claimed" => "claimed",
        "starting" => "starting",
        "started" => "running",
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "",
    }
    .to_string();
    proto::AgentEnvelope {
        request_id: request_id.clone(),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::ChatControl(
            proto::ChatControlEvent {
                request_id,
                conversation_id,
                r#type: event_type.trim().to_string(),
                state,
                error_code,
                message,
                ..Default::default()
            },
        )),
    }
}

fn build_gateway_runtime_status_envelope(
    worker_id: String,
    state: String,
    visible: bool,
    active_run_count: u32,
    active_runs: Vec<proto::ChatRunReport>,
    finished_runs: Vec<proto::ChatRunReport>,
) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id: format!("runtime-status-{}", worker_id.trim()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::RuntimeStatus(
            proto::RuntimeStatusEvent {
                worker_id,
                state,
                visible,
                active_run_count,
                timestamp: now_unix_seconds(),
                active_runs,
                finished_runs,
            },
        )),
    }
}

fn chat_run_report_from_entry(entry: &ChatRunLedgerEntry) -> proto::ChatRunReport {
    proto::ChatRunReport {
        run_id: entry.run_id.clone(),
        conversation_id: entry.conversation_id.clone(),
        state: entry.state.as_str().to_string(),
        error_code: entry.error_code.clone(),
        message: entry.message.clone(),
        updated_at: entry.updated_at_ms,
    }
}

fn build_history_sync_envelope(
    event: GatewayHistorySyncEvent,
) -> Result<proto::AgentEnvelope, String> {
    let conversation = event
        .conversation
        .map(|conversation| proto::ConversationSummary {
            id: conversation.id,
            title: conversation.title,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
            message_count: i32::try_from(conversation.message_count).unwrap_or(i32::MAX),
            provider_id: conversation.provider_id.unwrap_or_default(),
            model: conversation.model.unwrap_or_default(),
            session_id: conversation.session_id.unwrap_or_default(),
            cwd: conversation.cwd.unwrap_or_default(),
            is_pinned: conversation.is_pinned,
            pinned_at: conversation.pinned_at.unwrap_or_default(),
            is_shared: conversation.is_shared,
        });

    Ok(proto::AgentEnvelope {
        request_id: format!("history-sync-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::HistorySync(
            proto::HistorySyncEvent {
                kind: event.kind,
                conversation,
                conversation_id: event.conversation_id,
            },
        )),
    })
}

fn build_chat_runtime_snapshot_envelope(
    snapshot: GatewayChatRuntimeSnapshot,
) -> Result<proto::AgentEnvelope, String> {
    let conversation_id = snapshot.conversation_id.trim().to_string();
    if conversation_id.is_empty() {
        return Err("chat runtime snapshot conversation_id is required".to_string());
    }

    let run_id = snapshot.run_id.trim().to_string();
    if run_id.is_empty() {
        return Err("chat runtime snapshot run_id is required".to_string());
    }

    let state = snapshot.state.trim().to_string();
    if state.is_empty() {
        return Err("chat runtime snapshot state is required".to_string());
    }

    let updated_at = if snapshot.updated_at > 0 {
        snapshot.updated_at
    } else {
        chrono::Utc::now().timestamp_millis()
    };

    Ok(proto::AgentEnvelope {
        request_id: format!("chat-runtime-snapshot-{}-{}", run_id, snapshot.revision),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::ChatRuntimeSnapshot(
            proto::ChatRuntimeSnapshot {
                conversation_id,
                run_id,
                client_request_id: snapshot.client_request_id.unwrap_or_default(),
                worker_id: snapshot.worker_id.unwrap_or_default(),
                state,
                cwd: snapshot.cwd.unwrap_or_default(),
                updated_at,
                revision: snapshot.revision,
                entries_json: snapshot.entries_json,
                tool_status: snapshot.tool_status.unwrap_or_default(),
                tool_status_is_compaction: snapshot.tool_status_is_compaction,
            },
        )),
    })
}

fn build_grpc_url(config: &RemoteSettingsPayload) -> Result<String, String> {
    let grpc_endpoint = config.grpc_endpoint.trim();
    if !grpc_endpoint.is_empty() {
        let with_scheme =
            if grpc_endpoint.starts_with("http://") || grpc_endpoint.starts_with("https://") {
                grpc_endpoint.to_string()
            } else {
                format!("http://{grpc_endpoint}")
            };
        let mut url =
            Url::parse(&with_scheme).map_err(|e| format!("invalid gateway gRPC endpoint: {e}"))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("gateway gRPC endpoint must start with http:// or https://".to_string());
        }
        url.set_path("");
        url.set_query(None);
        url.set_fragment(None);
        return Ok(url.to_string().trim_end_matches('/').to_string());
    }

    let trimmed = config.gateway_url.trim();
    if trimmed.is_empty() {
        return Err("gateway URL is empty".to_string());
    }

    let mut url = Url::parse(trimmed).map_err(|e| format!("invalid gateway URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("gateway URL must start with http:// or https://".to_string());
    }
    url.set_port(Some(config.grpc_port))
        .map_err(|_| "failed to apply gRPC port to gateway URL".to_string())?;
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn queue_terminal_stream_handshake_frame(
    sender: &mpsc::Sender<proto::TerminalStreamFrame>,
) -> Result<(), String> {
    // Some HTTP/2 proxies do not fully establish a bidi stream until the client
    // sends its first DATA frame. `detach` is a gateway no-op and is not forwarded
    // to browser terminal subscribers.
    sender
        .try_send(terminal_stream_noop_frame("desktop-handshake"))
        .map_err(|error| format!("queue gateway terminal stream handshake failed: {error}"))
}

async fn queue_terminal_stream_keepalive_frame(
    sender: &mpsc::Sender<proto::TerminalStreamFrame>,
) -> Result<(), String> {
    sender
        .send(terminal_stream_noop_frame("desktop-keepalive"))
        .await
        .map_err(|error| format!("queue gateway terminal stream keepalive failed: {error}"))
}

fn terminal_stream_noop_frame(prefix: &str) -> proto::TerminalStreamFrame {
    proto::TerminalStreamFrame {
        kind: "detach".to_string(),
        stream_id: format!("{}-{}", prefix.trim(), Uuid::new_v4()),
        ..Default::default()
    }
}

fn format_gateway_terminal_stream_rpc_error(
    phase: &str,
    error: &tonic::Status,
    config: &RemoteSettingsPayload,
) -> String {
    let message = error.to_string();
    if !is_h2_protocol_error(&message) {
        return format!("gateway terminal stream {phase} failed: {message}");
    }

    let endpoint = build_grpc_url(config).unwrap_or_else(|_| "invalid endpoint".to_string());
    format!(
        "gateway terminal stream {phase} failed: {message}. \
         The gateway terminal stream requires a gRPC endpoint that supports HTTP/2 bidi streams; \
         check Remote gRPC Endpoint / gRPC port. Current endpoint: {endpoint}"
    )
}

fn is_h2_protocol_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("h2 protocol error") || normalized.contains("http2 error")
}

fn build_endpoint(grpc_url: &str) -> Result<Endpoint, String> {
    let endpoint = Endpoint::from_shared(grpc_url.to_string())
        .map_err(|e| format!("invalid gateway endpoint: {e}"))?
        .connect_timeout(Duration::from_secs(10))
        .tcp_keepalive(Some(Duration::from_secs(30)));

    if grpc_url.starts_with("https://") {
        ensure_rustls_crypto_provider();
        let host = Url::parse(grpc_url)
            .ok()
            .and_then(|url| url.host_str().map(ToString::to_string))
            .ok_or_else(|| "failed to extract TLS host from gateway URL".to_string())?;
        endpoint
            .tls_config(
                ClientTlsConfig::new()
                    .with_enabled_roots()
                    .domain_name(host),
            )
            .map_err(|e| format!("configure gateway TLS failed: {e}"))
    } else {
        Ok(endpoint)
    }
}

fn ensure_rustls_crypto_provider() {
    static INSTALL_DEFAULT_PROVIDER: Once = Once::new();
    INSTALL_DEFAULT_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn insert_bearer_metadata(
    metadata: &mut tonic::metadata::MetadataMap,
    token: &str,
) -> Result<(), String> {
    let value = MetadataValue::try_from(format!("Bearer {}", token.trim()))
        .map_err(|e| format!("invalid gateway authorization metadata: {e}"))?;
    metadata.insert("authorization", value);
    Ok(())
}

fn is_remote_configured(config: &RemoteSettingsPayload) -> bool {
    !config.gateway_url.trim().is_empty() && !config.token.trim().is_empty()
}

fn effective_agent_id(config: &RemoteSettingsPayload) -> String {
    if !config.agent_id.trim().is_empty() {
        return config.agent_id.trim().to_string();
    }
    fallback_agent_id()
}

fn fallback_agent_id() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "liveagent-desktop".to_string())
}

fn set_disconnected_status(
    status: &mut GatewayStatusSnapshot,
    config: &RemoteSettingsPayload,
    last_error: Option<String>,
) {
    status.online = false;
    status.enabled = config.enabled;
    status.configured = is_remote_configured(config);
    status.gateway_url = config.gateway_url.clone();
    status.agent_id = effective_agent_id(config);
    status.session_id = None;
    status.connected_since = None;
    status.last_heartbeat = None;
    status.last_error = last_error;
}

pub(crate) fn now_unix_seconds() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
}

pub(crate) fn now_unix_millis() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn chat_run_ledger_now() -> (Instant, i64) {
    (Instant::now(), now_unix_millis())
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("gateway chat event {key} is required"))
}

fn required_string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    string_field(object, key)
}

fn required_raw_string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("gateway chat event {key} is required"))
}

fn optional_string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn optional_number_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    object.get(key).and_then(Value::as_i64)
}
