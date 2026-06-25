import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  listSubagentIdentities,
  listSubagentRuns,
  type SubagentIdentityRecord,
  type SubagentRunSummary,
} from "../chat/subagent/subagentHistory";
import type { SubagentRuntimeManager } from "../chat/subagent/subagentRuntimeManager";
import type { SubagentScheduler } from "../chat/subagent/subagentScheduler";
import type { RuntimePlatform } from "../runtimePlatform";
import type {
  AgentPromptTemplate,
  CodexRequestFormat,
  McpServerConfig,
  ProviderId,
  ProviderModelConfig,
  ReasoningLevel,
  SshHostConfig,
} from "../settings";
import type {
  BuiltinToolBundle,
  BuiltinToolExecutionContext,
  BuiltinToolMetadata,
  BuiltinToolPreflightResult,
} from "./builtinTypes";
import { createCronTools } from "./cronTools";
import { createCustomSystemTools } from "./customSystemTools";
import { createSubagentMessageTools } from "./delegate/messageTools";
import { createDelegateTools } from "./delegateTools";
import { createFileToolState, type FileToolState } from "./fileToolState";
import { createFsTools } from "./fsTools";
import { createMcpManagerTools } from "./mcpManagerTools";
import { createMcpTools } from "./mcpTools";
import { createMemoryTools } from "./memoryTools";
import { createShellTools } from "./shellTools";
import type { SkillAccessPolicy } from "./skillAccessPolicy";
import { createSkillTools } from "./skillTools";
import { createSSHManagerTools, type SshManagerSessionChange } from "./sshManagerTools";
import type { SystemToolId, SystemToolRuntimeScope } from "./systemToolOptions";
import { createTerminalTools } from "./terminalTools";
import { createTunnelManagerTools } from "./tunnelManagerTools";

export type BuiltinToolRegistry = {
  tools: BuiltinToolBundle["tools"];
  executeToolCall: (
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: BuiltinToolExecutionContext,
  ) => Promise<ToolResultMessage>;
  preflightToolCall: (
    toolCall: ToolCall,
    signal?: AbortSignal,
  ) => Promise<BuiltinToolPreflightResult | null>;
  metadataByName: Map<string, BuiltinToolMetadata>;
  hasTool: (toolName: string) => boolean;
};

export type DelegateToolRuntimeConfig = {
  providerId: ProviderId;
  model: string;
  runtime: {
    baseUrl: string;
    apiKey: string;
    requestFormat?: CodexRequestFormat;
    reasoning?: ReasoningLevel;
    promptCachingEnabled?: boolean;
    nativeWebSearchEnabled?: boolean;
    modelConfig?: ProviderModelConfig;
  };
  conversationId?: string;
  sessionId?: string;
  agentTemplates?: AgentPromptTemplate[];
  conversationSubagentIdentities?: SubagentIdentityRecord[];
  conversationSubagentRuns?: SubagentRunSummary[];
  subagentRuntimeManager?: SubagentRuntimeManager;
  subagentScheduler?: SubagentScheduler;
};

async function loadExistingSubagentRuns(conversationId?: string): Promise<SubagentRunSummary[]> {
  const parentConversationId = conversationId?.trim();
  if (!parentConversationId) return [];
  try {
    return await listSubagentRuns({
      parentConversationId,
      limit: 50,
    });
  } catch (error) {
    console.warn("Failed to load existing delegated subagent runs", error);
    return [];
  }
}

async function loadExistingSubagentIdentities(
  conversationId?: string,
): Promise<SubagentIdentityRecord[]> {
  const parentConversationId = conversationId?.trim();
  if (!parentConversationId) return [];
  try {
    return await listSubagentIdentities({
      parentConversationId,
      limit: 200,
    });
  } catch (error) {
    console.warn("Failed to load delegated subagent identities", error);
    return [];
  }
}

