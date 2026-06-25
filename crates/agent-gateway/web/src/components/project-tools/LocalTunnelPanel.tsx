import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/i18n";
import { workspaceProjectPathKey } from "@/lib/settings";
import { cn } from "@/lib/shared/utils";
import type {
  TunnelCreateInput,
  TunnelSummary as GatewayTunnelSummary,
  TunnelUpdateInput,
} from "@/lib/gatewaySocket";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Edit3,
  ExternalLink,
  Folder,
  Globe,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export type { TunnelCreateInput };
export type TunnelSummary = Omit<GatewayTunnelSummary, "activeConnections">;
type TunnelDiagnostic = NonNullable<TunnelSummary["diagnostics"]>[number];

export type TunnelTtlSeconds = 0 | 900 | 3600 | 14400;

export type LocalTunnelClient = {
  listTunnels(): Promise<TunnelSummary[]>;
  createTunnel(input: TunnelCreateInput): Promise<TunnelSummary>;
  updateTunnel(input: TunnelUpdateInput): Promise<TunnelSummary>;
  probeTunnel(id: string): Promise<TunnelSummary>;
  closeTunnel(id: string): Promise<TunnelSummary>;
};

type LocalTunnelPanelProps = {
  client: LocalTunnelClient;
  enabled?: boolean;
  disabledMessage?: string;
  projectPathKey?: string;
  refreshToken?: number;
};

type TunnelScope = "project" | "global";

const TUNNEL_MANAGER_CHANGED_EVENT = "liveagent:tunnel-manager-changed";

const TUNNEL_SCOPE_OPTIONS: Array<{
  scope: TunnelScope;
  labelKey: string;
  titleKey: string;
}> = [
  {
    scope: "project",
    labelKey: "projectTools.tunnelScopeProject",
    titleKey: "projectTools.tunnelScopeProjectTitle",
  },
  {
    scope: "global",
    labelKey: "projectTools.tunnelScopeGlobal",
    titleKey: "projectTools.tunnelScopeGlobalTitle",
  },
];

const TTL_OPTIONS: Array<{ value: TunnelTtlSeconds; labelKey: string }> = [
  { value: 900, labelKey: "projectTools.tunnelTtl15m" },
  { value: 3600, labelKey: "projectTools.tunnelTtl1h" },
  { value: 14400, labelKey: "projectTools.tunnelTtl4h" },
  { value: 0, labelKey: "projectTools.tunnelTtlInfinite" },
];

const TUNNEL_DIAGNOSTIC_PROTOCOLS: TunnelDiagnostic["protocol"][] = [
  "http",
  "websocket",
  "sse",
];

const TUNNEL_INPUT_CLASS =
  "h-8 min-w-0 rounded-lg border-border/60 bg-background/80 text-[11px] placeholder:text-[11px] transition-[border-color,box-shadow,background-color] focus-visible:border-muted-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground/15 focus-visible:ring-offset-0";

function TtlSegmented({
  value,
  onChange,
  disabled,
}: {
  value: TunnelTtlSeconds;
  onChange: (value: TunnelTtlSeconds) => void;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div className="grid min-w-0 grid-cols-4 gap-0.5 rounded-lg bg-muted/70 p-0.5">
      {TTL_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={cn(
              "h-7 min-w-0 truncate rounded-[7px] px-1 text-xs text-muted-foreground transition-all duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              active && "bg-background font-medium text-foreground shadow-sm",
            )}
          >
            {t(option.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

function normalizeTunnelHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isIpv4Address(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255 && String(value) === part;
  });
}

function isIpAddress(hostname: string) {
  if (isIpv4Address(hostname)) return true;
  return hostname.includes(":");
}

function validateLocalHttpTarget(input: string) {
  const value = input.trim();
  if (!value) return "projectTools.tunnelTargetRequired";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      return "projectTools.tunnelInvalidUrl";
    }
    const hostname = normalizeTunnelHostname(url.hostname);
    if (hostname !== "localhost" && !isIpAddress(hostname)) {
      return "projectTools.tunnelLocalhostOnly";
    }
    if (url.username || url.password || url.hash) {
      return "projectTools.tunnelInvalidUrl";
    }
  } catch {
    return "projectTools.tunnelInvalidUrl";
  }
  return null;
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatRemaining(seconds: number) {
  if (seconds <= 0) return "0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  if (minutes >= 60) return `${hours + 1}h`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDateTime(seconds: number) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString();
}

function writeTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackWriteTextToClipboard(text),
    );
  }
  return Promise.resolve(fallbackWriteTextToClipboard(text));
}

