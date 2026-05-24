import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

import {
  buildProviderRequestMetadata,
  createModelFromConfig,
  finalizeProviderStreamOptions,
  normalizeErrorMessage,
  resolveProviderCacheRetention,
  toSimpleStreamReasoning,
  streamSimpleByApi,
  buildProviderAuthHeaders,
  createStreamingTextReconciler,
  type StreamOptionsEx,
} from "../../providers/llm";
import {
  createHostedSearchProbeId,
  createHostedSearchEventAggregator,
  startHostedSearchFetchProbe,
  withHostedSearchProbeHeader,
} from "../../providers/hostedSearchEvents";
import {
  appendHostedSearchBlocksToAssistant,
  mergeHostedSearchBlocks,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
} from "../messages/hostedSearch";
import {
  createDeferredProviderNativeWebSearchStatus,
  resolveProviderNativeWebSearchStatus,
} from "../search/providerNativeSearchStatus";
import {
  buildStreamRequestDebugPayload,
  type StreamDebugLogger,
} from "../../debug/agentDebug";
import type {
  CodexRequestFormat,
  ProviderId,
  ProviderModelConfig,
  ReasoningLevel,
} from "../../settings";
import { withPowerActivity } from "../../system/powerActivity";

import { prepareProxyRequest } from "../../providers/proxy";
import { summarizeToolCall } from "../messages/uiMessages";
import { recoverAssistantSeedToolCalls } from "./seedToolCalls";
import { sanitizeContextForModelRequest } from "../context/requestContextSanitizer";
import { buildMemoryToolsSuffixSection } from "../memory/memoryPolicy";
import {
  createSubagentScheduler,
  type SubagentScheduler,
} from "../subagent/subagentScheduler";

function createLinkedAbortSignal(
  signals: Array<AbortSignal | undefined>,
): { signal?: AbortSignal; cleanup: () => void } {
  const activeSignals = Array.from(
    new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal))),
  );
  if (activeSignals.length <= 1) {
    return { signal: activeSignals[0], cleanup: () => undefined };
  }

  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  const cleanup = () => {
    while (cleanupFns.length > 0) {
      cleanupFns.pop()?.();
    }
  };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    cleanup();
  };

  for (const sourceSignal of activeSignals) {
    if (sourceSignal.aborted) {
      abort();
      break;
    }
    sourceSignal.addEventListener("abort", abort, { once: true });
    cleanupFns.push(() => sourceSignal.removeEventListener("abort", abort));
  }

  return { signal: controller.signal, cleanup };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency || 1));
  const results: R[] = new Array(n);
  let nextIndex = 0;

  async function runLoop() {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= n) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = new Array(Math.min(limit, n)).fill(0).map(() => runLoop());
  await Promise.all(runners);
  return results;
}