function createBuiltinToolRegistry(bundles: BuiltinToolBundle[]): BuiltinToolRegistry {
  const tools: BuiltinToolBundle["tools"] = [];
  const metadataByName = new Map<string, BuiltinToolMetadata>();
  const executorsByName = new Map<string, BuiltinToolBundle["executeToolCall"]>();
  const preflightsByName = new Map<string, NonNullable<BuiltinToolBundle["preflightToolCall"]>>();
  const canonicalToolNameByLookupKey = new Map<string, string | null>();

  const registerCanonicalToolName = (toolName: string) => {
    const key = toolName.trim().toLowerCase();
    if (!key) return;
    const existing = canonicalToolNameByLookupKey.get(key);
    if (existing === undefined) {
      canonicalToolNameByLookupKey.set(key, toolName);
    } else if (existing !== toolName) {
      canonicalToolNameByLookupKey.set(key, null);
    }
  };

  const resolveToolName = (toolName: string) => {
    if (executorsByName.has(toolName)) return toolName;
    const canonical = canonicalToolNameByLookupKey.get(toolName.trim().toLowerCase());
    return canonical && executorsByName.has(canonical) ? canonical : null;
  };

  for (const bundle of bundles) {
    for (const tool of bundle.tools) {
      if (executorsByName.has(tool.name)) {
        throw new Error(`Duplicate builtin tool name detected: ${tool.name}`);
      }
      tools.push(tool);
      executorsByName.set(tool.name, bundle.executeToolCall);
      if (bundle.preflightToolCall) {
        preflightsByName.set(tool.name, bundle.preflightToolCall);
      }
      registerCanonicalToolName(tool.name);
      const metadata = bundle.metadataByName.get(tool.name);
      if (metadata) {
        metadataByName.set(tool.name, metadata);
      }
    }
  }

  return {
    tools,
    metadataByName,
    hasTool: (toolName) => resolveToolName(toolName) !== null,
    async executeToolCall(toolCall, signal, context) {
      const resolvedToolName = resolveToolName(toolCall.name);
      if (!resolvedToolName) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      }
      const execute = executorsByName.get(resolvedToolName);
      if (!execute) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      }
      const effectiveToolCall =
        resolvedToolName === toolCall.name ? toolCall : { ...toolCall, name: resolvedToolName };
      return execute(effectiveToolCall, signal, context);
    },
    async preflightToolCall(toolCall, signal) {
      const resolvedToolName = resolveToolName(toolCall.name);
      if (!resolvedToolName) return null;
      const preflight = preflightsByName.get(resolvedToolName);
      if (!preflight) return null;
      const effectiveToolCall =
        resolvedToolName === toolCall.name ? toolCall : { ...toolCall, name: resolvedToolName };
      return preflight(effectiveToolCall, signal);
    },
  };
}

type BuildBuiltinBaseToolRegistryParams = {
  workdir: string;
  providerId: ProviderId;
  runtimePlatform?: RuntimePlatform;
  fileState: FileToolState;
  skillsEnabled: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  runtimeScope: SystemToolRuntimeScope;
  currentChatModel?: {
    customProviderId: string;
    model: string;
  };
  selectedSystemToolIds: SystemToolId[];
  mcpSettings: {
    servers: McpServerConfig[];
    selected: string[];
  };
  updateMcpSettings?: (next: { servers: McpServerConfig[]; selected: string[] }) => void;
  enabledMcpServerIds: string[];
  selectableMcpServers: McpServerConfig[];
  onMcpLoadError?: (message: string) => void;
  mcpLoadFailureMode?: "continue" | "throw";
  memoryToolMode?: "rw" | "ro";
  remoteWebTunnelsEnabled?: boolean;
  remoteGatewayOnline?: boolean;
  tunnelProjectPathKey?: string;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  sshManagerRemoteAllowed?: boolean;
  onSshSessionsChanged?: (change: SshManagerSessionChange) => void | Promise<void>;
  onTunnelsChanged?: (change: {
    action: "create" | "probe" | "close";
    tunnel: {
      id: string;
      slug: string;
      name: string;
      targetUrl: string;
      publicUrl: string;
      createdAt: number;
      expiresAt: number;
      status: "active" | "expired" | "offline";
      projectPathKey?: string;
      diagnostics?: Array<{
        protocol: "http" | "websocket" | "sse";
        status: "ok" | "failed" | "unknown";
        statusCode: number;
        errorCode: string;
        message: string;
        checkedAt: number;
      }>;
    };
  }) => void | Promise<void>;
};

