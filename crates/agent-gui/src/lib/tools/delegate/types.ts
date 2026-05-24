import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

import type { AgentPromptTemplate, CodexRequestFormat, ProviderModelConfig, ReasoningLevel } from "../../settings";
import type { BuiltinToolMetadata } from "../builtinTypes";

export type DelegateRuntime = {
  baseUrl: string;
  apiKey: string;
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  nativeWebSearchEnabled?: boolean;
  modelConfig?: ProviderModelConfig;
};

export type DelegateAgentInput = {
  id: string;
  name?: string;
  role?: string;
  identity?: string;
  prompt: string;
  agentId?: string;
  mode: DelegateExecutionMode;
  modeSpecified: boolean;
  taskIntent: DelegateTaskIntent;
  taskIntentSpecified: boolean;
  applyPolicy: DelegateApplyPolicy;
  applyPolicySpecified: boolean;
  allowedOutputPaths: string[];
  resume: boolean;
  retainWorktree: boolean;
};

export type DelegateExecutionMode = "readonly" | "worktree";

export type DelegateTaskIntent =
  | "communication"
  | "research"
  | "review"
  | "implementation"
  | "document_generation";

export type DelegateApplyPolicy = "none" | "explicit" | "auto";

export type DelegateAgentTemplate = Pick<
  AgentPromptTemplate,
  "id" | "name" | "description" | "tags" | "prompt"
>;

export type DelegateWorktreeInfo = {
  repo_root: string;
  worktree_root: string;
  workdir: string;
  branch_name: string;
};

export type DelegateWorktreeStatus = {
  changed: boolean;
  status: string;
  diff_stat: string;
  diff: string;
  diff_truncated: boolean;
  untracked_files: string[];
};

export type DelegateWorktreeApplyResult = {
  applied: boolean;
  changed: boolean;
  status: string;
  patch_bytes: number;
  skipped_reason?: string;
  apply_method?: "git_apply" | "git_apply_3way" | "file_copy_fallback";
  fallback_reason?: string;
  copied_files?: string[];
  deleted_files?: string[];
  conflict_files?: string[];
};

export type DelegateWorktreeCleanupResult = {
  worktreeRoot: string;
  branchName?: string;
  removed: boolean;
  branchDeleted: boolean;
  skippedReason?: string;
  error?: string;
};

export type WorktreeApplyDecision = {
  shouldApply: boolean;
  skippedReason?: string;
  changedPaths: string[];
  candidateArtifacts: string[];
};

export type DelegateToolRegistry = {
  tools: Tool[];
  executeToolCall: (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;
  metadataByName: Map<string, BuiltinToolMetadata>;
};

export type CreateDelegateWorktree = (params: {
  workdir: string;
  label: string;
}) => Promise<DelegateWorktreeInfo>;

export type GetDelegateWorktreeStatus = (params: {
  worktreeRoot: string;
  maxDiffChars: number;
}) => Promise<DelegateWorktreeStatus>;

export type ApplyDelegateWorktreeChanges = (params: {
  parentWorkdir: string;
  worktreeRoot: string;
}) => Promise<DelegateWorktreeApplyResult>;

export type CleanupDelegateWorktree = (params: {
  worktreeRoot: string;
  branchName?: string;
}) => Promise<DelegateWorktreeCleanupResult>;
