import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, GitBranch, Loader2, Plus, RefreshCw, X } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { cn } from "../../lib/shared/utils";
import type {
  GitBranch as GitBranchInfo,
  GitClient,
  GitRepositoryState,
} from "../../lib/git/types";
import { emptyGitRepositoryState } from "../../lib/git/types";
import { useLocale } from "../../i18n";

function assertGitOperationResult(value: unknown, fallbackMessage: string) {
  if (!value || typeof value !== "object") return;
  const result = value as { ok?: unknown; message?: unknown; stderr?: unknown };
  if (result.ok === false) {
    const message =
      typeof result.message === "string" && result.message.trim()
        ? result.message
        : typeof result.stderr === "string" && result.stderr.trim()
          ? result.stderr
          : fallbackMessage;
    throw new Error(message);
  }
}

const GIT_BRANCH_SELECTOR_POLL_INTERVAL_MS = 3000;

type GitBranchRefreshOptions = {
  force?: boolean;
  silent?: boolean;
};

function GitInitModal(props: {
  open: boolean;
  workdir: string;
  branch: string;
  userName: string;
  userEmail: string;
  loading: boolean;
  error: string;
  onBranchChange: (value: string) => void;
  onUserNameChange: (value: string) => void;
  onUserEmailChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const {
    open,
    workdir,
    branch,
    userName,
    userEmail,
    loading,
    error,
    onBranchChange,
    onUserNameChange,
    onUserEmailChange,
    onClose,
    onSubmit,
  } = props;
  const { t } = useLocale();
  const titleId = useId();
  const branchId = useId();
  const userNameId = useId();
  const userEmailId = useId();

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />
      <form
        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
              <GitBranch className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div
                id={titleId}
                className="text-sm font-semibold text-foreground"
              >
                {t("git.branchSelector.initRepositoryTitle")}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("git.branchSelector.initRepositoryDescription")}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={loading}
            className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
            title={t("window.close")}
            aria-label={t("window.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t("git.branchSelector.targetDirectory")}
            </Label>
            <div
              className="truncate rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-xs text-foreground"
              title={workdir}
            >
              {workdir}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={branchId} className="text-xs text-muted-foreground">
              {t("git.branchSelector.initialBranch")}
            </Label>
            <Input
              id={branchId}
              value={branch}
              onChange={(event) => onBranchChange(event.target.value)}
              className="h-9 text-sm"
              placeholder="main"
              autoFocus
              disabled={loading}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label
                htmlFor={userNameId}
                className="text-xs text-muted-foreground"
              >
                {t("git.branchSelector.userNameOptional")}
              </Label>
              <Input
                id={userNameId}
                value={userName}
                onChange={(event) => onUserNameChange(event.target.value)}
                className="h-9 text-sm"
                disabled={loading}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor={userEmailId}
                className="text-xs text-muted-foreground"
              >
                {t("git.branchSelector.userEmailOptional")}
              </Label>
              <Input
                id={userEmailId}
                value={userEmail}
                onChange={(event) => onUserEmailChange(event.target.value)}
                className="h-9 text-sm"
                disabled={loading}
              />
            </div>
          </div>
          {error ? (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={loading}
          >
            {t("chat.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={loading || !branch.trim()}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="h-3.5 w-3.5" />
            )}
            {t("git.branchSelector.initRepository")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function GitBranchSelector(props: {
  workdir: string;
  gitClient?: GitClient | null;
  disabled?: boolean;
  canWrite?: boolean;
  disabledMessage?: string;
  onStateChange?: (state: GitRepositoryState) => void;
  onChanged?: () => void;
}) {
  const {
    workdir,
    gitClient,
    disabled,
    canWrite = true,
    disabledMessage,
    onStateChange,
    onChanged,
  } = props;
  const { t } = useLocale();
  const [state, setState] = useState<GitRepositoryState>(() =>
    emptyGitRepositoryState(workdir),
  );
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [draftBranch, setDraftBranch] = useState("");
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [initBranch, setInitBranch] = useState("main");
  const [initUserName, setInitUserName] = useState("");
  const [initUserEmail, setInitUserEmail] = useState("");
  const [initError, setInitError] = useState("");
  const [initializing, setInitializing] = useState(false);
  const refreshInFlightRef = useRef(false);
  const refreshRequestIdRef = useRef(0);

  const refresh = useCallback(async (options: GitBranchRefreshOptions = {}) => {
    if (!gitClient || !workdir.trim()) {
      const next = emptyGitRepositoryState(workdir);
      setState(next);
      setBranches([]);
      onStateChange?.(next);
      return;
    }
    if (refreshInFlightRef.current && options.silent && !options.force) return;
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    refreshInFlightRef.current = true;
    if (!options.silent) {
      setLoading(true);
    }
    setError("");
    try {
      const response = await gitClient.branches(workdir);
      if (refreshRequestIdRef.current !== requestId) return;
      setState(response.state);
      setBranches(response.branches);
      onStateChange?.(response.state);
    } catch (err) {
      if (refreshRequestIdRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
      const next = emptyGitRepositoryState(workdir);
      setState(next);
      onStateChange?.(next);
    } finally {
      if (refreshRequestIdRef.current === requestId) {
        refreshInFlightRef.current = false;
        if (!options.silent) {
          setLoading(false);
        }
      }
    }
  }, [gitClient, onStateChange, workdir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!gitClient || !workdir.trim()) return;
    const handleGitChanged = () => void refresh({ force: true, silent: true });
    window.addEventListener("liveagent:git-changed", handleGitChanged);
    return () => window.removeEventListener("liveagent:git-changed", handleGitChanged);
  }, [gitClient, refresh, workdir]);

  useEffect(() => {
    if (!gitClient || !workdir.trim()) return;
    let stopped = false;
    const refreshVisibleSelector = () => {
      if (stopped || document.hidden) return;
      void refresh({ silent: true });
    };
    const interval = window.setInterval(
      refreshVisibleSelector,
      GIT_BRANCH_SELECTOR_POLL_INTERVAL_MS,
    );
    const handleFocus = () => refreshVisibleSelector();
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshVisibleSelector();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [gitClient, refresh, workdir]);

  const localBranches = useMemo(
    () => branches.filter((branch) => branch.kind === "local"),
    [branches],
  );
  const remoteBranches = useMemo(
    () => branches.filter((branch) => branch.kind === "remote"),
    [branches],
  );

  const runBranchMutation = useCallback(
    async (task: () => Promise<unknown>) => {
      if (!gitClient || !workdir.trim()) return;
      if (!canWrite) {
        setError(disabledMessage || t("git.branchSelector.writeDisabled"));
        return false;
      }
      setMutating(true);
      setError("");
      try {
        const result = await task();
        assertGitOperationResult(
          result,
          t("git.branchSelector.operationFailed"),
        );
        await refresh({ force: true });
        onChanged?.();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setMutating(false);
      }
    },
    [canWrite, disabledMessage, gitClient, onChanged, refresh, t, workdir],
  );

  const selectBranch = useCallback(
    (branch: GitBranchInfo) => {
      void runBranchMutation(() =>
        gitClient!.switchBranch(workdir, branch.fullName, branch.kind),
      );
    },
    [gitClient, runBranchMutation, workdir],
  );

  const createBranch = useCallback(() => {
    const name = draftBranch.trim();
    if (!name) return;
    void runBranchMutation(() => gitClient!.createBranch(workdir, name)).then(
      (ok) => {
        if (!ok) return;
        setDraftBranch("");
        setCreating(false);
      },
    );
  }, [draftBranch, gitClient, runBranchMutation, workdir]);

  const openInitModal = useCallback(() => {
    setInitBranch("main");
    setInitUserName("");
    setInitUserEmail("");
    setInitError("");
    setInitModalOpen(true);
  }, []);

  const closeInitModal = useCallback(() => {
    if (initializing) return;
    setInitModalOpen(false);
    setInitError("");
  }, [initializing]);

  const initRepository = useCallback(async () => {
    if (!gitClient || !workdir.trim() || initializing) return;
    if (!canWrite) {
      setInitError(disabledMessage || t("git.branchSelector.writeDisabled"));
      return;
    }
    const branch = initBranch.trim();
    if (!branch) {
      setInitError(t("git.branchSelector.initialBranchRequired"));
      return;
    }
    setInitializing(true);
    setInitError("");
    setError("");
    try {
      const result = await gitClient.init(workdir, {
        branch,
        userName: initUserName.trim() || undefined,
        userEmail: initUserEmail.trim() || undefined,
      });
      assertGitOperationResult(result, t("git.branchSelector.operationFailed"));
      setState(result.state);
      onStateChange?.(result.state);
      await refresh({ force: true });
      onChanged?.();
      setInitModalOpen(false);
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitializing(false);
    }
  }, [
    canWrite,
    disabledMessage,
    gitClient,
    initBranch,
    initUserEmail,
    initUserName,
    initializing,
    onChanged,
    onStateChange,
    refresh,
    t,
    workdir,
  ]);

  const noRepo = state.status !== "ready";
  const stateError = state.status === "error" ? state.error?.trim() || "" : "";
  const visibleError = error || stateError;
  const repositorySummary =
    state.repoRoot ||
    state.workdir ||
    workdir.trim() ||
    t("git.branchSelector.noRepository");
  const label = noRepo
    ? t("git.branchSelector.noRepoShort")
    : state.head || t("git.branchSelector.detached");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled || !gitClient || !workdir.trim()}
          className={cn(
            "composer-reasoning-trigger inline-flex h-8 max-w-[13rem] shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium outline-hidden transition-colors",
            noRepo
              ? "border-transparent bg-foreground/[0.04] text-muted-foreground"
              : "border-emerald-300/25 bg-emerald-50/65 text-foreground hover:bg-emerald-50 dark:border-emerald-300/15 dark:bg-emerald-400/[0.08]",
            "disabled:pointer-events-none disabled:opacity-45",
          )}
          title={visibleError || (!canWrite ? disabledMessage : "") || label}
        >
          {loading || mutating || initializing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitBranch className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
          )}
          <span className="min-w-0 truncate">{label}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72" side="top" align="start">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {repositorySummary}
            </div>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void refresh()}
              title={t("git.branchSelector.refresh")}
              aria-label={t("git.branchSelector.refresh")}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", loading && "animate-spin")}
              />
            </button>
          </div>
          {visibleError ? (
            <div className="px-2 py-1 text-xs text-destructive">
              {visibleError}
            </div>
          ) : null}
          {!canWrite && disabledMessage ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {disabledMessage}
            </div>
          ) : null}
          {noRepo && !visibleError ? (
            <>
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {t("git.branchSelector.noRepositoryFound")}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canWrite || initializing}
                onSelect={openInitModal}
                className="gap-2 text-xs"
                title={!canWrite ? disabledMessage : undefined}
              >
                {initializing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                <span>{t("git.branchSelector.initRepository")}</span>
              </DropdownMenuItem>
            </>
          ) : noRepo ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("git.branchSelector.localBranches")}
              </DropdownMenuLabel>
              {localBranches.map((branch) => (
                <DropdownMenuItem
                  key={branch.fullName}
                  disabled={branch.current || mutating || !canWrite}
                  onSelect={() => selectBranch(branch)}
                  className="gap-2 text-xs"
                >
                  {branch.current ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <GitBranch className="h-3.5 w-3.5" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuLabel className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("git.branchSelector.remoteBranches")}
              </DropdownMenuLabel>
              {remoteBranches.slice(0, 40).map((branch) => (
                <DropdownMenuItem
                  key={branch.fullName}
                  disabled={mutating || !canWrite}
                  onSelect={() => selectBranch(branch)}
                  className="gap-2 text-xs"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  <span className="min-w-0 flex-1 truncate">
                    {branch.fullName}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {creating ? (
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <Input
                    value={draftBranch}
                    onChange={(event) => setDraftBranch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") createBranch();
                      if (event.key === "Escape") setCreating(false);
                    }}
                    placeholder={t("git.branchSelector.newBranchPlaceholder")}
                    className="h-8 text-xs"
                    autoFocus
                  />
                  <button
                    type="button"
                    className="rounded bg-foreground px-2 py-1.5 text-xs text-background"
                    onClick={createBranch}
                  >
                    {t("git.branchSelector.create")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!canWrite || mutating}
                  title={!canWrite ? disabledMessage : undefined}
                  className="relative flex w-full cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5 text-left text-xs outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setCreating(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("git.branchSelector.createNewBranch")}
                </button>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <GitInitModal
        open={initModalOpen}
        workdir={workdir.trim()}
        branch={initBranch}
        userName={initUserName}
        userEmail={initUserEmail}
        loading={initializing}
        error={initError}
        onBranchChange={setInitBranch}
        onUserNameChange={setInitUserName}
        onUserEmailChange={setInitUserEmail}
        onClose={closeInitModal}
        onSubmit={initRepository}
      />
    </>
  );
}