function fallbackWriteTextToClipboard(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function displayTunnelName(tunnel: TunnelSummary) {
  return tunnel.name.trim() || tunnel.targetUrl;
}

function tunnelStatusKey(status: TunnelSummary["status"]) {
  if (status === "expired") return "projectTools.tunnelStatusExpired";
  if (status === "offline") return "projectTools.tunnelStatusOffline";
  return "projectTools.tunnelStatusActive";
}

function normalizeProjectPathKey(value: string | undefined) {
  return workspaceProjectPathKey(value ?? "");
}

function ttlFromTunnel(tunnel: TunnelSummary, nowSeconds: number): TunnelTtlSeconds {
  if (!tunnel.expiresAt) return 0;
  const remaining = Math.max(0, tunnel.expiresAt - nowSeconds);
  if (remaining <= 900) return 900;
  if (remaining <= 3600) return 3600;
  return 14400;
}

function diagnosticFor(tunnel: TunnelSummary, protocol: TunnelDiagnostic["protocol"]) {
  return tunnel.diagnostics?.find((item) => item.protocol === protocol);
}

function diagnosticLabel(protocol: TunnelDiagnostic["protocol"]) {
  if (protocol === "websocket") return "WS";
  return protocol.toUpperCase();
}

export function LocalTunnelPanel({
  client,
  enabled = true,
  disabledMessage,
  projectPathKey,
  refreshToken,
}: LocalTunnelPanelProps) {
  const { t } = useLocale();
  const normalizedProjectPathKey = useMemo(
    () => normalizeProjectPathKey(projectPathKey),
    [projectPathKey],
  );
  const [scope, setScope] = useState<TunnelScope>(() =>
    normalizeProjectPathKey(projectPathKey) ? "project" : "global",
  );
  const [targetUrl, setTargetUrl] = useState("http://localhost:3000");
  const [name, setName] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState<TunnelTtlSeconds>(3600);
  const [createOpen, setCreateOpen] = useState(true);
  const [editingId, setEditingId] = useState("");
  const [editTargetUrl, setEditTargetUrl] = useState("");
  const [editName, setEditName] = useState("");
  const [editTtlSeconds, setEditTtlSeconds] = useState<TunnelTtlSeconds>(3600);
  const [tunnels, setTunnels] = useState<TunnelSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [closingId, setClosingId] = useState("");
  const [probingId, setProbingId] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const refreshTokenRef = useRef(refreshToken);
  const targetValidationKey = useMemo(() => validateLocalHttpTarget(targetUrl), [targetUrl]);
  const editTargetValidationKey = useMemo(
    () => (editingId ? validateLocalHttpTarget(editTargetUrl) : null),
    [editTargetUrl, editingId],
  );

  const refresh = useCallback(
    (options?: { showLoading?: boolean }) => {
      const showLoading = options?.showLoading ?? true;
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      return client
        .listTunnels()
        .then((items) => setTunnels(items))
        .catch((err) => setError(asErrorMessage(err)))
        .finally(() => {
          if (showLoading) {
            setLoading(false);
          }
        });
    },
    [client],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (refreshTokenRef.current === refreshToken) return;
    refreshTokenRef.current = refreshToken;
    void refresh({ showLoading: false });
  }, [refresh, refreshToken]);

  useEffect(() => {
    const handleTunnelManagerChanged = () => {
      void refresh({ showLoading: false });
    };
    window.addEventListener(TUNNEL_MANAGER_CHANGED_EVENT, handleTunnelManagerChanged);
    return () =>
      window.removeEventListener(TUNNEL_MANAGER_CHANGED_EVENT, handleTunnelManagerChanged);
  }, [refresh]);

  useEffect(() => {
    if (!normalizedProjectPathKey && scope === "project") {
      setScope("global");
      setError(null);
    }
  }, [normalizedProjectPathKey, scope]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(""), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const createTunnel = useCallback(() => {
    const validationKey = validateLocalHttpTarget(targetUrl);
    if (validationKey) {
      setError(t(validationKey));
      return;
    }
    if (!enabled || creating) return;
    const input: TunnelCreateInput = {
      targetUrl: targetUrl.trim(),
      name: name.trim() || undefined,
      ttlSeconds,
    };
    if (scope === "project" && normalizedProjectPathKey) {
      input.projectPathKey = normalizedProjectPathKey;
    }
    setCreating(true);
    setError(null);
    void client
      .createTunnel(input)
      .then((created) => {
        setTunnels((current) => [
          created,
          ...current.filter((item) => item.id !== created.id && item.slug !== created.slug),
        ]);
        setName("");
        void refresh({ showLoading: false });
      })
      .catch((err) => setError(asErrorMessage(err)))
      .finally(() => setCreating(false));
  }, [
    client,
    creating,
    enabled,
    name,
    normalizedProjectPathKey,
    refresh,
    scope,
    t,
    targetUrl,
    ttlSeconds,
  ]);

  const beginEdit = useCallback(
    (tunnel: TunnelSummary) => {
      setEditingId(tunnel.id);
      setEditTargetUrl(tunnel.targetUrl);
      setEditName(tunnel.name);
      setEditTtlSeconds(ttlFromTunnel(tunnel, nowSeconds));
      setError(null);
    },
    [nowSeconds],
  );

  const cancelEdit = useCallback(() => {
    setEditingId("");
    setEditTargetUrl("");
    setEditName("");
    setEditTtlSeconds(3600);
    setError(null);
  }, []);

  const updateTunnel = useCallback(
    (tunnel: TunnelSummary) => {
      const validationKey = validateLocalHttpTarget(editTargetUrl);
      if (validationKey) {
        setError(t(validationKey));
        return;
      }
      if (!enabled || savingId) return;
      const input: TunnelUpdateInput = {
        id: tunnel.id,
        targetUrl: editTargetUrl.trim(),
        name: editName.trim() || undefined,
        ttlSeconds: editTtlSeconds,
      };
      const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
      if (tunnelProjectPathKey) {
        input.projectPathKey = tunnelProjectPathKey;
      }
      setSavingId(tunnel.id);
      setError(null);
      void client
        .updateTunnel(input)
        .then((updated) => {
          setTunnels((current) => current.map((item) => (item.id === updated.id ? updated : item)));
          cancelEdit();
        })
        .catch((err) => setError(asErrorMessage(err)))
        .finally(() => setSavingId((current) => (current === tunnel.id ? "" : current)));
    },
    [cancelEdit, client, editName, editTargetUrl, editTtlSeconds, enabled, savingId, t],
  );

  const closeTunnel = useCallback(
    (id: string) => {
      if (!enabled || closingId) return;
      setClosingId(id);
      setError(null);
      void client
        .closeTunnel(id)
        .then((closed) => {
          setTunnels((current) =>
            current
              .filter((item) => item.id !== id)
              .concat(closed.status === "active" ? [closed] : []),
          );
        })
        .catch((err) => setError(asErrorMessage(err)))
        .finally(() => setClosingId((current) => (current === id ? "" : current)));
    },
    [client, closingId, enabled],
  );

  const probeTunnel = useCallback(
    (id: string) => {
      if (!enabled || probingId) return;
      setProbingId(id);
      setError(null);
      void client
        .probeTunnel(id)
        .then((updated) =>
          setTunnels((current) => current.map((item) => (item.id === updated.id ? updated : item))),
        )
        .catch((err) => setError(asErrorMessage(err)))
        .finally(() => setProbingId((current) => (current === id ? "" : current)));
    },
    [client, enabled, probingId],
  );

  const copyLink = useCallback((tunnel: TunnelSummary) => {
    if (!tunnel.publicUrl) return;
    void writeTextToClipboard(tunnel.publicUrl)
      .then((copied) => {
        if (copied) {
          setCopiedId(tunnel.id);
        }
      })
      .catch(() => {});
  }, []);

  const openLink = useCallback((tunnel: TunnelSummary) => {
    if (!tunnel.publicUrl) return;
    window.open(tunnel.publicUrl, "_blank", "noopener,noreferrer");
  }, []);

  const scopedTunnels = useMemo(
    () =>
      tunnels.filter((tunnel) => {
        const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
        if (scope === "project") {
          return (
            Boolean(normalizedProjectPathKey) && tunnelProjectPathKey === normalizedProjectPathKey
          );
        }
        return true;
      }),
    [normalizedProjectPathKey, scope, tunnels],
  );
  const sortedTunnels = useMemo(
    () => [...scopedTunnels].sort((a, b) => b.createdAt - a.createdAt),
    [scopedTunnels],
  );
  const canCreate =
    enabled &&
    !creating &&
    !targetValidationKey &&
    (scope !== "project" || Boolean(normalizedProjectPathKey));
  const showCreateForm = scope === "project" && Boolean(normalizedProjectPathKey);
  const createFieldsDisabled = !showCreateForm || !createOpen || !enabled || creating;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gradient-to-b from-muted/40 via-muted/15 to-background">
      <div className="shrink-0 border-b border-border/60 bg-background/70 px-4 pb-3 pt-3.5 backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/80 text-foreground/70 shadow-[inset_0_1px_0_hsl(0_0%_100%_/_0.6),0_1px_2px_hsl(0_0%_0%_/_0.05)] dark:shadow-none">
            <Globe className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold tracking-tight text-foreground">
              {t("projectTools.tunnelTitle")}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {t("projectTools.tunnelDescription")}
            </div>
          </div>
        </div>
        <div
          role="group"
          aria-label={t("projectTools.tunnelScopeGroup")}
          className="relative mt-3 grid grid-cols-2 gap-0.5 rounded-lg bg-muted/70 p-0.5"
        >
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 z-0 w-1/2 transform-gpu rounded-[7px] bg-background shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none",
              scope === "global" ? "translate-x-full" : "translate-x-0",
            )}
          />
          {TUNNEL_SCOPE_OPTIONS.map((option) => {
            const active = scope === option.scope;
            const disabled = option.scope === "project" && !normalizedProjectPathKey;
            const Icon = option.scope === "project" ? Folder : Globe;
            return (
              <button
                key={option.scope}
                type="button"
                aria-pressed={active}
                title={t(option.titleKey)}
                disabled={disabled}
                onClick={() => {
                  setScope(option.scope);
                  setError(null);
                }}
                className={cn(
                  "relative z-10 flex h-7 min-w-0 transform-gpu items-center justify-center gap-1.5 rounded-[7px] px-2 text-xs text-muted-foreground transition-[color,transform] duration-200 ease-out hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100",
                  active && "font-medium text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{t(option.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {disabledMessage ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{disabledMessage}</span>
          </div>
        ) : null}

        {normalizedProjectPathKey ? (
          <div
            className={cn(
              "grid transform-gpu transition-[grid-template-rows,opacity,transform,margin] duration-200 ease-out motion-reduce:transition-none",
              showCreateForm
                ? "mb-3 grid-rows-[1fr] translate-y-0 opacity-100"
                : "mb-0 grid-rows-[0fr] -translate-y-1 opacity-0",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <section
                aria-hidden={!showCreateForm}
                className={cn(
                  "overflow-hidden rounded-xl border border-border/60 bg-background/70 shadow-[0_1px_2px_hsl(0_0%_0%_/_0.04)] backdrop-blur-xl transition-[border-color,background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
                  !showCreateForm && "pointer-events-none",
                )}
              >
                <button
                  type="button"
                  onClick={() => setCreateOpen((open) => !open)}
                  aria-controls="local-tunnel-create-form"
                  aria-expanded={showCreateForm && createOpen}
                  disabled={!showCreateForm}
                  className="flex h-10 w-full items-center gap-2 px-3 text-left transition-colors duration-150 ease-out hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none motion-reduce:transition-none"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted/80 text-muted-foreground">
                    <Plus className="h-3 w-3" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                    {t("projectTools.tunnelCreateSection")}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
                      showCreateForm && createOpen && "rotate-180",
                    )}
                  />
                </button>
                <div
                  className={cn(
                    "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                    showCreateForm && createOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    <form
                      id="local-tunnel-create-form"
                      className={cn(
                        "grid min-w-0 gap-3 border-t border-border/50 px-3 pb-3 pt-3 transition-transform duration-200 ease-out motion-reduce:transition-none",
                        showCreateForm && createOpen ? "translate-y-0" : "-translate-y-1",
                      )}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!showCreateForm || !createOpen) return;
                        createTunnel();
                      }}
                    >
                      <div className="grid gap-1.5">
                        <Label htmlFor="local-tunnel-target" className="text-xs text-muted-foreground">
                          {t("projectTools.tunnelTargetUrl")}
                        </Label>
                        <Input
                          id="local-tunnel-target"
                          value={targetUrl}
                          onChange={(event) => setTargetUrl(event.target.value)}
                          placeholder={t("projectTools.tunnelTargetPlaceholder")}
                          disabled={createFieldsDisabled}
                          inputMode="url"
                          autoComplete="off"
                          spellCheck={false}
                          className={cn(TUNNEL_INPUT_CLASS, "font-mono")}
                        />
                        {targetValidationKey ? (
                          <div className="flex items-start gap-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span className="min-w-0">{t(targetValidationKey)}</span>
                          </div>
                        ) : null}
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="local-tunnel-name" className="text-xs text-muted-foreground">
                          {t("projectTools.tunnelName")}
                        </Label>
                        <Input
                          id="local-tunnel-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          placeholder={t("projectTools.tunnelNamePlaceholder")}
                          disabled={createFieldsDisabled}
                          autoComplete="off"
                          className={TUNNEL_INPUT_CLASS}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-muted-foreground">
                          {t("projectTools.tunnelTtl")}
                        </Label>
                        <TtlSegmented
                          value={ttlSeconds}
                          onChange={setTtlSeconds}
                          disabled={createFieldsDisabled}
                        />
                      </div>
                      <Button
                        type="submit"
                        size="sm"
                        className="h-8 gap-1.5 rounded-lg text-xs"
                        disabled={!showCreateForm || !createOpen || !canCreate}
                        title={!enabled ? disabledMessage : undefined}
                      >
                        {creating ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        {creating ? t("projectTools.tunnelCreating") : t("projectTools.tunnelCreate")}
                      </Button>
                    </form>
                  </div>
                </div>
              </section>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="mb-3 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
            {error}
          </div>
        ) : null}

        <div>
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("projectTools.tunnelListSection")}
            </span>
            {sortedTunnels.length > 0 ? (
              <span className="rounded-full bg-muted/80 px-1.5 py-px text-[11px] tabular-nums text-muted-foreground">
                {sortedTunnels.length}
              </span>
            ) : null}
          </div>
          {loading && sortedTunnels.length === 0 ? (
            <div className="grid gap-2">
              <span className="sr-only">{t("projectTools.tunnelLoading")}</span>
              <div className="hub-frost-skeleton h-24" aria-hidden />
              <div className="hub-frost-skeleton h-24 opacity-70" aria-hidden />
            </div>
          ) : sortedTunnels.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-background/40 px-4 py-10 text-center">
              <div className="mb-1.5 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/50 bg-background/80 text-muted-foreground/70 shadow-[inset_0_1px_0_hsl(0_0%_100%_/_0.6),0_1px_3px_hsl(0_0%_0%_/_0.05)] dark:shadow-none">
                <Globe className="h-5 w-5" />
              </div>
              <div className="text-xs font-medium text-foreground/80">
                {t("projectTools.tunnelEmpty")}
              </div>
              {showCreateForm ? (
                <div className="text-[11px] text-muted-foreground">
                  {t("projectTools.tunnelEmptyHintCreate")}
                </div>
              ) : normalizedProjectPathKey ? (
                <div className="text-[11px] text-muted-foreground">
                  {t("projectTools.tunnelEmptyHintProject")}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-2">
              {sortedTunnels.map((tunnel) => {
                const hasExpiry = tunnel.expiresAt > 0;
                const remaining = hasExpiry ? tunnel.expiresAt - nowSeconds : 0;
                const expired = tunnel.status === "expired" || (hasExpiry && remaining <= 0);
                const isEditing = editingId === tunnel.id;
                const updating = savingId === tunnel.id;
                const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
                const handleEditKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    updateTunnel(tunnel);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEdit();
                  }
                };
                return (
                  <div
                    key={tunnel.id}
                    className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background/70 shadow-[0_1px_2px_hsl(0_0%_0%_/_0.04)] backdrop-blur-xl transition-shadow duration-200 hover:shadow-[0_3px_10px_hsl(0_0%_0%_/_0.07)]"
                  >
                    <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
                      <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {displayTunnelName(tunnel)}
                      </div>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          tunnel.status === "offline"
                            ? "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : expired
                              ? "border-border/60 bg-muted/70 text-muted-foreground"
                              : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                        )}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            tunnel.status === "offline"
                              ? "bg-amber-500"
                              : expired
                                ? "bg-muted-foreground/50"
                                : "animate-pulse bg-emerald-500 motion-reduce:animate-none",
                          )}
                        />
                        {t(tunnelStatusKey(expired ? "expired" : tunnel.status))}
                      </span>
                    </div>

                    {isEditing ? (
                      <>
                        <div className="grid min-w-0 gap-2.5 px-3 pb-1 pt-2">
                          <div className="grid gap-1.5">
                            <Label
                              htmlFor={`tunnel-edit-target-${tunnel.id}`}
                              className="text-xs text-muted-foreground"
                            >
                              {t("projectTools.tunnelTargetUrl")}
                            </Label>
                            <Input
                              id={`tunnel-edit-target-${tunnel.id}`}
                              value={editTargetUrl}
                              onChange={(event) => setEditTargetUrl(event.target.value)}
                              onKeyDown={handleEditKeyDown}
                              disabled={!enabled || updating}
                              inputMode="url"
                              autoComplete="off"
                              spellCheck={false}
                              className={cn(TUNNEL_INPUT_CLASS, "font-mono")}
                            />
                            {editTargetValidationKey ? (
                              <div className="flex items-start gap-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                                <span className="min-w-0">{t(editTargetValidationKey)}</span>
                              </div>
                            ) : null}
                          </div>
                          <div className="grid gap-1.5">
                            <Label
                              htmlFor={`tunnel-edit-name-${tunnel.id}`}
                              className="text-xs text-muted-foreground"
                            >
                              {t("projectTools.tunnelName")}
                            </Label>
                            <Input
                              id={`tunnel-edit-name-${tunnel.id}`}
                              value={editName}
                              onChange={(event) => setEditName(event.target.value)}
                              onKeyDown={handleEditKeyDown}
                              placeholder={t("projectTools.tunnelNamePlaceholder")}
                              disabled={!enabled || updating}
                              autoComplete="off"
                              className={TUNNEL_INPUT_CLASS}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label className="text-xs text-muted-foreground">
                              {t("projectTools.tunnelTtl")}
                            </Label>
                            <TtlSegmented
                              value={editTtlSeconds}
                              onChange={setEditTtlSeconds}
                              disabled={!enabled || updating}
                            />
                          </div>
                        </div>
                        <div className="mt-1.5 flex items-center justify-end gap-1.5 border-t border-border/40 px-3 py-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 rounded-lg px-2.5 text-xs text-muted-foreground hover:text-foreground"
                            disabled={updating}
                            onClick={cancelEdit}
                            title={t("projectTools.tunnelCancelEdit")}
                          >
                            <X className="h-3.5 w-3.5" />
                            {t("settings.cancel")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 gap-1 rounded-lg px-2.5 text-xs"
                            disabled={!enabled || updating || Boolean(editTargetValidationKey)}
                            onClick={() => updateTunnel(tunnel)}
                            title={
                              updating
                                ? t("projectTools.tunnelUpdating")
                                : t("projectTools.tunnelSave")
                            }
                          >
                            {updating ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            {t("settings.save")}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => copyLink(tunnel)}
                          disabled={!tunnel.publicUrl}
                          title={
                            copiedId === tunnel.id
                              ? t("projectTools.tunnelCopied")
                              : t("projectTools.tunnelCopyLink")
                          }
                          aria-label={
                            copiedId === tunnel.id
                              ? t("projectTools.tunnelCopied")
                              : t("projectTools.tunnelCopyLink")
                          }
                          className="mx-3 mt-2 flex w-[calc(100%-1.5rem)] min-w-0 items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2 py-1.5 text-left transition-colors duration-150 hover:border-border hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                        >
                          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85">
                            {tunnel.publicUrl}
                          </span>
                          {copiedId === tunnel.id ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                          )}
                        </button>
                        <div
                          className="mt-1.5 flex min-w-0 items-center gap-1 px-3 text-[11px] text-muted-foreground"
                          title={tunnel.targetUrl}
                        >
                          <Link2 className="h-3 w-3 shrink-0" />
                          <span className="shrink-0">{t("projectTools.tunnelTarget")}</span>
                          <span className="min-w-0 truncate font-mono">{tunnel.targetUrl}</span>
                        </div>
                        <div className="mx-3 mt-2 grid grid-cols-3 gap-1">
                          {TUNNEL_DIAGNOSTIC_PROTOCOLS.map((protocol) => {
                            const diagnostic = diagnosticFor(tunnel, protocol);
                            const status = diagnostic?.status ?? "unknown";
                            const title = diagnostic
                              ? [
                                  diagnosticLabel(protocol),
                                  t(
                                    status === "ok"
                                      ? "projectTools.tunnelDiagnosticOk"
                                      : status === "failed"
                                        ? "projectTools.tunnelDiagnosticFailed"
                                        : "projectTools.tunnelDiagnosticUnknown",
                                  ),
                                  diagnostic.statusCode ? String(diagnostic.statusCode) : "",
                                  diagnostic.errorCode,
                                  diagnostic.message,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : t("projectTools.tunnelDiagnosticUnknown");
                            return (
                              <div
                                key={protocol}
                                title={title}
                                className={cn(
                                  "flex h-6 min-w-0 items-center justify-center gap-1 rounded-md border px-1 text-[10px] font-medium",
                                  status === "ok"
                                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                    : status === "failed"
                                      ? "border-destructive/20 bg-destructive/10 text-destructive"
                                      : "border-border/60 bg-muted/50 text-muted-foreground",
                                )}
                              >
                                <span
                                  className={cn(
                                    "h-1.5 w-1.5 rounded-full",
                                    status === "ok"
                                      ? "bg-emerald-500"
                                      : status === "failed"
                                        ? "bg-destructive"
                                        : "bg-muted-foreground/45",
                                  )}
                                />
                                <span className="truncate">{diagnosticLabel(protocol)}</span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/40 py-1 pl-3 pr-1.5">
                          <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                            <span
                              className="inline-flex min-w-0 items-center gap-1"
                              title={hasExpiry ? formatDateTime(tunnel.expiresAt) : undefined}
                            >
                              <Clock3 className="h-3 w-3 shrink-0" />
                              <span className="min-w-0 truncate tabular-nums">
                                {!hasExpiry
                                  ? t("projectTools.tunnelTtlInfinite")
                                  : expired
                                    ? t("projectTools.tunnelExpired")
                                    : t("projectTools.tunnelExpiresIn").replace(
                                        "{time}",
                                        formatRemaining(remaining),
                                      )}
                              </span>
                            </span>
                            {scope === "global" ? (
                              <span className="shrink-0 rounded-full bg-muted/80 px-1.5 py-px text-[10px]">
                                {t(
                                  tunnelProjectPathKey
                                    ? "projectTools.tunnelScopeProjectBadge"
                                    : "projectTools.tunnelScopeGlobalBadge",
                                )}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                              disabled={!enabled || expired || probingId === tunnel.id}
                              onClick={() => probeTunnel(tunnel.id)}
                              title={!enabled ? disabledMessage : t("projectTools.tunnelProbe")}
                              aria-label={t("projectTools.tunnelProbe")}
                            >
                              {probingId === tunnel.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                              disabled={!enabled || expired}
                              onClick={() => beginEdit(tunnel)}
                              title={!enabled ? disabledMessage : t("projectTools.tunnelEdit")}
                              aria-label={t("projectTools.tunnelEdit")}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                              disabled={!tunnel.publicUrl || expired}
                              onClick={() => openLink(tunnel)}
                              title={t("projectTools.tunnelOpenLink")}
                              aria-label={t("projectTools.tunnelOpenLink")}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              disabled={!enabled || closingId === tunnel.id}
                              onClick={() => closeTunnel(tunnel.id)}
                              title={!enabled ? disabledMessage : t("projectTools.tunnelClose")}
                              aria-label={t("projectTools.tunnelClose")}
                            >
                              {closingId === tunnel.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