async function buildBaseBuiltinToolBundles(params: BuildBuiltinBaseToolRegistryParams) {
  let currentMcpSettings = params.mcpSettings;
  const baseBundles: BuiltinToolBundle[] = [
    createFsTools({
      workdir: params.workdir,
      fileState: params.fileState,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
    }),
    createShellTools({
      workdir: params.workdir,
      providerId: params.providerId,
      runtimePlatform: params.runtimePlatform,
      skillsRootEnabled: params.skillsEnabled,
      skillsRootDir: params.skillsRootDir,
      skillAccessPolicy: params.skillAccessPolicy,
      managedProcessEnabled: params.runtimeScope === "chat",
    }),
    ...(params.skillsEnabled
      ? [
          createSkillTools({
            workdir: params.workdir,
            skillAccessPolicy: params.skillAccessPolicy,
            onManagedSkillsChanged: params.onManagedSkillsChanged,
          }),
        ]
      : []),
    createCronTools({
      currentChatModel: params.currentChatModel,
    }),
    createMcpManagerTools({
      workdir: params.workdir,
      getMcpSettings: () => currentMcpSettings,
      setMcpSettings: params.updateMcpSettings
        ? (next) => {
            currentMcpSettings = next;
            params.updateMcpSettings?.(next);
          }
        : undefined,
      runtimeScope: params.runtimeScope,
    }),
    createCustomSystemTools({
      selectedToolIds: params.selectedSystemToolIds,
      runtimeScope: params.runtimeScope,
      currentChatModel: params.currentChatModel,
    }),
    createMemoryTools({
      workdir: params.workdir,
      mode: params.memoryToolMode ?? "rw",
    }),
    createTunnelManagerTools({
      enabled:
        params.remoteWebTunnelsEnabled === true &&
        params.remoteGatewayOnline === true &&
        params.runtimeScope === "chat",
      runtimeScope: params.runtimeScope,
      projectPathKey: params.tunnelProjectPathKey,
      onTunnelsChanged: params.onTunnelsChanged,
    }),
    createSSHManagerTools({
      enabled:
        params.runtimeScope === "chat" &&
        params.sshManagerRemoteAllowed !== false &&
        (params.associatedSshHostIds?.length ?? 0) > 0,
      runtimeScope: params.runtimeScope,
      workdir: params.workdir,
      projectPathKey: params.tunnelProjectPathKey,
      hosts: params.sshHosts,
      associatedHostIds: params.associatedSshHostIds,
      onSshSessionsChanged: params.onSshSessionsChanged,
    }),
    ...(params.runtimeScope === "chat"
      ? [
          createTerminalTools({
            workdir: params.workdir,
          }),
        ]
      : []),
  ];

  if (params.enabledMcpServerIds.length > 0) {
    const enabledMcpServerIdSet = new Set(params.enabledMcpServerIds);
    const enabledServers = params.selectableMcpServers.filter((server) =>
      enabledMcpServerIdSet.has(server.id),
    );
    baseBundles.push(
      await createMcpTools({
        servers: enabledServers,
        onLoadError: params.onMcpLoadError,
        loadFailureMode: params.mcpLoadFailureMode,
      }),
    );
  }

  return baseBundles;
}

export async function buildBuiltinToolRegistry(
  params: BuildBuiltinBaseToolRegistryParams & {
    delegateRuntime?: DelegateToolRuntimeConfig;
  },
) {
  const baseBundles = await buildBaseBuiltinToolBundles(params);

  if (!params.delegateRuntime) {
    return createBuiltinToolRegistry(baseBundles);
  }

  const baseRegistry = createBuiltinToolRegistry(baseBundles);
  const parentMessageBundle = params.delegateRuntime.conversationId?.trim()
    ? createSubagentMessageTools({
        parentConversationId: params.delegateRuntime.conversationId,
        currentAgentId: "parent",
        currentAgentName: "Parent Agent",
      })
    : null;
  const parentBundles = parentMessageBundle ? [...baseBundles, parentMessageBundle] : baseBundles;
  const storedSubagentRuns = Array.isArray(params.delegateRuntime.conversationSubagentRuns)
    ? []
    : await loadExistingSubagentRuns(params.delegateRuntime.conversationId);
  const existingSubagentRuns = [
    ...(params.delegateRuntime.conversationSubagentRuns ?? []),
    ...storedSubagentRuns,
  ];
  const storedSubagentIdentities = Array.isArray(
    params.delegateRuntime.conversationSubagentIdentities,
  )
    ? []
    : await loadExistingSubagentIdentities(params.delegateRuntime.conversationId);
  const existingSubagentIdentities = [
    ...(params.delegateRuntime.conversationSubagentIdentities ?? []),
    ...storedSubagentIdentities,
  ];
  return createBuiltinToolRegistry([
    ...parentBundles,
    createDelegateTools({
      providerId: params.delegateRuntime.providerId,
      model: params.delegateRuntime.model,
      runtime: params.delegateRuntime.runtime,
      runtimePlatform: params.runtimePlatform,
      workdir: params.workdir,
      parentConversationId: params.delegateRuntime.conversationId,
      sessionId: params.delegateRuntime.sessionId,
      agentTemplates: params.delegateRuntime.agentTemplates,
      existingSubagentIdentities,
      existingSubagentRuns,
      subagentRuntimeManager: params.delegateRuntime.subagentRuntimeManager,
      subagentScheduler: params.delegateRuntime.subagentScheduler,
      baseTools: baseRegistry.tools,
      executeToolCall: baseRegistry.executeToolCall,
      metadataByName: baseRegistry.metadataByName,
      createSubagentToolRegistry: async (workdir) =>
        createBuiltinToolRegistry(
          await buildBaseBuiltinToolBundles({
            ...params,
            workdir,
            fileState: createFileToolState(),
            skillsEnabled: false,
            updateMcpSettings: undefined,
            selectedSystemToolIds: [],
            enabledMcpServerIds: params.enabledMcpServerIds,
            mcpLoadFailureMode: "continue",
            memoryToolMode: "ro",
          }),
        ),
    }),
  ]);
}
