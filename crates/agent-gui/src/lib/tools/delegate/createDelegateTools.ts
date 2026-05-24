import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

import { runAssistantWithTools } from "../../chat/runner/agentRunner";
import {
  appendMessagesToConversation,
  buildRequestContext,
  createConversationStateFromContext,
  type ConversationViewState,
} from "../../chat/conversation/conversationState";
import {
  createCompactionThrottleState,
  noteCompactionApplied,
  noteCompactionRound,
  runMidTurnCompaction,
  runPreCompactConversation,
} from "../../chat/compaction/contextCompaction";
import {
  defaultSubagentHistoryRecorder,
  listSubagentMessages,
  type SubagentHistoryRecorder,
  type SubagentIdentityRecord,
  type SubagentMessageRecord,
  type SubagentRunRecord,
  type SubagentRunStatus,
  type SubagentRunSummary,
} from "../../chat/subagent/subagentHistory";
import { renderSubagentMessageBusSnapshot } from "../../chat/subagent/subagentMessageBus";
import type { SubagentRuntimeManager } from "../../chat/subagent/subagentRuntimeManager";
import { createSubagentScheduler, type SubagentScheduler } from "../../chat/subagent/subagentScheduler";
import type { ProviderId } from "../../settings";
import {
  createBuiltinMetadataMap,
  type BuiltinToolBundle,
  type BuiltinToolExecutionContext,
  type BuiltinToolMetadata,
  type DelegateAgentItemResultDetails,
  type DelegateAgentResultDetails,
} from "../builtinTypes";
import {
  DEFAULT_CONCURRENCY,
  DELEGATE_TOOL_NAME,
  MAX_CONCURRENCY,
  MAX_DIFF_CHARS,
  TEXT_DELTA_EVENT_CHUNK_CHARS,
  THINKING_DELTA_EVENT_CHUNK_CHARS,
} from "./constants";
import {
  createAgentTemplateLookup,
  createSubagentIdentity,
  findKnownIdentityForTask,
  formatConfiguredAgents,
  formatKnownSubagentRoster,
  identitiesByLogicalAgent,
  latestRunsByLogicalAgent,
  normalizeLookupKey,
  shouldRejectLikelyExistingAgentFork,
} from "./identity";
import {
  normalizeDelegateAgents,
  normalizeSubagentRunMode,
  resolveResumedAgentExecutionMode,
} from "./input";
import {
  buildSubagentContext,
  buildSubagentContinuationMessage,
  buildSubagentMessageBusUpdateMessage,
} from "./prompts";
import { createSubagentMessageTools } from "./messageTools";
import {
  buildDelegateAgentCardResult,
  buildDelegateAgentCardToolCall,
  buildDelegateResultText,
} from "./results";
import { DELEGATE_AGENT_PARAMETERS } from "./schema";
import { selectReadOnlyTools, selectWorktreeTools } from "./toolSelection";
import type {
  ApplyDelegateWorktreeChanges,
  CleanupDelegateWorktree,
  CreateDelegateWorktree,
  DelegateAgentInput,
  DelegateAgentTemplate,
  DelegateRuntime,
  DelegateToolRegistry,
  DelegateWorktreeInfo,
  DelegateWorktreeStatus,
  GetDelegateWorktreeStatus,
} from "./types";
import {
  asObject,
  assistantMessageToText,
  clampInteger,
  createSequentialQueue,
  normalizeErrorMessage,
  runWithConcurrency,
  sanitizeLabelPart,
  truncateText,
} from "./utils";
import {
  buildSubagentRunId,
  normalizeHistoryError,
  parseSubagentRunState,
  rememberSubagentRun,
} from "./history";
import {
  buildWorktreeLabel,
  decideWorktreeApply,
  decideWorktreeCleanup,
  defaultApplyWorktreeChanges,
  defaultCleanupWorktree,
  defaultCreateWorktree,
  defaultGetWorktreeStatus,
} from "./worktree";