export function buildToolsSuffix(workdir: string, availableToolNames?: readonly string[]) {
  const allowAll = availableToolNames === undefined;
  const toolNames = new Set(availableToolNames ?? []);
  const has = (name: string) => allowAll || toolNames.has(name);
  const hasAny = (...names: string[]) => names.some(has);
  const hasDynamicMcp =
    allowAll || (availableToolNames ?? []).some((name) => name.startsWith("mcp_"));

  const fileTools = ["Read", "Image", "Write", "Edit", "Delete", "List", "Grep", "Glob"].filter(
    has,
  );
  const hasFileTool = fileTools.length > 0;
  const hasReadFamily = hasAny("Read", "List", "Grep", "Glob");
  const canWrite = hasAny("Write", "Edit", "Delete");

  const toolGroups: string[] = [];
  if (fileTools.length > 0) toolGroups.push(`file tools (${fileTools.join(" / ")})`);
  if (has("SkillsManager")) toolGroups.push("skill tools (SkillsManager)");
  if (has("MemoryManager")) toolGroups.push("persistent memory (MemoryManager)");
  if (has("McpManager")) toolGroups.push("MCP configuration management (McpManager)");
  if (has("CronTaskManager")) toolGroups.push("scheduled task management (CronTaskManager)");
  if (has("Agent")) toolGroups.push("subagent delegation (Agent)");
  if (has("SendMessage")) toolGroups.push("subagent message bus (SendMessage)");
  if (has("Bash")) toolGroups.push("the command tool (Bash)");
  if (has("ManagedProcess")) toolGroups.push("managed local processes (ManagedProcess)");
  if (hasDynamicMcp) toolGroups.push("MCP business tools whose names are prefixed with mcp_");

  const sections: string[] = [];

  sections.push(
    [
      "# Tool-Execution Mode",
      "",
      "In this mode you have access to the tools listed under **Available Tools** at the end of this section. Invoke them when the task requires reading, searching, modifying, or coordinating state (files, commands, agents, MCP services). For pure Q&A, explanation, or analysis that does not depend on current state, answer directly without invoking tools.",
      "",
      "## Final Reply",
      "- Your reply to the user is plain text plus Markdown.",
      "- Never include raw tool-call JSON or raw tool arguments in your reply — describe what you did in plain words instead.",
    ].join("\n"),
  );

  if (hasFileTool || has("Bash")) {
    const subject =
      hasFileTool && has("Bash") ? "File tools and Bash" : hasFileTool ? "File tools" : "Bash";
    const subjectVerb = subject === "Bash" ? "takes" : "take";
    const skillsRootAllowed = has("SkillsManager") || hasFileTool;
    sections.push(
      [
        "## Workspace & Paths",
        `- Workspace root (sandbox): \`${workdir}\``,
        `- ${subject} ${subjectVerb} an optional \`root\` argument that selects the sandbox the rest of the call resolves under:`,
        "  • Omit `root` → workspace root above.",
        skillsRootAllowed
          ? '  • `root="skills"` → fixed Skills root. Authorized ONLY for Skills enabled in this conversation; do not access files from other installed Skills through any tool.'
          : null,
        "- `path` / `cwd` values must be relative. NEVER use an absolute path, `..` segments, `.`, `./`, or `.\\`. To target the root itself, simply omit the argument.",
        "- Use `/` as the separator everywhere, including Glob and Grep patterns. Windows `\\` is auto-normalized.",
        "- Absolute paths printed in Skill docs, examples, logs, or earlier messages are illustrations only. Do NOT pass them as `path` / `cwd` values — translate them into `(root, relative-path)` first.",
        "- absolute workspace or Skills paths shown in Skill docs, examples, logs, or earlier messages are illustrations only. Convert them to scoped file-tool calls.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  if (hasFileTool) {
    const lines: string[] = ["## File Operations"];
    if (hasReadFamily) {
      lines.push(
        "- When the target path is already known, go straight to Read. When it is not, locate it first with Grep / Glob / List, then Read.",
      );
    }
    if (canWrite) {
      lines.push(
        "- Read a file at least once before Write or Edit. If the file changes after that Read, the next Write/Edit is rejected — Read it again, then retry.",
      );
    }
    if (has("Read")) {
      lines.push(
        [
          "- Read pagination:",
          "  • Text — `start_line` (1-based) + `limit`.",
          "  • PDF — `page_start` + `page_limit`.",
          "  • Notebook (`.ipynb`) — `cell_start` + `cell_limit`.",
          "  • Word/Excel/archive uploads — Read returns a best-effort preview or archive entry listing.",
          "- A re-Read of an unchanged file may return an `unchanged` stub instead of repeating content — treat it as confirmation that your prior read is still valid; do not retry to force the full body.",
        ].join("\n"),
      );
    }
    if (has("Write")) {
      lines.push(
        "- Write creates a new file or fully overwrites an existing one. There is no append mode — to add content, Read first, then either Write the full new content or use Edit to insert.",
      );
    }
    if (has("Edit")) {
      lines.push(
        "- Edit performs exact-string replacement. If `old_string` matches multiple places, either narrow it until it is unique or pass `replace_all=true` explicitly.",
      );
    }
    if (has("Delete")) {
      lines.push("- For workspace or Skills deletion, use Delete with the correct root/path.");
    }
    if (hasAny("Grep", "Glob", "List")) {
      lines.push(
        "- For search, use `Grep.output_mode=content|files|count` with `head_limit`, `offset`, and `context` instead of dumping raw matches.",
      );
    }
    if (has("SkillsManager") && hasReadFamily) {
      lines.push(
        '- For files inside a Skill, call file tools with `root="skills"` and a path like `<baseDir>/references/guide.md`. Never expand the Skills root into an absolute path.',
      );
    }
    if (has("Bash")) {
      const alts: string[] = [];
      if (hasReadFamily) alts.push("read / list / search via `cat`, `ls`, `find`, `grep`, or `rg`");
      if (has("Delete")) alts.push("delete via `rm`, `rmdir`, `unlink`, or `find -delete`");
      if (alts.length > 0) {
        lines.push(
          `- Do NOT use Bash to ${alts.join(" or ")} workspace or Skill files — use the corresponding file tool above.`,
        );
      }
      if (hasReadFamily) {
        lines.push("- Do not run Bash cat/ls/find/grep to read, list, or search workspace or Skill files.");
      }
      if (has("Delete")) {
        lines.push("- Do not run Bash rm, rmdir, unlink, or find -delete for workspace or Skill files.");
      }
    }
    sections.push(lines.join("\n"));
  }

  if (has("Image")) {
    sections.push(
      [
        "## Showing Images",
        "- To display any image in the chat UI, call the Image tool.",
        "- Do not embed images with Markdown syntax like ![alt](path), HTML <img>, file:// URLs, or local relative image paths in your final text.",
        has("SkillsManager")
          ? [
              '- Local image: pass `path` (+ matching `root`). Skill image: `root="skills"` + relative path; do not use Bash, `open`, `xdg-open`, or absolute Skills paths. Remote image: pass `url` / `urls` or `source` / `sources` directly — do not download unless the user asked to save it locally.',
              '- For image files inside installed Skills, call Image with root="skills" and a path relative to the fixed Skills root.',
              "- Do not use Bash, open, xdg-open, Markdown, HTML, or absolute Skills paths to display Skill images.",
            ].join("\n")
          : "- Local image: pass `path` (+ matching `root`). Remote image: pass `url` / `urls` or `source` / `sources` directly — do not download unless the user asked to save it locally.",
        "- For remote images, call Image with url/urls or source/sources directly instead of downloading them, unless the user explicitly asks to save the file locally.",
        "- Whenever an image path or URL appears in the conversation (from the user, a tool result, or earlier context) and the user should see it, call Image with that path/URL before producing the final reply.",
        "- If another tool saves, downloads, screenshots, generates, or returns an image file path or image URL and the user should see it, call Image with that path or URL before the final response.",
        "- Your final text may caption or describe images already shown via Image; it must not try to render them itself.",
        "- Final text may describe or caption images already displayed by Image, but must not attempt to render images directly.",
      ].join("\n"),
    );
  }

  if (has("Bash")) {
    sections.push(
      [
        "## Bash",
        "- Bash.cwd is relative to the selected Bash root.",
        '- `Bash.cwd` follows the `root` rules in **Workspace & Paths**. The canonical form for running a Skill script is `root="skills"` with `cwd="<skill-name>/scripts"` plus a relative command.',
        '- To run installed Skill scripts, use root="skills" with cwd="<skill-name>/scripts".',
        '- The alternative form — passing an absolute path inside the command (e.g. `python ~/.liveagent/skills/<skill-name>/scripts/foo.py`) — is also accepted as long as the referenced Skill is enabled in this conversation. Both forms run the same script; prefer the canonical form for clarity, but you do not need to retry just to switch forms.',
        "- For endpoint tests with curl, include an explicit timeout such as `--max-time 30` so a stalled local server or upstream request cannot hold the whole turn indefinitely.",
        "- Background commands using `&` must redirect stdout and stderr to a log file before detaching, for example `nohup command > /tmp/liveagent-task.log 2>&1 < /dev/null &`; otherwise use a dedicated terminal or managed process workflow for dev servers/watchers.",
        "- For reading, listing, or searching Skill content, always use Read/List/Glob/Grep with `root=\"skills\"` — Bash `cat`/`ls`/`find`/`grep`/`rg`/`sed`/`awk` against `~/.liveagent/skills` is still routed back to the file tools.",
        "- Do not guess `skills/` paths inside the workspace; if a Skill is needed, enable it in the chat Skills selector first.",
        "- Do not cd into ~/.liveagent/skills or workspace skills/ guesses.",
      ].join("\n"),
    );
  }

  if (has("Agent")) {
    sections.push(
      [
        "## Agent Delegation",
        "- Use Agent for bounded, independent jobs that benefit from a fresh context: implementation, research, review, discussion, or verification. Do not delegate trivial work you can finish yourself.",
        "- To run multiple independent jobs in parallel, issue ONE Agent call whose `agent_spec` lists every job. Use sequential Agent calls only when a later job needs an earlier job's output.",
        "- For parallel delegation, use one Agent tool call with agent_spec so the agents run in parallel; do not make separate sequential Agent calls unless later agents depend on earlier results.",
        '- For multi-agent discussion or role replies, set `task_intent="communication"` so subagents respond via their final reports rather than workspace files.',
        "- Enable `worktree` / auto-apply only when the subagent is expected to produce file changes or the user explicitly asked for file output.",
        "- To continue with an existing delegated agent or a previously formed team, call Agent again with the agent id(s) returned by the earlier Agent call — do not impersonate those agents from this transcript.",
      ].join("\n"),
    );
  }

  if (has("SendMessage")) {
    sections.push(
      [
        "## Subagent Message Bus",
        "- Use SendMessage to send concise Markdown messages to the parent agent, all agents, or a stable delegated-agent id.",
        "- Messages sent to parent are private to the parent; send to=* when peer agents need to read a report or summary.",
        "- Message delivery is deferred to the next model turn boundary; do not use workspace files as a mailbox.",
      ].join("\n"),
    );
  }

  if (has("ManagedProcess")) {
    sections.push(
      [
        "## ManagedProcess",
        '- Use ManagedProcess(action="start") for dev servers, preview servers, watchers, or other long-running foreground commands that should continue while you run tests.',
        '- Do not append `&` to ManagedProcess.command. It starts the process in the background, redirects stdout/stderr to a log file, and returns process_id/pid/log_path.',
        '- Use ManagedProcess(action="status") to inspect running processes, action="read_log" to inspect recent output, and action="stop" to terminate the process tree.',
        "- Prefer ManagedProcess over Bash for `pnpm dev`, `deno run main.ts`, `vite`, file watchers, local web servers, or commands that otherwise require `nohup` and log redirection.",
      ].join("\n"),
    );
  }

  if (has("MemoryManager")) {
    sections.push(buildMemoryToolsSuffixSection());
  }

  if (has("McpManager") || hasDynamicMcp) {
    const lines: string[] = ["## MCP"];
    if (has("McpManager")) {
      lines.push(
        "- **McpManager** is configuration only: manage, validate, test, diagnose, restart, stop, or list MCP servers and their tool inventory. It does NOT execute MCP domain calls.",
      );
    }
    if (hasDynamicMcp) {
      lines.push(
        "- The dynamically loaded `mcp_*` tools are where actual MCP domain actions (database queries, API calls, integrations exposed by MCP servers) happen.",
      );
    }
    sections.push(lines.join("\n"));
  }

  sections.push(
    toolGroups.length > 0
      ? ["## Available Tools", ...toolGroups.map((group) => `- ${group}`)].join("\n")
      : "## Available Tools\n- none.",
  );

  return sections.join("\n\n");
}

function buildSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  if (!head) return suffix;
  return `${head}\n\n${suffix}`;
}

function toSyntheticToolCall(params: {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}): ToolCall {
  return {
    type: "toolCall",
    id: params.id,
    name: params.name,
    arguments: params.arguments ?? {},
  };
}

function toAssistantThinkingLevel(params: {
  providerId: ProviderId;
  reasoning?: ReasoningLevel;
  api: string;
}): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (params.providerId === "claude_code") {
    return params.reasoning && params.reasoning !== "off" ? params.reasoning : "off";
  }
  if (params.providerId === "gemini") {
    if (!params.reasoning || params.reasoning === "off") return "off";
    return params.reasoning === "xhigh" ? "high" : params.reasoning;
  }
  if (params.api !== "openai-responses") return "off";
  return params.reasoning && params.reasoning !== "off" ? params.reasoning : "off";
}