export function createDelegateTools(params: {
  providerId: ProviderId;
  model: string;
  runtime: DelegateRuntime;
  workdir: string;
  parentConversationId?: string;
  sessionId?: string;
  agentTemplates?: DelegateAgentTemplate[];
  existingSubagentIdentities?: SubagentIdentityRecord[];
  existingSubagentRuns?: SubagentRunSummary[];
  baseTools: Tool[];
  executeToolCall: (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;
  metadataByName: Map<string, BuiltinToolMetadata>;
  createSubagentToolRegistry?: (workdir: string) => Promise<DelegateToolRegistry>;
  createWorktree?: CreateDelegateWorktree;
  getWorktreeStatus?: GetDelegateWorktreeStatus;
  applyWorktreeChanges?: ApplyDelegateWorktreeChanges;
  cleanupWorktree?: CleanupDelegateWorktree;
  subagentHistory?: SubagentHistoryRecorder;
  subagentRuntimeManager?: SubagentRuntimeManager;
  subagentScheduler?: SubagentScheduler;
}): BuiltinToolBundle {
  const templates = params.agentTemplates ?? [];
  const templateLookup = createAgentTemplateLookup(templates);
  const existingSubagentRuns = params.existingSubagentRuns ?? [];
  const existingRunsByLogicalAgent = latestRunsByLogicalAgent(existingSubagentRuns);
  const existingIdentitiesByLogicalAgent = identitiesByLogicalAgent(
    params.existingSubagentIdentities ?? [],
  );
  const readOnlyTools = selectReadOnlyTools({
    tools: params.baseTools,
    metadataByName: params.metadataByName,
  });
  const readOnlyToolNames = new Set(readOnlyTools.map((tool) => tool.name));
  const createWorktree = params.createWorktree ?? defaultCreateWorktree;
  const getWorktreeStatus = params.getWorktreeStatus ?? defaultGetWorktreeStatus;
  const applyWorktreeChanges =
    params.applyWorktreeChanges ?? defaultApplyWorktreeChanges;
  const cleanupWorktree = params.cleanupWorktree ?? defaultCleanupWorktree;
  const enqueueApplyWorktreeChanges = createSequentialQueue();
  const subagentHistory = params.subagentHistory ?? defaultSubagentHistoryRecorder;
  const messageBusEnabled = Boolean(params.parentConversationId?.trim());
  const subagentRuntimeManager = params.subagentRuntimeManager;
  const fallbackSubagentScheduler =
    params.subagentScheduler ?? createSubagentScheduler();
  const loadMessageBusRecords = async (
    recipientAgentId?: string,
  ): Promise<SubagentMessageRecord[]> => {
    const parentConversationId = params.parentConversationId?.trim();
    if (!parentConversationId) return [];
    const listMessages = subagentHistory.listMessages ?? listSubagentMessages;
    try {
      return await listMessages({
        parentConversationId,
        recipientAgentId,
        includeShared: true,
        includeSent: true,
        limit: 80,
      });
    } catch (error) {
      console.warn("Failed to load LiveAgent Message Bus records", error);
      return [];
    }
  };
  const renderMessageBusSnapshot = async (agent: {
    id: string;
    name?: string;
  }) => {
    const messages = await loadMessageBusRecords(agent.id);
    return renderSubagentMessageBusSnapshot({
      messages,
      currentAgentId: agent.id,
      currentAgentName: agent.name,
    });
  };
  const enqueueByLogicalAgent = new Map<
    string,
    ReturnType<typeof createSequentialQueue>
  >();
  const enqueueLogicalAgentRun = <T>(
    logicalAgentId: string,
    run: () => Promise<T>,
  ) => {
    const conversationKey =
      params.parentConversationId?.trim() || params.sessionId?.trim() || "conversation";
    const key = `${conversationKey}\0${logicalAgentId}`;
    let enqueue = enqueueByLogicalAgent.get(key);
    if (!enqueue) {
      enqueue = createSequentialQueue();
      enqueueByLogicalAgent.set(key, enqueue);
    }
    return enqueue(run);
  };

  const toolAgent: Tool = {
    name: DELEGATE_TOOL_NAME,
    description: [
      "Delegate one or more independent jobs to persistent isolated LiveAgent agents and return their final reports.",
      "JSON stability rule: for two or more agents, or any long persona/identity text, use the agent_spec string only. Do not put a batch of agents in nested JSON.",
      "agent_spec is a plain-text manifest. Use one block per agent: @agent id=player1 mode=readonly, then one field per line: name=Player 1, role=..., identity=..., prompt=..., and a line containing --- before the next agent. name:/role:/identity:/prompt: are also accepted.",
      "Parallelism is the primary behavior: put independent jobs in one Agent call with agent_spec so LiveAgent runs them concurrently up to concurrency. Do not make separate sequential Agent calls for independent work; split calls only when later agents truly depend on earlier results.",
      "LiveAgent infers a safe default mode from task_intent and the prompt: communication/research/review agents run readonly and return messages; implementation and explicit document-generation agents may use worktree.",
      "Use task_intent=communication for discussions, debates, roundtables, role-play replies, or agent-to-agent dialogue. Subagents can use SendMessage for intermediate messages; final reports remain completion summaries. Do not use workspace files as the message channel. Messages sent to parent are private to the parent; if peer agents need to read a report, send a concise Markdown copy or summary to to=*.",
      "Worktree mode gives full workspace file tools and Bash inside an isolated git worktree. It is for implementation, tests, or explicitly requested files, not for writing temporary discussion notes.",
      "apply_policy controls merge-back behavior: none never applies, explicit applies only allowed_output_paths, auto applies implementation patches. Communication/research/review default to apply_policy=none even if mode=worktree.",
      "LiveAgent automatically cleans completed worktrees when changes were applied or there were no changes. Worktrees with unapplied changes, failed agents, or retain_worktree=true are kept for review.",
      "Use mode=readonly for cheap research/review agent jobs that should only inspect files.",
      "Subagents cannot call Agent recursively. Worktree mode still must not modify global LiveAgent settings, MCP server configuration, cron tasks, or user-level skills.",
      "Delegated agents persist by stable id inside the current parent conversation. When the user asks an existing delegated agent, expert, or team to continue, call Agent again with the same id; by default the subagent resumes its previous private context. A resumed readonly agent may be upgraded to worktree for later implementation or explicit file-generation work; include allowed_output_paths when generated files should be applied. Set resume=false only when you intentionally want a fresh private context for the same stable id; it does not rename or redefine an existing identity. To create a genuinely new persona, use a new stable id.",
      "Include the new user request and any parent-conversation context each subagent needs in that agent's prompt. The full parent conversation is not automatically copied into subagents.",
      "Create a delegated agent once with stable id, name, role, and identity. For later calls to the same agent, pass the same id and only the new prompt for the current task; LiveAgent will reuse the stored identity and ignore attempts to rename or redefine that agent.",
      "Existing delegated agents that may be resumed by id:",
      formatKnownSubagentRoster(
        existingIdentitiesByLogicalAgent,
        existingRunsByLogicalAgent,
      ),
      "Configured AGENTS templates that may be referenced by agent_id:",
      formatConfiguredAgents(templates),
    ].join("\n"),
    parameters: DELEGATE_AGENT_PARAMETERS,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: BuiltinToolExecutionContext,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (toolCall.name !== DELEGATE_TOOL_NAME) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    const args = asObject(toolCall.arguments);
    const rawAgents = normalizeDelegateAgents(args);
    const agents: DelegateAgentInput[] = [];
    const canonicalizationNotes: string[] = [];
    for (const rawTask of rawAgents) {
      const matchedIdentity = findKnownIdentityForTask(
        rawTask,
        existingIdentitiesByLogicalAgent,
      );
      if (matchedIdentity && matchedIdentity.logicalAgentId !== rawTask.id) {
        canonicalizationNotes.push(
          `- requested id=${rawTask.id} name=${rawTask.name ?? "(none)"} -> id=${matchedIdentity.logicalAgentId} name=${matchedIdentity.displayName}`,
        );
        agents.push({
          ...rawTask,
          id: matchedIdentity.logicalAgentId,
          name: matchedIdentity.displayName,
        });
        continue;
      }

      const referenced = shouldRejectLikelyExistingAgentFork({
        task: rawTask,
        identitiesByLogicalAgent: existingIdentitiesByLogicalAgent,
      });
      if (referenced) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            {
              type: "text",
              text: [
                "Agent rejected this call because it appears to create a new communication subagent for already-existing delegated agents.",
                "Reuse the stable id/name values from the current roster instead of creating phase, vote, night, debate, or aggregate Agent names.",
                "Call Agent again with agent_spec blocks for the existing agents that need to respond. Set resume=false only when you need a fresh private context for the same stable id; it does not rename or redefine an existing identity. Use a new stable id only when the user explicitly asks for a genuinely new persona.",
                "",
                "Current stable delegated-agent roster:",
                formatKnownSubagentRoster(
                  existingIdentitiesByLogicalAgent,
                  existingRunsByLogicalAgent,
                ),
                "",
                `Rejected request: id=${rawTask.id} name=${rawTask.name ?? "(none)"} prompt=${rawTask.prompt}`,
                `Referenced existing agents: ${referenced
                  .map((identity) => `${identity.logicalAgentId}(${identity.displayName})`)
                  .join(", ")}`,
              ].join("\n"),
            },
          ],
          details: {},
          isError: true,
          timestamp: now,
        };
      }
      agents.push(rawTask);
    }
    const agentsByStableId = new Map<string, DelegateAgentInput[]>();
    for (const agent of agents) {
      const key = normalizeLookupKey(agent.id);
      const items = agentsByStableId.get(key) ?? [];
      items.push(agent);
      agentsByStableId.set(key, items);
    }
    const duplicateStableAgent = Array.from(agentsByStableId.entries()).find(
      ([, items]) => items.length > 1,
    );
    if (duplicateStableAgent) {
      const [, duplicates] = duplicateStableAgent;
      const stableId = duplicates[0]?.id ?? "(unknown)";
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: [
              "Agent rejected this call because multiple delegated-agent requests resolve to the same stable delegated-agent id.",
              "Merge those requests into one prompt for that agent, or use different stable ids only for genuinely different personas.",
              "Do not use phase, vote, night, debate, or round-specific Agent names for an existing roster member.",
              "",
              `Duplicate stable id: ${stableId}`,
              "Duplicate requests:",
              ...duplicates.map(
                (agent, index) =>
                  `${index + 1}. id=${agent.id} name=${agent.name ?? "(none)"} prompt=${agent.prompt}`,
              ),
              canonicalizationNotes.length > 0
                ? `\nAgent roster canonicalization:\n${canonicalizationNotes.join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
    const concurrency = Math.min(
      agents.length,
      clampInteger(args.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    );
    const subagentScheduler =
      context?.subagentScheduler ?? fallbackSubagentScheduler;
    const startedAt = Date.now();
    const runStableSubagent = <T>(logicalAgentId: string, run: () => Promise<T>) =>
      enqueueLogicalAgentRun(logicalAgentId, () =>
        subagentScheduler.runSubagent(run, signal),
      );

    const taskResults = await runWithConcurrency(
      agents,
      concurrency,
      async (rawTask, index): Promise<DelegateAgentItemResultDetails> => {
        return runStableSubagent(rawTask.id, async () => {
          const existingRunSummary = rawTask.resume
            ? existingRunsByLogicalAgent.get(rawTask.id)
            : undefined;
          const existingMode = existingRunSummary
            ? normalizeSubagentRunMode(existingRunSummary.mode)
            : undefined;
          let task: DelegateAgentInput = resolveResumedAgentExecutionMode({
            task: rawTask,
            existingMode,
          });
          const template = task.agentId
            ? templateLookup.get(normalizeLookupKey(task.agentId))
            : undefined;
          const existingIdentity = existingIdentitiesByLogicalAgent.get(task.id);
          const identity =
            existingIdentity ??
            createSubagentIdentity({
              parentConversationId: params.parentConversationId,
              parentToolCallId: toolCall.id,
              task,
              template,
              now: Date.now(),
            });
          const shouldRememberIdentity = !(task.agentId && !template);
          if (shouldRememberIdentity) {
            existingIdentitiesByLogicalAgent.set(identity.logicalAgentId, identity);
          }
          task = {
            ...task,
            id: identity.logicalAgentId,
            name: identity.displayName,
            role: identity.role,
            identity: identity.identityPrompt,
            agentId: identity.agentId ?? task.agentId,
          };
          const displayName = identity.displayName;
          const agentCardToolCall = buildDelegateAgentCardToolCall({
            parentToolCall: toolCall,
            agent: task,
            identity,
            index,
            total: agents.length,
            concurrency,
          });
          context?.emitToolCall?.(agentCardToolCall);
          context?.emitToolExecutionStart?.(agentCardToolCall);

          const finishAgent = (agent: DelegateAgentItemResultDetails) => {
            context?.emitToolResult?.(
              agentCardToolCall,
              buildDelegateAgentCardResult({
                parentToolCall: toolCall,
                toolCall: agentCardToolCall,
                agent,
                index,
                total: agents.length,
                concurrency,
              }),
            );
            return agent;
          };

          const taskStartedAt = Date.now();
          const runId = buildSubagentRunId({
            parentToolCallId: toolCall.id,
            agent: task,
            index,
          });
          const subagentSessionId = params.sessionId
            ? existingRunSummary?.sessionId ??
              (rawTask.resume
                ? `${params.sessionId}:subagent:${sanitizeLabelPart(task.id, `agent-${index + 1}`)}`
                : `${params.sessionId}:subagent:${sanitizeLabelPart(task.id, `agent-${index + 1}`)}:fresh:${sanitizeLabelPart(runId, "run")}`)
            : undefined;
          const rememberResult = (
            result: DelegateAgentItemResultDetails,
            endedAt?: number,
          ) => {
            rememberSubagentRun(existingRunsByLogicalAgent, {
              runId,
              task,
              result,
              parentConversationId: params.parentConversationId,
              parentToolCall: toolCall,
              agentIndex: index,
              agentTotal: agents.length,
              providerId: params.providerId,
              model: params.model,
              sessionId: subagentSessionId,
              startedAt: taskStartedAt,
              endedAt,
              updatedAt: Date.now(),
            });
            return result;
          };

          let rounds = 0;
          let toolCalls = 0;
          let compactions = 0;
          let worktree: DelegateWorktreeInfo | undefined;
          let worktreeStatus: DelegateWorktreeStatus | undefined;
          let worktreeStatusError: string | undefined;
          let applyStatus: DelegateAgentItemResultDetails["applyStatus"] | undefined;
          let applyMethod: DelegateAgentItemResultDetails["applyMethod"] | undefined;
          let applyChanged: boolean | undefined;
          let applyPatchBytes: number | undefined;
          let applySkippedReason: string | undefined;
          let applyFallbackReason: string | undefined;
          let applyCopiedFiles: string[] | undefined;
          let applyDeletedFiles: string[] | undefined;
          let applyConflictFiles: string[] | undefined;
          let applyError: string | undefined;
          let appliedToWorkdir: string | undefined;
          let worktreeCleanupStatus:
            | DelegateAgentItemResultDetails["worktreeCleanupStatus"]
            | undefined;
          let worktreeCleanupReason: string | undefined;
          let worktreeCleanupError: string | undefined;
          let worktreeBranchDeleted: boolean | undefined;
          let candidateArtifacts: string[] | undefined;
          let changedPaths: string[] | undefined;
          let childWorkdir = params.workdir;
          let childTools = readOnlyTools;
          let childExecuteToolCall = params.executeToolCall;
          let childToolNames = readOnlyToolNames;
          const withSubagentMessageTools = (
            tools: Tool[],
            execute: typeof params.executeToolCall,
          ) => {
            if (!messageBusEnabled) {
              return { tools, executeToolCall: execute };
            }
            const messageBundle = createSubagentMessageTools({
              parentConversationId: params.parentConversationId,
              currentAgentId: task.id,
              currentAgentName: displayName,
              currentRunId: runId,
              subagentHistory,
            });
            const messageToolNames = new Set(messageBundle.tools.map((tool) => tool.name));
            return {
              tools: [...tools, ...messageBundle.tools],
              executeToolCall: (tool: ToolCall, childSignal?: AbortSignal) =>
                messageToolNames.has(tool.name)
                  ? messageBundle.executeToolCall(tool, childSignal)
                  : execute(tool, childSignal),
            };
          };
          {
            const childRuntime = withSubagentMessageTools(
              readOnlyTools,
              params.executeToolCall,
            );
            childTools = childRuntime.tools;
            childExecuteToolCall = childRuntime.executeToolCall;
            childToolNames = new Set(childTools.map((tool) => tool.name));
          }
          const initialMessageBusSnapshot = await renderMessageBusSnapshot({
            id: task.id,
            name: displayName,
          });
          let subagentState: ConversationViewState = createConversationStateFromContext(
            buildSubagentContext({
              task,
              template,
              identity,
              tools: childTools,
              agentIndex: index,
              agentTotal: agents.length,
              messageBusSnapshot: initialMessageBusSnapshot,
              messageBusEnabled,
            }),
          );
          const compactionThrottleState = createCompactionThrottleState();
          const historyTasks: Promise<void>[] = [];
          let historyError: string | undefined;
          const textDeltaBuffersByRound = new Map<number, string>();
          const thinkingDeltaBuffersByRound = new Map<number, string>();

          const trackHistory = (taskPromise: Promise<void>) => {
            historyTasks.push(
              taskPromise.catch((historyErr) => {
                historyError = normalizeHistoryError(historyErr);
                console.warn("Failed to persist delegated subagent history", historyErr);
              }),
            );
          };
          const flushHistory = async () => {
            while (historyTasks.length > 0) {
              const pending = historyTasks.splice(0);
              await Promise.all(pending);
            }
          };
          const persistRunState = (
            status: SubagentRunStatus,
            options?: {
              summary?: string;
              error?: string;
              endedAt?: number;
              updatedAt?: number;
            },
          ) => {
            const input = {
              id: runId,
              parentConversationId: params.parentConversationId,
              parentSessionId: params.sessionId,
              parentToolCallId: toolCall.id,
              parentToolName: toolCall.name,
              agentIndex: index,
              agentTotal: agents.length,
              logicalAgentId: task.id,
              agentId: task.agentId,
              agentName: displayName,
              description: task.prompt,
              mode: task.mode,
              status,
              providerId: params.providerId,
              model: params.model,
              sessionId: subagentSessionId,
              workdir: childWorkdir,
              worktreeRoot: worktree?.worktree_root,
              branchName: worktree?.branch_name,
              state: subagentState,
              roundCount: rounds,
              toolCallCount: toolCalls,
              compactionCount: compactions,
              summary: options?.summary,
              error: options?.error ?? historyError,
              startedAt: taskStartedAt,
              endedAt: options?.endedAt,
              createdAt: taskStartedAt,
              updatedAt: options?.updatedAt ?? Date.now(),
            };
            const writePromise = subagentHistory.persistRunState(input);
            if (status === "running") return writePromise;
            return writePromise.then(() => {
              subagentRuntimeManager?.rememberRunState({
                input,
                identity,
              });
            });
          };
          const persistIdentity = () => {
            if (existingIdentity || !shouldRememberIdentity || !subagentHistory.upsertIdentity) {
              return Promise.resolve();
            }
            return subagentHistory
              .upsertIdentity({
                parentConversationId: params.parentConversationId,
                logicalAgentId: identity.logicalAgentId,
                displayName: identity.displayName,
                role: identity.role,
                identityPrompt: identity.identityPrompt,
                agentId: identity.agentId,
                templateName: identity.templateName,
                defaultMode: identity.defaultMode,
                defaultTaskIntent: identity.defaultTaskIntent,
                defaultApplyPolicy: identity.defaultApplyPolicy,
                createdParentToolCallId: identity.createdParentToolCallId,
                createdAt: identity.createdAt,
                updatedAt: Date.now(),
              })
              .then((stored) => {
                if (stored) {
                  existingIdentitiesByLogicalAgent.set(stored.logicalAgentId, stored);
                }
              });
          };
          const recordEvent = (event: {
            eventType: string;
            roundIndex?: number;
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
            payload?: unknown;
          }) => {
            trackHistory(
              subagentHistory.appendEvent({
                runId,
                eventType: event.eventType,
                roundIndex: event.roundIndex,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                isError: event.isError,
                payload: event.payload,
                createdAt: Date.now(),
              }),
            );
          };
          const flushTextDeltaBuffer = (roundIndex?: number) => {
            const entries: Array<[number, string]> =
              typeof roundIndex === "number"
                ? [[roundIndex, textDeltaBuffersByRound.get(roundIndex) ?? ""]]
                : Array.from(textDeltaBuffersByRound.entries());
            for (const [round, text] of entries) {
              if (!text) continue;
              textDeltaBuffersByRound.delete(round);
              recordEvent({
                eventType: "text_delta",
                roundIndex: round,
                payload: { text },
              });
            }
          };
          const recordTextDelta = (delta: string, round: number) => {
            if (!delta) return;
            const next = `${textDeltaBuffersByRound.get(round) ?? ""}${delta}`;
            textDeltaBuffersByRound.set(round, next);
            if (next.length >= TEXT_DELTA_EVENT_CHUNK_CHARS) {
              flushTextDeltaBuffer(round);
            }
          };
          const flushThinkingDeltaBuffer = (roundIndex?: number) => {
            const entries: Array<[number, string]> =
              typeof roundIndex === "number"
                ? [[roundIndex, thinkingDeltaBuffersByRound.get(roundIndex) ?? ""]]
                : Array.from(thinkingDeltaBuffersByRound.entries());
            for (const [round, text] of entries) {
              if (!text) continue;
              thinkingDeltaBuffersByRound.delete(round);
              recordEvent({
                eventType: "thinking_delta",
                roundIndex: round,
                payload: { delta: text },
              });
            }
          };
          const recordThinkingDelta = (delta: string, round: number) => {
            if (!delta) return;
            const next = `${thinkingDeltaBuffersByRound.get(round) ?? ""}${delta}`;
            thinkingDeltaBuffersByRound.set(round, next);
            if (next.length >= THINKING_DELTA_EVENT_CHUNK_CHARS) {
              flushThinkingDeltaBuffer(round);
            }
          };
          const tryResumeSubagentState = async (resumeParams: {
            tools: Tool[];
            worktree?: DelegateWorktreeInfo;
          }) => {
            const loadRunState = subagentHistory.getRunState ?? subagentHistory.getRun;
            if (!existingRunSummary) return false;
            let restoredState =
              subagentRuntimeManager?.getHydratedState({
                parentConversationId: params.parentConversationId,
                runSummary: existingRunSummary,
                task,
                template,
                identity,
                worktree: resumeParams.worktree,
                tools: resumeParams.tools,
              }) ?? null;
            let resumeSource: "memory" | "history" = "memory";
            if (!restoredState) {
              if (!loadRunState) return false;
              resumeSource = "history";
              let record: SubagentRunRecord | null = null;
              try {
                record = await loadRunState(existingRunSummary.id);
              } catch (resumeErr) {
                recordEvent({
                  eventType: "resume_failed",
                  isError: true,
                  payload: {
                    runId: existingRunSummary.id,
                    error: normalizeErrorMessage(
                      resumeErr instanceof Error ? resumeErr.message : String(resumeErr),
                      "Failed to load previous subagent run",
                    ),
                  },
                });
                return false;
              }
              if (!record) return false;
              restoredState = parseSubagentRunState({
                record,
                task,
                template,
                identity,
                worktree: resumeParams.worktree,
                tools: resumeParams.tools,
              });
              if (!restoredState) {
                recordEvent({
                  eventType: "resume_failed",
                  isError: true,
                  payload: {
                    runId: existingRunSummary.id,
                    error: "Previous subagent run could not be restored",
                  },
                });
                return false;
              }
              subagentRuntimeManager?.rememberRunState({
                input: {
                  id: existingRunSummary.id,
                  parentConversationId: existingRunSummary.parentConversationId,
                  parentSessionId: params.sessionId,
                  parentToolCallId: existingRunSummary.parentToolCallId,
                  parentToolName: existingRunSummary.parentToolName,
                  agentIndex: existingRunSummary.agentIndex,
                  agentTotal: existingRunSummary.agentTotal,
                  logicalAgentId: existingRunSummary.logicalAgentId,
                  agentId: existingRunSummary.agentId,
                  agentName: existingRunSummary.agentName,
                  description: existingRunSummary.description,
                  mode: existingRunSummary.mode,
                  status: existingRunSummary.status,
                  providerId: existingRunSummary.providerId,
                  model: existingRunSummary.model,
                  sessionId: existingRunSummary.sessionId,
                  workdir: existingRunSummary.workdir,
                  worktreeRoot: existingRunSummary.worktreeRoot,
                  branchName: existingRunSummary.branchName,
                  state: restoredState,
                  roundCount: existingRunSummary.roundCount,
                  toolCallCount: existingRunSummary.toolCallCount,
                  compactionCount: existingRunSummary.compactionCount,
                  summary: existingRunSummary.summary,
                  error: existingRunSummary.error,
                  startedAt: existingRunSummary.startedAt,
                  endedAt: existingRunSummary.endedAt,
                  createdAt: existingRunSummary.startedAt,
                  updatedAt: existingRunSummary.updatedAt,
                },
                identity,
              });
            }

            let baseState = restoredState;
            const requestContext = buildRequestContext(baseState);
            recordEvent({
              eventType: "pre_compaction_check",
              payload: {
                source: resumeSource,
                runId: existingRunSummary.id,
                logicalAgentId: task.id,
                messageCount: baseState.meta.totalMessageCount,
                totalSegmentCount: baseState.meta.totalSegmentCount,
              },
            });
            try {
              const compacted = await runPreCompactConversation({
                state: baseState,
                requestContext,
                budgetContext: requestContext,
                incomingUserText: task.prompt,
                providerId: params.providerId,
                model: params.model,
                runtime: params.runtime,
                signal,
                throttleState: compactionThrottleState,
              });
              if (compacted.applied) {
                baseState = compacted.state;
                compactions += 1;
                noteCompactionApplied(compactionThrottleState);
                recordEvent({
                  eventType: "pre_compaction_completed",
                  payload: {
                    source: resumeSource,
                    decision: compacted.decision,
                    activeSegmentIndex: compacted.state.activeSegmentIndex,
                    totalSegmentCount: compacted.state.meta.totalSegmentCount,
                  },
                });
              } else {
                recordEvent({
                  eventType: "pre_compaction_skipped",
                  payload: { source: resumeSource, decision: compacted.decision },
                });
              }
            } catch (compactionErr) {
              recordEvent({
                eventType: "pre_compaction_failed",
                isError: true,
                payload: {
                  source: resumeSource,
                  error: normalizeErrorMessage(
                    compactionErr instanceof Error
                      ? compactionErr.message
                      : String(compactionErr),
                    "Subagent pre-compaction failed",
                  ),
                },
              });
            }

            subagentState = appendMessagesToConversation(baseState, [
              buildSubagentContinuationMessage({
                task,
                identity,
                resumedFrom: existingRunSummary,
                messageBusSnapshot: await renderMessageBusSnapshot({
                  id: task.id,
                  name: displayName,
                }),
                messageBusEnabled,
              }),
            ]);
            recordEvent({
              eventType: "resume_loaded",
              payload: {
                source: resumeSource,
                runId: existingRunSummary.id,
                logicalAgentId: task.id,
                messageCount: subagentState.meta.totalMessageCount,
                totalSegmentCount: subagentState.meta.totalSegmentCount,
              },
            });
            return true;
          };

          trackHistory(persistIdentity());
          trackHistory(persistRunState("running"));
          recordEvent({
            eventType: "run_start",
            payload: {
              name: displayName,
              agentId: task.agentId,
              logicalAgentId: task.id,
              prompt: task.prompt,
              mode: task.mode,
              resumeCandidateRunId: existingRunSummary?.id,
              parentToolCallId: toolCall.id,
            },
          });
          if (task.mode === "readonly") {
            const resumed = await tryResumeSubagentState({ tools: childTools });
            if (resumed) {
              trackHistory(persistRunState("running"));
            }
          }
          if (task.agentId && !template) {
            const message = `Unknown subagent template: ${task.agentId}`;
            recordEvent({
              eventType: "run_failed",
              isError: true,
              payload: { error: message },
            });
            await persistRunState("failed", {
              error: message,
              endedAt: Date.now(),
            });
            await flushHistory();
            const failedAgent = rememberResult({
              id: task.id,
              runId,
              name: displayName,
              role: identity.role,
              prompt: task.prompt,
              agentId: task.agentId,
              mode: task.mode,
              status: "failed",
              summary: "",
              durationMs: Date.now() - taskStartedAt,
              rounds: 0,
              toolCalls: 0,
              error: message,
            });
            return finishAgent(failedAgent);
          }

          try {
            if (task.mode === "worktree") {
              if (!params.createSubagentToolRegistry) {
                throw new Error("Agent mode=worktree is not available in this runtime.");
              }
              recordEvent({
                eventType: "worktree_create_start",
                payload: { workdir: params.workdir },
              });
              worktree = await createWorktree({
                workdir: params.workdir,
                label: buildWorktreeLabel({
                  sessionId: params.sessionId,
                  toolCallId: toolCall.id,
                  agent: task,
                  index,
                }),
              });
              recordEvent({
                eventType: "worktree_created",
                payload: worktree,
              });
              const childRegistry = await params.createSubagentToolRegistry(worktree.workdir);
              const worktreeTools = selectWorktreeTools({
                tools: childRegistry.tools,
                metadataByName: childRegistry.metadataByName,
              });
              const childRuntime = withSubagentMessageTools(
                worktreeTools,
                childRegistry.executeToolCall,
              );
              childTools = childRuntime.tools;
              childExecuteToolCall = childRuntime.executeToolCall;
              childToolNames = new Set(childTools.map((tool) => tool.name));
              childWorkdir = worktree.workdir;
              const resumed = await tryResumeSubagentState({
                tools: childTools,
                worktree,
              });
              if (!resumed) {
                subagentState = createConversationStateFromContext(
                  buildSubagentContext({
                    task,
                    template,
                    identity,
                    worktree,
                    tools: childTools,
                    agentIndex: index,
                    agentTotal: agents.length,
                    messageBusSnapshot: initialMessageBusSnapshot,
                    messageBusEnabled,
                  }),
                );
              }
              trackHistory(persistRunState("running"));
            }

            const result = await runAssistantWithTools({
              providerId: params.providerId,
              model: params.model,
              runtime: params.runtime,
              context: buildRequestContext(subagentState),
              workdir: childWorkdir,
              sessionId: subagentSessionId,
              nativeWebSearch: params.runtime.nativeWebSearchEnabled !== false,
              tools: childTools,
              subagentScheduler,
              executeToolCall: (childToolCall, childSignal) => {
                if (!childToolNames.has(childToolCall.name)) {
                  const rejected: ToolResultMessage = {
                    role: "toolResult",
                    toolCallId: childToolCall.id,
                    toolName: childToolCall.name,
                    content: [
                      {
                        type: "text",
                        text: `Tool ${childToolCall.name} is not available to delegated subagents in mode=${task.mode}.`,
                      },
                    ],
                    details: {},
                    isError: true,
                    timestamp: Date.now(),
                  };
                  recordEvent({
                    eventType: "tool_rejected",
                    toolCallId: childToolCall.id,
                    toolName: childToolCall.name,
                    isError: true,
                    payload: { toolCall: childToolCall, result: rejected },
                  });
                  return Promise.resolve(rejected);
                }
                return childExecuteToolCall(childToolCall, childSignal);
              },
              onTurnStart: (round) => {
                rounds = Math.max(rounds, round);
                recordEvent({
                  eventType: "turn_start",
                  roundIndex: round,
                });
              },
              onTextDelta(delta, round) {
                recordTextDelta(delta, round);
              },
              onThinkingDelta(delta, round) {
                recordThinkingDelta(delta, round);
              },
              onToolCall: (childToolCall, round) => {
                recordEvent({
                  eventType: "tool_call",
                  roundIndex: round,
                  toolCallId: childToolCall.id,
                  toolName: childToolCall.name,
                  payload: { toolCall: childToolCall },
                });
              },
              onToolExecutionStart: (childToolCall, round) => {
                toolCalls += 1;
                recordEvent({
                  eventType: "tool_execution_start",
                  roundIndex: round,
                  toolCallId: childToolCall.id,
                  toolName: childToolCall.name,
                  payload: { toolCall: childToolCall },
                });
              },
              onToolResult: (childToolCall, toolResult, round) => {
                recordEvent({
                  eventType: "tool_result",
                  roundIndex: round,
                  toolCallId: childToolCall.id,
                  toolName: childToolCall.name,
                  isError:
                    toolResult.role === "toolResult"
                      ? Boolean(toolResult.isError)
                      : false,
                  payload: { toolCall: childToolCall, toolResult },
                });
              },
              onAssistantMessage: (assistant, round) => {
                flushTextDeltaBuffer(round);
                flushThinkingDeltaBuffer(round);
                recordEvent({
                  eventType: "assistant_message",
                  roundIndex: round,
                  payload: { assistant },
                });
              },
              onBeforeNextTurn: async ({ emittedMessages, signal: childSignal }) => {
                flushTextDeltaBuffer();
                flushThinkingDeltaBuffer();
                noteCompactionRound(compactionThrottleState);
                const tempState = appendMessagesToConversation(
                  subagentState,
                  emittedMessages,
                );
                const requestContext = buildRequestContext(tempState);
                const busSnapshot = await renderMessageBusSnapshot({
                  id: task.id,
                  name: displayName,
                });
                const busUpdateMessage = buildSubagentMessageBusUpdateMessage(busSnapshot);
                const appendBusUpdate = (context: ReturnType<typeof buildRequestContext>) =>
                  busUpdateMessage
                    ? {
                        ...context,
                        messages: [...context.messages, busUpdateMessage],
                      }
                    : context;
                const emittedWithBusUpdate = busUpdateMessage
                  ? [...emittedMessages, busUpdateMessage]
                  : emittedMessages;
                recordEvent({
                  eventType: "compaction_check",
                  payload: {
                    roundCount: rounds,
                    messageCount: tempState.meta.totalMessageCount,
                  },
                });
                let compacted: Awaited<ReturnType<typeof runMidTurnCompaction>>;
                try {
                  compacted = await runMidTurnCompaction({
                    state: tempState,
                    requestContext,
                    budgetContext: requestContext,
                    providerId: params.providerId,
                    model: params.model,
                    runtime: params.runtime,
                    signal: childSignal ?? signal,
                    throttleState: compactionThrottleState,
                  });
                } catch (compactionErr) {
                  recordEvent({
                    eventType: "compaction_failed",
                    isError: true,
                    payload: {
                      error: normalizeErrorMessage(
                        compactionErr instanceof Error
                          ? compactionErr.message
                          : String(compactionErr),
                        "Subagent compaction failed",
                      ),
                    },
                  });
                  return null;
                }

                if (!compacted.applied) {
                  recordEvent({
                    eventType: "compaction_skipped",
                    payload: { decision: compacted.decision },
                  });
                  return busUpdateMessage
                    ? {
                        context: appendBusUpdate(requestContext),
                        emittedMessages: emittedWithBusUpdate,
                      }
                    : null;
                }

                compactions += 1;
                noteCompactionApplied(compactionThrottleState);
                subagentState = compacted.state;
                recordEvent({
                  eventType: "compaction_completed",
                  payload: {
                    decision: compacted.decision,
                    activeSegmentIndex: compacted.state.activeSegmentIndex,
                    totalSegmentCount: compacted.state.meta.totalSegmentCount,
                  },
                });
                await persistRunState("running");
                const nextContext = buildRequestContext(compacted.state);
                const resumedContext = compacted.resumeMessage
                  ? {
                      ...nextContext,
                      messages: [...nextContext.messages, compacted.resumeMessage],
                    }
                  : nextContext;
                return {
                  context: appendBusUpdate(resumedContext),
                  emittedMessages: busUpdateMessage ? [busUpdateMessage] : [],
                };
              },
              onToolStatus(status) {
                recordEvent({
                  eventType: "tool_status",
                  payload: { status },
                });
              },
              signal,
            });

            subagentState = appendMessagesToConversation(
              subagentState,
              result.emittedMessages,
            );

            if (worktree) {
              try {
                worktreeStatus = await getWorktreeStatus({
                  worktreeRoot: worktree.worktree_root,
                  maxDiffChars: MAX_DIFF_CHARS,
                });
                recordEvent({
                  eventType: "worktree_status",
                  payload: worktreeStatus,
                });
              } catch (statusErr) {
                worktreeStatusError = normalizeErrorMessage(
                  statusErr instanceof Error ? statusErr.message : String(statusErr),
                  "Failed to inspect delegated worktree status",
                );
                recordEvent({
                  eventType: "worktree_status_failed",
                  isError: true,
                  payload: { error: worktreeStatusError },
                });
              }
            }

            const applyDecision =
              worktree && worktreeStatus
                ? decideWorktreeApply({ task, status: worktreeStatus })
                : undefined;
            if (applyDecision) {
              changedPaths = applyDecision.changedPaths;
              candidateArtifacts = applyDecision.candidateArtifacts;
            }

            if (worktree && worktreeStatus?.changed && applyDecision?.shouldApply) {
              try {
                const applyResult = await enqueueApplyWorktreeChanges(() =>
                  applyWorktreeChanges({
                    parentWorkdir: params.workdir,
                    worktreeRoot: worktree!.worktree_root,
                  }),
                );
                applyStatus = applyResult.applied ? "applied" : "skipped";
                applyMethod = applyResult.apply_method;
                applyChanged = applyResult.changed;
                applyPatchBytes = applyResult.patch_bytes;
                applySkippedReason = applyResult.skipped_reason;
                applyFallbackReason = applyResult.fallback_reason;
                applyCopiedFiles = applyResult.copied_files;
                applyDeletedFiles = applyResult.deleted_files;
                applyConflictFiles = applyResult.conflict_files;
                appliedToWorkdir = params.workdir;
                recordEvent({
                  eventType: "worktree_apply",
                  payload: applyResult,
                });
              } catch (applyErr) {
                applyStatus = "failed";
                applyError = normalizeErrorMessage(
                  applyErr instanceof Error ? applyErr.message : String(applyErr),
                  "Failed to apply delegated worktree changes",
                );
                recordEvent({
                  eventType: "worktree_apply_failed",
                  isError: true,
                  payload: { error: applyError },
                });
              }
            } else if (worktree) {
              applyStatus = "skipped";
              applyChanged = false;
              applyPatchBytes = 0;
              applySkippedReason = worktreeStatusError
                ? "status_unavailable"
                : applyDecision?.skippedReason ?? "no_changes";
              recordEvent({
                eventType: "worktree_apply_skipped",
                payload: {
                  reason: applySkippedReason,
                  applyPolicy: task.applyPolicy,
                  taskIntent: task.taskIntent,
                  changedPaths,
                  candidateArtifacts,
                },
              });
            }

            if (worktree) {
              const cleanupDecision = decideWorktreeCleanup({
                task,
                status: worktreeStatus,
                statusError: worktreeStatusError,
                applyStatus,
                applySkippedReason,
              });
              worktreeCleanupReason = cleanupDecision.reason;
              if (cleanupDecision.shouldCleanup) {
                try {
                  const cleanupResult = await cleanupWorktree({
                    worktreeRoot: worktree.worktree_root,
                    branchName: worktree.branch_name,
                  });
                  worktreeBranchDeleted = cleanupResult.branchDeleted;
                  if (cleanupResult.error) {
                    worktreeCleanupStatus = "failed";
                    worktreeCleanupError = cleanupResult.error;
                    recordEvent({
                      eventType: "worktree_cleanup_failed",
                      isError: true,
                      payload: cleanupResult,
                    });
                  } else if (cleanupResult.removed) {
                    worktreeCleanupStatus = "removed";
                    recordEvent({
                      eventType: "worktree_cleanup_removed",
                      payload: cleanupResult,
                    });
                  } else {
                    worktreeCleanupStatus = "skipped";
                    worktreeCleanupReason =
                      cleanupResult.skippedReason ?? worktreeCleanupReason;
                    recordEvent({
                      eventType: "worktree_cleanup_skipped",
                      payload: cleanupResult,
                    });
                  }
                } catch (cleanupErr) {
                  worktreeCleanupStatus = "failed";
                  worktreeCleanupError = normalizeErrorMessage(
                    cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                    "Failed to cleanup delegated worktree",
                  );
                  recordEvent({
                    eventType: "worktree_cleanup_failed",
                    isError: true,
                    payload: { error: worktreeCleanupError },
                  });
                }
              } else {
                worktreeCleanupStatus = "retained";
                recordEvent({
                  eventType: "worktree_cleanup_retained",
                  payload: { reason: worktreeCleanupReason },
                });
              }
            }

            const summary = truncateText(assistantMessageToText(result.assistant).trim());
            flushTextDeltaBuffer();
            flushThinkingDeltaBuffer();
            recordEvent({
              eventType: "run_completed",
              payload: { summary, assistant: result.assistant },
            });
            await persistRunState("completed", {
              summary: summary || "(subagent returned an empty report)",
              endedAt: Date.now(),
            });
            await flushHistory();
            const completedAt = Date.now();
            const completedAgent = rememberResult({
              id: task.id,
              runId,
              name: displayName,
              role: identity.role,
              prompt: task.prompt,
              agentId: task.agentId,
              agentName: template?.name,
              mode: task.mode,
              taskIntent: task.taskIntent,
              applyPolicy: task.applyPolicy,
              allowedOutputPaths: task.allowedOutputPaths,
              status: "completed",
              summary: summary || "(subagent returned an empty report)",
              durationMs: Date.now() - taskStartedAt,
              rounds,
              toolCalls,
              worktreeRoot: worktree?.worktree_root,
              workdir: worktree?.workdir,
              branchName: worktree?.branch_name,
              changed: worktreeStatus?.changed,
              statusText: worktreeStatus?.status,
              diffStat: worktreeStatus?.diff_stat,
              diff: worktreeStatus?.diff,
              diffTruncated: worktreeStatus?.diff_truncated,
              untrackedFiles: worktreeStatus?.untracked_files,
              worktreeStatusError,
              applyStatus,
              applyMethod,
              applyChanged,
              applyPatchBytes,
              applySkippedReason,
              applyFallbackReason,
              applyCopiedFiles,
              applyDeletedFiles,
              applyConflictFiles,
              applyError,
              appliedToWorkdir,
              worktreeCleanupStatus,
              worktreeCleanupReason,
              worktreeCleanupError,
              worktreeBranchDeleted,
              candidateArtifacts,
              changedPaths,
            }, completedAt);
            return finishAgent(completedAgent);
          } catch (err) {
            if (worktree) {
              try {
                worktreeStatus = await getWorktreeStatus({
                  worktreeRoot: worktree.worktree_root,
                  maxDiffChars: MAX_DIFF_CHARS,
                });
                recordEvent({
                  eventType: "worktree_status",
                  payload: worktreeStatus,
                });
              } catch (statusErr) {
                worktreeStatusError = normalizeErrorMessage(
                  statusErr instanceof Error ? statusErr.message : String(statusErr),
                  "Failed to inspect delegated worktree status",
                );
                recordEvent({
                  eventType: "worktree_status_failed",
                  isError: true,
                  payload: { error: worktreeStatusError },
                });
              }
            }
            const message = normalizeErrorMessage(
              err instanceof Error ? err.message : String(err),
              "Delegated subagent failed",
            );
            flushTextDeltaBuffer();
            flushThinkingDeltaBuffer();
            recordEvent({
              eventType: "run_failed",
              isError: true,
              payload: { error: message },
            });
            await persistRunState("failed", {
              error: message,
              endedAt: Date.now(),
            });
            await flushHistory();
            const failedAt = Date.now();
            const failedAgent = rememberResult({
              id: task.id,
              runId,
              name: displayName,
              role: identity.role,
              prompt: task.prompt,
              agentId: task.agentId,
              agentName: template?.name,
              mode: task.mode,
              taskIntent: task.taskIntent,
              applyPolicy: task.applyPolicy,
              allowedOutputPaths: task.allowedOutputPaths,
              status: "failed",
              summary: "",
              durationMs: Date.now() - taskStartedAt,
              rounds,
              toolCalls,
              error: message,
              worktreeRoot: worktree?.worktree_root,
              workdir: worktree?.workdir,
              branchName: worktree?.branch_name,
              changed: worktreeStatus?.changed,
              statusText: worktreeStatus?.status,
              diffStat: worktreeStatus?.diff_stat,
              diff: worktreeStatus?.diff,
              diffTruncated: worktreeStatus?.diff_truncated,
              untrackedFiles: worktreeStatus?.untracked_files,
              worktreeStatusError,
              applyStatus: worktree ? "skipped" : undefined,
              applyChanged: worktree ? false : undefined,
              applyPatchBytes: worktree ? 0 : undefined,
              applySkippedReason: worktree ? "agent_failed" : undefined,
              worktreeCleanupStatus: worktree ? "retained" : undefined,
              worktreeCleanupReason: worktree ? "agent_failed" : undefined,
              candidateArtifacts,
              changedPaths,
            }, failedAt);
            return finishAgent(failedAgent);
          }
        });
      },
    );

    const details: DelegateAgentResultDetails = {
      kind: "delegate_agent",
      agentCount: taskResults.length,
      concurrency,
      totalDurationMs: Date.now() - startedAt,
      readOnly: taskResults.every((task) => task.mode === "readonly"),
      mode: taskResults.every((task) => task.mode === "readonly")
        ? "readonly"
        : taskResults.every((task) => task.mode === "worktree")
          ? "worktree"
          : "mixed",
      agents: taskResults,
    };
    const text = [
      canonicalizationNotes.length > 0
        ? `Agent roster canonicalization:\n${canonicalizationNotes.join("\n")}\n`
        : "",
      buildDelegateResultText(details),
    ]
      .filter(Boolean)
      .join("\n");

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text }],
      details,
      isError: taskResults.some((task) => task.status === "failed"),
      timestamp: now,
    };
  }

  return {
    groupId: "delegate",
    tools: [toolAgent],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        DELEGATE_TOOL_NAME,
        {
          groupId: "delegate",
          kind: "delegate_agent",
          isReadOnly: false,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