function normalizeStreamReasoning(value: unknown): StreamOptionsEx["reasoning"] | undefined {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
}

function getAssistantToolCalls(assistant: AssistantMessage): ToolCall[] {
  return assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function isProviderNativeWebSearchName(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  return (
    normalized === "web_search" ||
    normalized === "web_search_20250305" ||
    normalized === "web_search_20260209" ||
    normalized === "web_search_preview" ||
    normalized.startsWith("web_search_call")
  );
}

function readToolCallStringArgument(toolCall: ToolCall, name: string) {
  const args = toolCall.arguments;
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

function buildRecoveredProviderNativeWebSearchResult(params: {
  toolCall: ToolCall;
  roundHostedSearchBlocks: HostedSearchBlock[];
}): ToolResultMessage {
  const query =
    readToolCallStringArgument(params.toolCall, "query") ||
    readToolCallStringArgument(params.toolCall, "search_query");
  const sources = params.roundHostedSearchBlocks
    .flatMap((block) => block.sources)
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
    .slice(0, 10);
  const sourceLines = sources.map((source, index) => {
    const title = source.title?.trim() || source.url;
    return `${index + 1}. ${title} - ${source.url}`;
  });
  const text = [
    "Recovered a provider-native web search request that was emitted as DSML text instead of a structured provider tool call.",
    query ? `Requested query: ${query}` : "",
    sourceLines.length > 0
      ? ["Hosted search sources already captured in this round:", ...sourceLines].join("\n")
      : "No local web_search executor is available. Continue from existing context, or request provider-native web search through the model/tool protocol instead of printing DSML markup.",
    "Do not repeat the DSML markup in the final answer.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text }],
    details: {
      recoveredProviderNativeWebSearch: true,
      query,
      sourceCount: sources.length,
      sources,
    },
    isError: false,
    timestamp: Date.now(),
  };
}

function findConsecutiveToolGroup(
  assistant: AssistantMessage,
  toolCallId: string,
  toolName: string,
): ToolCall[] | null {
  const toolCalls = getAssistantToolCalls(assistant);
  const idx = toolCalls.findIndex((call) => call.id === toolCallId);
  if (idx < 0 || toolCalls[idx].name !== toolName) return null;

  let start = idx;
  while (start > 0 && toolCalls[start - 1].name === toolName) start -= 1;

  let end = idx;
  while (end + 1 < toolCalls.length && toolCalls[end + 1].name === toolName) end += 1;

  return toolCalls.slice(start, end + 1);
}

function buildParallelToolBatchKey(group: ToolCall[]) {
  return group.map((call) => call.id).join("|");
}

type ParallelToolBatch = {
  toolName: string;
  toolCalls: ToolCall[];
  started: boolean;
  announced: boolean;
  resultPromises: Map<string, Promise<ToolResultMessage>>;
};

function getParallelToolBatch(
  toolCallId: string,
  parallelBatchKeyByToolCallId: Map<string, string>,
  parallelToolBatches: Map<string, ParallelToolBatch>,
) {
  const batchKey = parallelBatchKeyByToolCallId.get(toolCallId);
  if (!batchKey) return null;
  return parallelToolBatches.get(batchKey) ?? null;
}

function getParallelToolBatchStatus(batch: ParallelToolBatch) {
  if (batch.toolName === "Bash") {
    return `正在并行执行 ${batch.toolCalls.length} 个 Bash 命令...`;
  }
  if (batch.toolName === "Agent") {
    return `正在并行执行 ${batch.toolCalls.length} 个 Agent 调用...`;
  }
  return `正在并行执行 ${batch.toolCalls.length} 个 ${batch.toolName} 调用...`;
}

function toMessageToolResult(
  message: Message,
  toolCall: ToolCall,
): ToolResultMessage {
  if (message.role === "toolResult") return message;
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: "Tool did not return a toolResult message" }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

type TurnContextOverride =
  | {
      context: Context;
      emittedMessages: Message[];
    }
  | null;

type ToolExecutionEventContext = {
  parentToolCall: ToolCall;
  subagentScheduler: SubagentScheduler;
  emitToolCall: (toolCall: ToolCall) => void;
  emitToolExecutionStart: (toolCall: ToolCall) => void;
  emitToolResult: (toolCall: ToolCall, toolResult: ToolResultMessage) => void;
  emitToolStatus: (status: string | null) => void;
};

function getAgentMessages(agent: Agent | null): Message[] {
  return agent ? (agent.state.messages as Message[]) : [];
}

function getMessagesSinceBaseline(agent: Agent | null, baselineIndex: number): Message[] {
  const messages = getAgentMessages(agent);
  if (baselineIndex <= 0) return messages.slice();
  if (baselineIndex >= messages.length) return [];
  return messages.slice(baselineIndex);
}

function findLastAssistantMessage(messages: Message[]): AssistantMessage | null {
  return (
    [...messages].reverse().find(
      (message): message is AssistantMessage => message.role === "assistant",
    ) ?? null
  );
}

export async function runAssistantWithTools(params: {
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
  context: Context;
  workdir: string;
  sessionId?: string;
  nativeWebSearch?: boolean;
  tools: Context["tools"];
  executeToolCall: (
    toolCall: ToolCall,
    signal?: AbortSignal,
    context?: ToolExecutionEventContext,
  ) => Promise<Message>;
  onTurnStart?: (round: number) => void;
  onTextDelta: (delta: string, round: number) => void;
  onThinkingDelta?: (delta: string, round: number) => void;
  onToolCall?: (toolCall: ToolCall, round: number) => void;
  onHostedSearch?: (hostedSearch: HostedSearchBlock, round: number) => void;
  onToolExecutionStart?: (toolCall: ToolCall, round: number) => void;
  onToolResult?: (toolCall: ToolCall, toolResult: Message, round: number) => void;
  onAssistantMessage?: (assistant: Message, round: number) => void;
  onBeforeNextTurn?: (params: {
    round: number;
    assistant: AssistantMessage;
    toolResults: ToolResultMessage[];
    runtimeContext: Context;
    emittedMessages: Message[];
    signal?: AbortSignal;
  }) => Promise<
    | {
        context: Context;
        emittedMessages: Message[];
      }
    | null
  >;
  onToolStatus?: (status: string | null) => void;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  subagentScheduler?: SubagentScheduler;
  allowEmptyWorkdir?: boolean;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");
  if (!params.workdir.trim() && !params.allowEmptyWorkdir) {
    throw new Error("A working directory must be configured for tool mode");
  }
  if (params.signal?.aborted) throw new Error("Cancelled");

  const subagentScheduler = params.subagentScheduler ?? createSubagentScheduler();

  return withPowerActivity("assistant-tools", `${params.providerId}:${modelId}`, async () => {
    const proxyRequest = await prepareProxyRequest(
      params.providerId,
      params.runtime.baseUrl.trim(),
      buildProviderAuthHeaders(params.providerId, params.runtime.apiKey),
    );

    const model = createModelFromConfig(
      params.providerId,
      modelId,
      proxyRequest.baseUrl,
      params.runtime.requestFormat,
      params.runtime.modelConfig,
    );
    const nativeWebSearchStatus = resolveProviderNativeWebSearchStatus({
      providerId: params.providerId,
      api: model.api,
      enabled: params.nativeWebSearch,
    });
    const nativeWebSearchStatusController = createDeferredProviderNativeWebSearchStatus({
      status: nativeWebSearchStatus,
      onStatus: (status) => params.onToolStatus?.(status),
    });

    const thinkingLevel = toAssistantThinkingLevel({
      providerId: params.providerId,
      reasoning: params.runtime.reasoning,
      api: model.api,
    });

    const toolResultErrorFlags = new Map<string, boolean>();
    const toolCallsById = new Map<string, ToolCall>();
    const parallelBatchKeyByToolCallId = new Map<string, string>();
    const parallelToolBatches = new Map<string, ParallelToolBatch>();
    let currentRound = 0;

    const executeSingleToolCall = async (
      toolCall: ToolCall,
      signal?: AbortSignal,
    ): Promise<{ content: ToolResultMessage["content"]; details: unknown }> => {
      let toolResult: ToolResultMessage;
      const linkedSignal = createLinkedAbortSignal([signal, params.signal]);
      try {
        const hasLocalTool = (params.tools ?? []).some((tool) => tool.name === toolCall.name);
        if (
          nativeWebSearchStatus &&
          !hasLocalTool &&
          isProviderNativeWebSearchName(toolCall.name)
        ) {
          toolResult = buildRecoveredProviderNativeWebSearchResult({
            toolCall,
            roundHostedSearchBlocks: hostedSearchBlocksByRound.get(currentRound) ?? [],
          });
        } else {
          const execute = () =>
            params.executeToolCall(toolCall, linkedSignal.signal, {
              parentToolCall: toolCall,
              subagentScheduler,
              emitToolCall: (emittedToolCall) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                params.onToolCall?.(emittedToolCall, currentRound);
              },
              emitToolExecutionStart: (emittedToolCall) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                params.onToolExecutionStart?.(emittedToolCall, currentRound);
              },
              emitToolResult: (emittedToolCall, emittedToolResult) => {
                toolCallsById.set(emittedToolCall.id, emittedToolCall);
                toolResultErrorFlags.set(
                  emittedToolCall.id,
                  Boolean(emittedToolResult.isError),
                );
                params.onToolResult?.(emittedToolCall, emittedToolResult, currentRound);
              },
              emitToolStatus: (status) => params.onToolStatus?.(status),
            });
          toolResult = toMessageToolResult(
            await (toolCall.name === "Bash"
              ? subagentScheduler.runBash(execute, linkedSignal.signal)
              : execute()),
            toolCall,
          );
        }
      } catch (error) {
        toolResult = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            {
              type: "text",
              text: normalizeErrorMessage(
                error instanceof Error ? error.message : String(error),
                "Tool execution failed",
              ),
            },
          ],
          details: {},
          isError: true,
          timestamp: Date.now(),
        };
      } finally {
        linkedSignal.cleanup();
      }

      toolResultErrorFlags.set(toolCall.id, Boolean(toolResult.isError));
      return {
        content: toolResult.content,
        details: toolResult.details ?? {},
      };
    };

    const startParallelToolBatchIfNeeded = (
      batchKey: string,
      signal?: AbortSignal,
    ) => {
      const batch = parallelToolBatches.get(batchKey);
      if (!batch || batch.started) return batch;

      batch.started = true;
      if (batch.toolCalls.length > 1 && !batch.announced) {
        batch.announced = true;
        params.onToolStatus?.(getParallelToolBatchStatus(batch));
      }

      const allResultsPromise = runWithConcurrency(
        batch.toolCalls,
        subagentScheduler.getParallelToolLimit(batch.toolName),
        async (call) => {
          const result = await executeSingleToolCall(call, signal);
          return {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            details: result.details,
            isError: toolResultErrorFlags.get(call.id) ?? false,
            timestamp: Date.now(),
          } satisfies ToolResultMessage;
        },
      );

      batch.resultPromises = new Map(
        batch.toolCalls.map((call, index) => [
          call.id,
          allResultsPromise.then((results) => results[index]),
        ]),
      );

      return batch;
    };

    const llmTools = params.tools ?? [];
    const toolsSuffix = buildToolsSuffix(
      params.workdir,
      llmTools.map((tool) => tool.name),
    );
    let currentSystemPrompt = params.context.systemPrompt;
    let pendingTurnOverridePromise: Promise<TurnContextOverride> | null = null;
    let emittedBaselineIndex = params.context.messages.length;
    let latestAgentEndMessages: Message[] = [];
    let agentTools: AgentTool<any>[] = [];
    const pendingRecoveredSeedTurnRef: {
      current:
        | {
            round: number;
            assistant: AssistantMessage;
            toolCalls: ToolCall[];
          }
        | null;
    } = {
      current: null,
    };
    let agent: Agent | null = null;
    const hostedSearchBlocksByRound = new Map<number, HostedSearchBlock[]>();
    const hostedSearchOrderedBlocksByRound = new Map<number, HostedSearchOrderedBlock[]>();
    const hostedSearchProbeByRound = new Map<
      number,
      {
        finishProbe: () => void;
        completeAggregator: () => HostedSearchBlock[];
        failAggregator: () => HostedSearchBlock[];
        disposeAggregator: () => HostedSearchBlock[];
      }
    >();

    function upsertHostedSearchBlockForRound(round: number, hostedSearch: HostedSearchBlock) {
      const blocks = hostedSearchBlocksByRound.get(round) ?? [];
      const idx = blocks.findIndex((block) => block.id === hostedSearch.id);
      const next = blocks.slice();
      if (idx >= 0) {
        next[idx] = mergeHostedSearchBlocks(next[idx], hostedSearch);
      } else {
        next.push(hostedSearch);
      }
      hostedSearchBlocksByRound.set(round, next);
    }

    function getHostedSearchOrderedBlocksForRound(round: number) {
      const blocks = hostedSearchOrderedBlocksByRound.get(round) ?? [];
      if (!hostedSearchOrderedBlocksByRound.has(round)) {
        hostedSearchOrderedBlocksByRound.set(round, blocks);
      }
      return blocks;
    }

    function appendHostedSearchOrderedTextForRound(round: number, delta: string) {
      if (!delta) return;
      const blocks = getHostedSearchOrderedBlocksForRound(round);
      const last = blocks[blocks.length - 1];
      if (last?.kind === "text") {
        blocks[blocks.length - 1] = {
          kind: "text",
          text: last.text + delta,
        };
      } else {
        blocks.push({ kind: "text", text: delta });
      }
    }

    function upsertHostedSearchOrderedBlockForRound(
      round: number,
      hostedSearch: HostedSearchBlock,
    ) {
      const blocks = getHostedSearchOrderedBlocksForRound(round);
      const idx = blocks.findIndex(
        (block) => block.kind === "hostedSearch" && block.item.id === hostedSearch.id,
      );
      if (idx >= 0) {
        const existing = blocks[idx];
        if (existing?.kind === "hostedSearch") {
          blocks[idx] = {
            kind: "hostedSearch",
            item: mergeHostedSearchBlocks(existing.item, hostedSearch),
          };
        }
        return;
      }
      blocks.push({ kind: "hostedSearch", item: hostedSearch });
    }

    function finishHostedSearchRound(
      round: number,
      mode: "completed" | "failed" | "dispose",
    ) {
      const controller = hostedSearchProbeByRound.get(round);
      if (!controller) return hostedSearchBlocksByRound.get(round) ?? [];
      controller.finishProbe();
      const blocks =
        mode === "completed"
          ? controller.completeAggregator()
          : mode === "failed"
            ? controller.failAggregator()
            : controller.disposeAggregator();
      hostedSearchProbeByRound.delete(round);
      if (blocks.length > 0) {
        hostedSearchBlocksByRound.set(round, blocks);
      }
      return hostedSearchBlocksByRound.get(round) ?? [];
    }

    function finishAllHostedSearchProbes(mode: "completed" | "failed" | "dispose") {
      for (const round of [...hostedSearchProbeByRound.keys()]) {
        finishHostedSearchRound(round, mode);
      }
    }

    async function consumePendingTurnOverride(): Promise<TurnContextOverride> {
      const pending = pendingTurnOverridePromise;
      if (!pending) return null;
      pendingTurnOverridePromise = null;
      return pending;
    }

    function applyTurnContextOverride(override: Exclude<TurnContextOverride, null>) {
      if (!agent) return;
      currentSystemPrompt = override.context.systemPrompt;
      agent.state.systemPrompt = buildSystemPrompt(currentSystemPrompt, toolsSuffix);
      agent.state.messages = override.context.messages.slice();
      agent.state.tools = agentTools;
      emittedBaselineIndex = Math.max(
        0,
        override.context.messages.length - override.emittedMessages.length,
      );
      latestAgentEndMessages = [];
    }

    agentTools = llmTools.map((tool) => ({
      ...tool,
      label: tool.name,
      async execute(toolCallId, toolArgs, signal) {
        const toolCall = toSyntheticToolCall({
          id: toolCallId,
          name: tool.name,
          arguments: (toolArgs ?? {}) as Record<string, unknown>,
        });
        toolCallsById.set(toolCall.id, toolCall);

        if (tool.name === "Bash" || tool.name === "Agent") {
          const batchKey = parallelBatchKeyByToolCallId.get(toolCallId);
          if (batchKey) {
            const batch = startParallelToolBatchIfNeeded(batchKey, signal);
            const toolResult = batch?.resultPromises.get(toolCallId);
            if (toolResult) {
              const resolved = await toolResult;
              toolResultErrorFlags.set(toolCallId, Boolean(resolved.isError));
              return {
                content: resolved.content,
                details: resolved.details ?? {},
              };
            }
          }
        }

        return executeSingleToolCall(toolCall, signal);
      },
    }));

  let streamRound = 0;
  const streamFn = (streamModel: typeof model, streamContext: Context, options?: any) => {
    const round = ++streamRound;
    const stateMessages = getAgentMessages(agent);
    const effectiveContext = sanitizeContextForModelRequest({
      ...streamContext,
      systemPrompt:
        typeof currentSystemPrompt === "string"
          ? currentSystemPrompt
          : streamContext.systemPrompt,
      messages: stateMessages.slice(),
      tools:
        streamContext.tools ??
        ((agent?.state.tools as Context["tools"] | undefined) ?? llmTools),
    });
    const fallbackReasoning =
      params.providerId === "claude_code" || params.providerId === "gemini"
        ? toSimpleStreamReasoning(params.runtime.reasoning)
        : streamModel.api === "openai-responses"
          ? toSimpleStreamReasoning(params.runtime.reasoning)
          : undefined;
    const shouldProbeHostedSearch = Boolean(nativeWebSearchStatus);
    const hostedSearchProbeId = shouldProbeHostedSearch
      ? createHostedSearchProbeId(params.providerId)
      : undefined;
    let streamOptions: StreamOptionsEx = {
      ...(options ?? {}),
      apiKey: options?.apiKey ?? params.runtime.apiKey,
      headers: withHostedSearchProbeHeader(
        {
          ...(options?.headers ?? {}),
          ...proxyRequest.headers,
        },
        hostedSearchProbeId,
      ),
      signal: options?.signal,
      sessionId: options?.sessionId ?? params.sessionId,
      cacheRetention:
        options?.cacheRetention ??
        resolveProviderCacheRetention(
          params.providerId,
          params.runtime.promptCachingEnabled,
        ),
      metadata: buildProviderRequestMetadata(params.providerId, params.sessionId),
      toolChoice:
        options?.toolChoice ??
        (effectiveContext.tools?.length ? "auto" : undefined),
      reasoning: normalizeStreamReasoning(options?.reasoning) ?? fallbackReasoning,
    };

    streamOptions = finalizeProviderStreamOptions({
      providerId: params.providerId,
      baseUrl: params.runtime.baseUrl,
      options: streamOptions,
      context: effectiveContext,
      model: streamModel,
      workdir: params.workdir,
      nativeWebSearch: params.nativeWebSearch,
      debugLogger: params.debugLogger,
      extra: {
        round,
        sessionId: params.sessionId,
      },
    });

    const hostedSearchAggregator = createHostedSearchEventAggregator({
      providerId: params.providerId,
      onHostedSearch: (hostedSearch) => {
        if (hostedSearch.status === "searching") {
          nativeWebSearchStatusController.schedule();
        } else {
          nativeWebSearchStatusController.pause();
        }
        upsertHostedSearchBlockForRound(round, hostedSearch);
        upsertHostedSearchOrderedBlockForRound(round, hostedSearch);
        params.onHostedSearch?.(hostedSearch, round);
      },
    });
    const hostedSearchProbe = startHostedSearchFetchProbe({
      providerId: params.providerId,
      sessionId: params.sessionId,
      requestId: hostedSearchProbeId,
      enabled: shouldProbeHostedSearch,
      onRawEvent: hostedSearchAggregator.accept,
    });
    hostedSearchProbeByRound.set(round, {
      finishProbe: hostedSearchProbe.finish,
      completeAggregator: hostedSearchAggregator.complete,
      failAggregator: hostedSearchAggregator.fail,
      disposeAggregator: hostedSearchAggregator.dispose,
    });

    params.debugLogger?.logRequest(
      buildStreamRequestDebugPayload({
        runtime: params.runtime,
        context: effectiveContext,
        options: streamOptions,
        round,
      }),
    );

    return streamSimpleByApi(streamModel, effectiveContext, streamOptions);
  };

  agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(currentSystemPrompt, toolsSuffix),
      model,
      thinkingLevel,
      tools: agentTools,
      messages: params.context.messages.slice(),
    },
    sessionId: params.sessionId,
    streamFn,
    toolExecution: "sequential",
    afterToolCall: async ({ toolCall }) => ({
      isError: toolResultErrorFlags.get(toolCall.id) ?? false,
    }),
    beforeToolCall: async ({ assistantMessage, toolCall }) => {
      toolCallsById.set(toolCall.id, toolCall);
      if (toolCall.name !== "Agent") {
        return undefined;
      }
      const group = findConsecutiveToolGroup(
        assistantMessage,
        toolCall.id,
        toolCall.name,
      );
      if (!group || group.length <= 1) return undefined;

      const batchKey = buildParallelToolBatchKey(group);
      if (!parallelToolBatches.has(batchKey)) {
        parallelToolBatches.set(batchKey, {
          toolName: toolCall.name,
          toolCalls: group,
          started: false,
          announced: false,
          resultPromises: new Map(),
        });
      }
      for (const call of group) {
        parallelBatchKeyByToolCallId.set(call.id, batchKey);
      }
      return undefined;
    },
    transformContext: async (_messages, _signal) => {
      const override = await consumePendingTurnOverride();
      if (override) {
        applyTurnContextOverride(override);
      }
      return getAgentMessages(agent).slice();
    },
  });

  const textReconciler = createStreamingTextReconciler();

  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "turn_start":
        currentRound += 1;
        params.onTurnStart?.(currentRound);
        params.onToolStatus?.(`第 ${currentRound} 轮：模型生成中...`);
        break;
      case "message_update": {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "text_delta") {
          nativeWebSearchStatusController.noteVisibleActivity();
          const delta = textReconciler.appendDelta(
            `${currentRound}:${streamEvent.contentIndex}`,
            streamEvent.delta,
          );
          if (delta) {
            appendHostedSearchOrderedTextForRound(currentRound, delta);
            params.onTextDelta(delta, currentRound);
          }
        } else if (streamEvent.type === "text_end") {
          const delta = textReconciler.reconcileFinalText(
            `${currentRound}:${streamEvent.contentIndex}`,
            streamEvent.content,
          );
          nativeWebSearchStatusController.pause();
          if (delta) {
            appendHostedSearchOrderedTextForRound(currentRound, delta);
            params.onTextDelta(delta, currentRound);
          }
        } else if (streamEvent.type === "thinking_delta") {
          nativeWebSearchStatusController.noteVisibleActivity();
          params.onThinkingDelta?.(streamEvent.delta, currentRound);
        } else if (streamEvent.type === "thinking_end") {
          nativeWebSearchStatusController.pause();
        } else if (streamEvent.type === "toolcall_start") {
          nativeWebSearchStatusController.pause();
          const block = streamEvent.partial.content[streamEvent.contentIndex];
          if (block && block.type === "toolCall") {
            toolCallsById.set(block.id, block);
            params.onToolCall?.(block, currentRound);
          }
        } else if (streamEvent.type === "toolcall_end") {
          nativeWebSearchStatusController.pause();
          toolCallsById.set(streamEvent.toolCall.id, streamEvent.toolCall);
          params.onToolCall?.(streamEvent.toolCall, currentRound);
        }
        break;
      }
      case "message_end":
        if (event.message.role === "assistant") {
          const hostedSearchFinishMode =
            event.message.stopReason === "aborted"
              ? "dispose"
              : event.message.stopReason === "error"
                ? "failed"
                : "completed";
          const hostedSearchBlocks = finishHostedSearchRound(
            currentRound,
            hostedSearchFinishMode,
          );
          const assistantWithHostedSearch = appendHostedSearchBlocksToAssistant(
            event.message as AssistantMessage & { content: unknown[] },
            hostedSearchBlocks,
            {
              orderedBlocks: hostedSearchOrderedBlocksByRound.get(currentRound),
            },
          ) as AssistantMessage;
          const normalizedSeedTurn = recoverAssistantSeedToolCalls(assistantWithHostedSearch);
          const assistantMessage = normalizedSeedTurn?.assistant ?? assistantWithHostedSearch;
          if (normalizedSeedTurn || assistantWithHostedSearch !== event.message) {
            const stateMessages = getAgentMessages(agent);
            if (stateMessages.length > 0) {
              agent.state.messages = [...stateMessages.slice(0, -1), assistantMessage];
            }
          }
          if (normalizedSeedTurn && normalizedSeedTurn.toolCalls.length > 0) {
            pendingRecoveredSeedTurnRef.current = {
              round: currentRound,
              assistant: assistantMessage,
              toolCalls: normalizedSeedTurn.toolCalls,
            };
            params.debugLogger?.logResponse({
              type: "seed_tool_call_recovery",
              round: currentRound,
              toolCalls: normalizedSeedTurn.toolCalls,
            });
          }
          params.debugLogger?.logResult({
            round: currentRound,
            assistant: assistantMessage,
          });
          const toolCallCount = getAssistantToolCalls(assistantMessage).length;
          if (toolCallCount > 0) {
            nativeWebSearchStatusController.pause();
            params.onToolStatus?.(`第 ${currentRound} 轮：准备执行 ${toolCallCount} 个工具...`);
          }
          params.onAssistantMessage?.(assistantMessage, currentRound);
        } else if (event.message.role === "toolResult") {
          const toolCall =
            toolCallsById.get(event.message.toolCallId) ??
            toSyntheticToolCall({
              id: event.message.toolCallId,
              name: event.message.toolName,
            });
          params.onToolResult?.(toolCall, event.message, currentRound);
        }
        break;
      case "turn_end": {
        const toolResults = event.toolResults.filter(
          (message): message is ToolResultMessage => message.role === "toolResult",
        );
        if (
          params.onBeforeNextTurn &&
          event.message.role === "assistant" &&
          event.message.stopReason === "toolUse" &&
          toolResults.length > 0
        ) {
          const runtimeMessages = getAgentMessages(agent);
          const runtimeSnapshot: Context = {
            systemPrompt: currentSystemPrompt,
            messages: runtimeMessages.slice(),
            tools: llmTools,
          };
          const emittedSnapshot = getMessagesSinceBaseline(agent, emittedBaselineIndex);
          const assistant = event.message;
          pendingTurnOverridePromise = params.onBeforeNextTurn({
            round: currentRound,
            assistant,
            toolResults,
            runtimeContext: runtimeSnapshot,
            emittedMessages: emittedSnapshot,
            signal: params.signal,
          });
        }
        break;
      }
      case "tool_execution_start": {
        nativeWebSearchStatusController.pause();
        const toolCall =
          toolCallsById.get(event.toolCallId) ??
          toSyntheticToolCall({
            id: event.toolCallId,
            name: event.toolName,
            arguments: event.args ?? {},
          });
        toolCallsById.set(toolCall.id, toolCall);
        const parallelBatch = getParallelToolBatch(
          toolCall.id,
          parallelBatchKeyByToolCallId,
          parallelToolBatches,
        );
        if (parallelBatch && parallelBatch.toolCalls.length > 1) {
          params.onToolStatus?.(getParallelToolBatchStatus(parallelBatch));
        } else {
          params.onToolStatus?.(`正在执行：${summarizeToolCall(toolCall)}`);
        }
        params.onToolExecutionStart?.(toolCall, currentRound);
        break;
      }
      case "agent_end":
        latestAgentEndMessages = event.messages as Message[];
        {
          const assistant = findLastAssistantMessage(latestAgentEndMessages);
          const hostedSearchFinishMode =
            assistant?.stopReason === "aborted"
              ? "dispose"
              : assistant?.stopReason === "error"
                ? "failed"
                : "completed";
          finishAllHostedSearchProbes(hostedSearchFinishMode);
        }
        nativeWebSearchStatusController.finish();
        params.onToolStatus?.(null);
        break;
    }
  });

  let abortListener: (() => void) | undefined;
  if (params.signal) {
    const onAbort = () => agent.abort();
    params.signal.addEventListener("abort", onAbort, { once: true });
    abortListener = () => params.signal?.removeEventListener("abort", onAbort);
  }

    try {
      let recoveredSeedTurnCount = 0;
      while (true) {
        await agent.continue();

        const override = await consumePendingTurnOverride();
        if (override) {
          applyTurnContextOverride(override);
        }

        const recoveredSeedTurn = pendingRecoveredSeedTurnRef.current;
        pendingRecoveredSeedTurnRef.current = null;
        if (recoveredSeedTurn === null) {
          break;
        }
        const recoveredSeedRound = recoveredSeedTurn.round;
        const recoveredSeedAssistant = recoveredSeedTurn.assistant;
        const recoveredSeedToolCalls = recoveredSeedTurn.toolCalls;

        recoveredSeedTurnCount += 1;
        if (recoveredSeedTurnCount > 8) {
          throw new Error("Too many seed tool-call recovery attempts");
        }

        params.onToolStatus?.(
          `第 ${recoveredSeedRound} 轮：恢复执行 ${recoveredSeedToolCalls.length} 个工具...`,
        );

        const syntheticToolResults: ToolResultMessage[] = [];
        for (const toolCall of recoveredSeedToolCalls) {
          toolCallsById.set(toolCall.id, toolCall);
          params.onToolCall?.(toolCall, recoveredSeedRound);
          params.onToolStatus?.(`正在执行：${summarizeToolCall(toolCall)}`);
          params.onToolExecutionStart?.(toolCall, recoveredSeedRound);

          const result = await executeSingleToolCall(toolCall, params.signal);
          const toolResult = {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: result.content,
            details: result.details,
            isError: toolResultErrorFlags.get(toolCall.id) ?? false,
            timestamp: Date.now(),
          } satisfies ToolResultMessage;

          syntheticToolResults.push(toolResult);
          params.onToolResult?.(toolCall, toolResult, recoveredSeedRound);
        }

        if (syntheticToolResults.length > 0) {
          agent.state.messages = [...getAgentMessages(agent), ...syntheticToolResults];
        }

        if (params.onBeforeNextTurn) {
          pendingTurnOverridePromise = params.onBeforeNextTurn({
            round: recoveredSeedRound,
            assistant: recoveredSeedAssistant,
            toolResults: syntheticToolResults,
            runtimeContext: {
              systemPrompt: currentSystemPrompt,
              messages: getAgentMessages(agent).slice(),
              tools: llmTools,
            },
            emittedMessages: getMessagesSinceBaseline(agent, emittedBaselineIndex),
            signal: params.signal,
          });
        }
      }

      const messages = getAgentMessages(agent).slice();
      const assistant =
        findLastAssistantMessage(messages) ?? findLastAssistantMessage(latestAgentEndMessages);

      if (!assistant) {
        throw new Error("Model did not return an assistant message");
      }

      if (assistant.stopReason === "error") {
        throw new Error(normalizeErrorMessage(assistant.errorMessage, "Request failed"));
      }
      if (assistant.stopReason === "aborted") {
        throw new Error(normalizeErrorMessage(assistant.errorMessage, "Cancelled"));
      }

      await params.debugLogger?.flush();
      return {
        messages,
        assistant,
        emittedMessages: getMessagesSinceBaseline(agent, emittedBaselineIndex),
      };
    } catch (error) {
      finishAllHostedSearchProbes(params.signal?.aborted ? "dispose" : "failed");
      nativeWebSearchStatusController.finish();
      params.onToolStatus?.(null);
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    } finally {
      finishAllHostedSearchProbes("dispose");
      nativeWebSearchStatusController.finish();
      abortListener?.();
      unsubscribe();
    }
  });
}
