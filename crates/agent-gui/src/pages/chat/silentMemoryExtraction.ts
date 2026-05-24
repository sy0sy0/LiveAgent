import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

import { runAssistantWithTools } from "../../lib/chat/runner/agentRunner";
import { isAbortLikeError } from "../../lib/chat/page/chatPageHelpers";
import {
  recordSilentMemoryDecision,
  recordSilentMemorySkip,
} from "../../lib/chat/memory/memoryDecisionLog";
import { collectHeuristicSuggestions } from "../../lib/chat/memory/memoryExtractor";
import {
  buildAlreadyWrittenBlock,
  buildExistingCandidatesBlock,
  buildHeuristicSuggestionsBlock,
  buildRecentRejectionsBlock,
  buildSilentMemoryExtractionPrompt,
  DEFAULT_MEMORY_REVIEWER_MODE,
  SILENT_MEMORY_DONE_TEXT,
  SILENT_MEMORY_NOOP_TEXT,
  SILENT_MEMORY_SYSTEM_PROMPT,
  type MemoryReviewerMode,
  type SilentMemoryCandidateEntry,
  type SilentMemoryRejectionEntry,
} from "../../lib/chat/memory/memoryPolicy";
import {
  parseSilentMemoryProtocol,
  type SilentMemoryBlockPlanItem,
  type SilentMemoryParseResult,
} from "../../lib/chat/memory/memoryProtocol";
import type { StreamDebugLogger } from "../../lib/debug/agentDebug";
import {
  memoryList,
  memoryRecentRejections,
  memoryTodayLocalDate,
  type MemoryMeta,
} from "../../lib/memory/api";
import type {
  CodexRequestFormat,
  ProviderId,
  ProviderModelConfig,
  ReasoningLevel,
  SelectedModel,
} from "../../lib/settings";
import { createMemoryTools } from "../../lib/tools/memoryTools";
import { appendSystemPrompt } from "./chatPageRuntime";

const SILENT_MEMORY_EXTRACTION_TIMEOUT_MS = 45_000;
const SILENT_MEMORY_CANDIDATE_LIMIT = 30;

export { buildSilentMemoryExtractionPrompt };

function isShortMemoryConfirmationText(text: string): boolean {
  const normalized = text
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s"'“”‘’`.,!?;:，。！？；：、]/g, "");
  return /^(是|是的|对|对的|没错|正确|确认|是这样|不是|不是的|不对|否|没有|yes|y|yep|yeah|correct|right|no|n|nope|wrong|notreally)$/.test(
    normalized,
  );
}

function isConfirmableMemoryHypothesis(entry: SilentMemoryCandidateEntry): boolean {
  return entry.unreviewed === true && entry.memoryType !== "daily";
}

function toCandidateEntry(entry: MemoryMeta): SilentMemoryCandidateEntry {
  return {
    slug: entry.slug,
    memoryType: entry.memoryType,
    scope: entry.scope,
    description: entry.description || entry.headline || undefined,
    unreviewed: entry.unreviewed,
    confidence: entry.confidence,
    updatedAt: entry.updatedAt,
  };
}

function collectCandidateEntries(
  entries: readonly MemoryMeta[],
): SilentMemoryCandidateEntry[] {
  const seen = new Set<string>();
  const all: SilentMemoryCandidateEntry[] = [];
  for (const entry of entries) {
    if (entry.memoryType === "daily") continue;
    const key = `${entry.scope}:${entry.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(toCandidateEntry(entry));
  }
  all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return all.slice(0, SILENT_MEMORY_CANDIDATE_LIMIT);
}

export type SilentMemoryExtractionVisibleEvents = {
  roundOffset?: number;
  onTurnStart?: (round: number) => void;
  onTextDelta?: (delta: string, round: number) => void;
  onThinkingDelta?: (delta: string, round: number) => void;
  onToolCall?: (toolCall: ToolCall, round: number) => void;
  onToolExecutionStart?: (toolCall: ToolCall, round: number) => void;
  onToolResult?: (
    toolCall: ToolCall,
    toolResult: ToolResultMessage,
    round: number,
  ) => void;
  onAssistantMessage?: (assistant: AssistantMessage, round: number) => void;
  onToolStatus?: (status: string | null) => void;
};

export type SilentMemoryExtractionRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  nativeWebSearchEnabled?: boolean;
  modelConfig?: ProviderModelConfig;
};

export type SilentMemoryExtractionModelConfig = {
  providerId: ProviderId;
  model: string;
  runtime: SilentMemoryExtractionRuntimeConfig;
  selectedModel?: SelectedModel;
};

export type SilentMemoryExtractionBaseParams = {
  sessionId: string;
  conversationId: string;
  workdir?: string;
  reviewerMode?: MemoryReviewerMode;
  buildContext: (tools: Context["tools"]) => Context;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  visibleEvents?: SilentMemoryExtractionVisibleEvents;
};

export type SilentMemoryExtractionParams =
  SilentMemoryExtractionModelConfig & SilentMemoryExtractionBaseParams;

export type SilentMemoryExtractionResult = {
  ok: boolean;
  emittedMessages: Message[];
  aborted?: boolean;
};

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

// Per-conversation in-memory tracking of slugs already mutated by a silent
// pass in the current turn. Used to build the <already-written-this-turn>
// block on subsequent passes so the model emits DUPLICATE rather than
// re-writing. Cleared by recordSilentMemoryTurnBoundary when a new user turn
// begins (caller's responsibility); each conversation's list is capped.
const SILENT_MEMORY_WRITTEN_SLUG_LIMIT = 16;
const silentMemoryWrittenSlugs = new Map<string, string[]>();

// Per-conversation timestamp of the last completed silent extraction. Used by
// the throttling pre-flight to skip back-to-back silent rounds.
const SILENT_MEMORY_MIN_INTERVAL_MS = 30_000;
const silentMemoryLastRunAt = new Map<string, number>();

export function recordSilentMemoryTurnBoundary(conversationId: string) {
  silentMemoryWrittenSlugs.delete(conversationId);
  silentMemoryLastRunAt.delete(conversationId);
}

// Heuristics that decide whether a silent extraction pass is worth starting.
// Returns null when the pass should run; otherwise a short reason string used
// for telemetry/logging. Kept exported so callers and tests can verify the
// guardrails without hitting the LLM.
export function silentMemorySkipReason(params: {
  latestUserText: string;
  conversationId: string;
  nowMs?: number;
  hasConfirmableMemoryHypothesis?: boolean;
}): string | null {
  const text = params.latestUserText.trim();
  if (text.length === 0) return "empty-user-message";

  const mayAnswerMemoryConfirmation =
    params.hasConfirmableMemoryHypothesis === true && isShortMemoryConfirmationText(text);
  if (text.length < 6 && !mayAnswerMemoryConfirmation) return "user-message-too-short";

  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, "");
  if (stripped.length === 0) return "punctuation-only-user-message";

  // CJK has no ASCII word boundary; rely on a prefix match plus a length
  // cap so that "谢谢你，请以后默认用中文" still reaches the LLM.
  const SHORT_ACK_LIMIT = 24;
  const greetingPattern = /^(你好|您好|哈喽|早安|晚安|早上好|晚上好|hi+|hello+|hey+)/iu;
  const thanksPattern = /^(谢谢|多谢|感谢|辛苦了|thanks?|thank you|ty|thx)/iu;
  const acknowledgePattern = /^(好的?|收到|明白(?:了)?|ok|okay|got it|sounds good|sure)/iu;
  if (greetingPattern.test(text) && text.length < SHORT_ACK_LIMIT) return "greeting";
  if (thanksPattern.test(text) && text.length < SHORT_ACK_LIMIT) {
    return "acknowledgement-thanks";
  }
  if (
    acknowledgePattern.test(text) &&
    text.length < SHORT_ACK_LIMIT &&
    !mayAnswerMemoryConfirmation
  ) {
    return "acknowledgement-ok";
  }

  const now = params.nowMs ?? Date.now();
  const lastRun = silentMemoryLastRunAt.get(params.conversationId);
  if (lastRun !== undefined && now - lastRun < SILENT_MEMORY_MIN_INTERVAL_MS) {
    return "throttled-min-interval";
  }

  return null;
}

function extractLatestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) =>
          part && typeof part === "object" && part.type === "text" ? part.text : "",
        )
        .filter((segment): segment is string => typeof segment === "string")
        .join("\n");
      if (text.trim().length > 0) return text;
    }
  }
  return "";
}

function noteSilentMemoryWrittenSlug(conversationId: string, slug: string) {
  if (!slug) return;
  const existing = silentMemoryWrittenSlugs.get(conversationId) ?? [];
  if (existing.includes(slug)) return;
  const next = [...existing, slug];
  if (next.length > SILENT_MEMORY_WRITTEN_SLUG_LIMIT) {
    next.splice(0, next.length - SILENT_MEMORY_WRITTEN_SLUG_LIMIT);
  }
  silentMemoryWrittenSlugs.set(conversationId, next);
}

async function loadSilentMemoryCandidates(workdir: string) {
  try {
    const response = await memoryList({
      workdir: workdir || undefined,
      includeDaily: false,
      limit: SILENT_MEMORY_CANDIDATE_LIMIT * 3,
    });
    return collectCandidateEntries(response.entries);
  } catch (error) {
    console.warn("Failed to load silent memory candidates:", error);
    return [];
  }
}

async function loadSilentMemoryRejections(
  workdir: string,
): Promise<SilentMemoryRejectionEntry[]> {
  try {
    const response = await memoryRecentRejections({
      sinceDays: 7,
      limit: 30,
      workdir: workdir || undefined,
    });
    return response.entries.map((entry) => ({
      slug: entry.slug,
      rejectedAt: entry.rejectedAt,
      reason: entry.reason ?? null,
    }));
  } catch (error) {
    console.warn("Failed to load silent memory rejections:", error);
    return [];
  }
}

function extractAssistantTextForProtocol(assistant: AssistantMessage): string {
  if (!Array.isArray(assistant.content)) {
    return typeof assistant.content === "string" ? assistant.content : "";
  }
  return assistant.content
    .map((part) => (part && typeof part === "object" && part.type === "text" ? part.text : ""))
    .filter((segment): segment is string => typeof segment === "string" && segment.length > 0)
    .join("\n");
}

/** Pick the final assistant message from the emitted stream and return its
 *  combined text content for protocol parsing. Returns "" when the silent
 *  round never produced an assistant message (timeout / abort).
 */
function extractFinalAssistantTextForProtocol(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === "assistant") {
      return extractAssistantTextForProtocol(message as AssistantMessage);
    }
  }
  return "";
}

function countAssistantMessages(messages: readonly Message[]) {
  return messages.reduce((count, message) => count + (message.role === "assistant" ? 1 : 0), 0);
}

function findLastAssistantIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

function textArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function planItemToToolArguments(
  item: SilentMemoryBlockPlanItem,
  localDate: string,
): Record<string, unknown> | null {
  const action = textArg(item.action);
  const slug = textArg(item.slug) ?? `daily-${localDate}`;
  if (!action || !slug) return null;

  const evidence = {
    confidence: textArg(item.confidence),
    source_quote: textArg(item.source_quote),
    reasoning: textArg(item.reasoning),
    supersedes: textArg(item.supersedes),
    conflicts_with: item.conflicts_with,
    override_reject: textArg(item.override_reject),
  };

  if (action === "append-daily") {
    return {
      action: "update",
      slug,
      scope: "global",
      mode: "append",
      body: textArg(item.body) ?? "",
    };
  }

  if (action === "write") {
    return {
      action,
      slug,
      scope: textArg(item.scope),
      type: textArg(item.type),
      description: textArg(item.description),
      body: textArg(item.body) ?? "",
      ...evidence,
    };
  }

  if (action === "update") {
    return {
      action,
      slug,
      scope: textArg(item.scope) ?? "auto",
      type: textArg(item.type),
      description: textArg(item.description),
      body: textArg(item.body),
      mode: textArg(item.mode) ?? "merge",
      ...evidence,
    };
  }

  if (action === "accept") {
    return {
      action,
      slug,
      scope: textArg(item.scope),
    };
  }

  if (action === "delete") {
    return {
      action,
      slug,
      scope: textArg(item.scope),
    };
  }

  return null;
}

function toToolResultMessage(message: Message, toolCall: ToolCall): ToolResultMessage {
  if (message.role === "toolResult") return message;
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: "MemoryManager did not return a tool result" }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

function createSyntheticUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createSilentMemoryStatusAssistant(params: {
  template?: AssistantMessage;
  model: string;
  text: string;
}): AssistantMessage {
  return {
    ...(params.template ?? {}),
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: params.template?.api ?? "liveagent-memory",
    provider: params.template?.provider ?? "liveagent",
    model: params.template?.model ?? params.model,
    usage: params.template?.usage ?? createSyntheticUsage(),
    stopReason: "stop",
    timestamp: params.template?.timestamp ?? Date.now(),
  };
}

function replaceFinalAssistantWithStatus(
  messages: readonly Message[],
  statusAssistant: AssistantMessage,
): Message[] {
  const next = messages.slice();
  const index = findLastAssistantIndex(next);
  if (index >= 0) {
    next[index] = statusAssistant;
  } else {
    next.push(statusAssistant);
  }
  return next;
}

function statusTextForParseResult(
  parseResult: SilentMemoryParseResult,
  fallbackText?: string,
): string {
  if (parseResult.ok && !parseResult.parseFailed) {
    const emitted = parseResult.blocks.emit?.text.trim();
    if (emitted) return emitted;
    const planItems = parseResult.blocks.plan?.items ?? [];
    return planItems.length > 0 ? SILENT_MEMORY_DONE_TEXT : SILENT_MEMORY_NOOP_TEXT;
  }
  const fallback = fallbackText?.trim();
  if (fallback === SILENT_MEMORY_DONE_TEXT || fallback === SILENT_MEMORY_NOOP_TEXT) {
    return fallback;
  }
  return SILENT_MEMORY_NOOP_TEXT;
}

function emitSilentMemoryStatus(params: {
  visibleEvents?: SilentMemoryExtractionVisibleEvents;
  statusAssistant: AssistantMessage;
  round: number;
  forwardedTurnRounds: Set<number>;
}) {
  if (!params.visibleEvents) return;
  if (!params.forwardedTurnRounds.has(params.round)) {
    params.visibleEvents.onTurnStart?.(params.round);
    params.forwardedTurnRounds.add(params.round);
  }
  const text = extractAssistantTextForProtocol(params.statusAssistant);
  if (text) {
    params.visibleEvents.onTextDelta?.(text, params.round);
  }
  params.visibleEvents.onAssistantMessage?.(params.statusAssistant, params.round);
}

async function applySilentMemoryPlan(params: {
  parseResult: SilentMemoryParseResult;
  localDate: string;
  workdir: string;
  conversationId: string;
  model: string;
  signal?: AbortSignal;
  visibleEvents?: SilentMemoryExtractionVisibleEvents;
  round: number;
}): Promise<Message[]> {
  if (!params.parseResult.ok || params.parseResult.parseFailed) return [];
  const planItems = params.parseResult.blocks.plan?.items ?? [];
  if (planItems.length === 0) return [];

  const mutationBundle = createMemoryTools({
    workdir: params.workdir,
    mode: "rw",
    actor: "extractor",
    conversationId: params.conversationId,
    model: params.model,
  });
  const emitted: Message[] = [];
  params.visibleEvents?.onTurnStart?.(params.round);

  for (const [index, item] of planItems.entries()) {
    if (params.signal?.aborted) break;
    const args = planItemToToolArguments(item, params.localDate);
    if (!args) continue;
    const toolCall: ToolCall = {
      type: "toolCall",
      id: `silent-memory-plan-${Date.now()}-${index}`,
      name: "MemoryManager",
      arguments: args,
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [toolCall],
      api: "liveagent-memory",
      provider: "liveagent",
      model: params.model,
      usage: createSyntheticUsage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    emitted.push(assistant);
    params.visibleEvents?.onToolCall?.(toolCall, params.round);
    params.visibleEvents?.onToolExecutionStart?.(toolCall, params.round);
    const toolResult = toToolResultMessage(
      await mutationBundle.executeToolCall(toolCall, params.signal),
      toolCall,
    );
    emitted.push(toolResult);
    params.visibleEvents?.onToolResult?.(toolCall, toolResult, params.round);
    if (!toolResult.isError) {
      const action = textArg(args.action);
      const slug = textArg(args.slug);
      if ((action === "write" || action === "update") && slug) {
        noteSilentMemoryWrittenSlug(params.conversationId, slug);
      }
    }
  }

  return emitted;
}

async function resolveLocalDate() {
  try {
    return await memoryTodayLocalDate();
  } catch (error) {
    console.warn("Failed to resolve memory local date for silent extraction", error);
    const now = new Date();
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }
}

export async function runSilentMemoryExtraction(
  params: SilentMemoryExtractionParams,
): Promise<SilentMemoryExtractionResult> {
  const workdir = params.workdir?.trim() ?? "";
  const memoryBundle = createMemoryTools({
    workdir,
    mode: "ro",
    actor: "extractor",
    conversationId: params.conversationId,
    model: params.model,
  });
  const baseContext = params.buildContext(memoryBundle.tools);

  // P1-6: cheap heuristics — skip the LLM round entirely for greetings,
  // acknowledgements, ultra-short messages, and back-to-back triggers.
  const latestUserText = extractLatestUserText(baseContext.messages);
  const preliminarySkipReason = silentMemorySkipReason({
    latestUserText,
    conversationId: params.conversationId,
  });
  const canDeferShortConfirmationSkip =
    preliminarySkipReason === "user-message-too-short" &&
    isShortMemoryConfirmationText(latestUserText);
  if (preliminarySkipReason && !canDeferShortConfirmationSkip) {
    console.debug(`Silent memory extraction skipped: ${preliminarySkipReason}`);
    recordSilentMemorySkip(params.conversationId, preliminarySkipReason);
    return {
      ok: true,
      emittedMessages: [] as Message[],
    };
  }

  const [localDate, candidates, rejections] = await Promise.all([
    resolveLocalDate(),
    loadSilentMemoryCandidates(workdir),
    loadSilentMemoryRejections(workdir),
  ]);
  const hasConfirmableMemoryHypothesis = candidates.some(isConfirmableMemoryHypothesis);
  if (preliminarySkipReason && canDeferShortConfirmationSkip) {
    const skipReason = silentMemorySkipReason({
      latestUserText,
      conversationId: params.conversationId,
      hasConfirmableMemoryHypothesis,
    });
    if (skipReason) {
      console.debug(`Silent memory extraction skipped: ${skipReason}`);
      recordSilentMemorySkip(params.conversationId, skipReason);
      return {
        ok: true,
        emittedMessages: [] as Message[],
      };
    }
  }
  silentMemoryLastRunAt.set(params.conversationId, Date.now());

  const writtenSlugs = silentMemoryWrittenSlugs.get(params.conversationId) ?? [];
  const heuristics = collectHeuristicSuggestions(latestUserText);
  const candidatesBlock = buildExistingCandidatesBlock(candidates);
  const rejectionsBlock = buildRecentRejectionsBlock(rejections);
  const writtenBlock = buildAlreadyWrittenBlock(writtenSlugs);
  const heuristicsBlock = buildHeuristicSuggestionsBlock(heuristics);
  const reviewerMode = params.reviewerMode ?? DEFAULT_MEMORY_REVIEWER_MODE;
  const hiddenPromptText = [
    candidatesBlock,
    rejectionsBlock,
    writtenBlock,
    heuristicsBlock,
    "",
    buildSilentMemoryExtractionPrompt({ localDate, workdir, reviewerMode }),
  ].join("\n\n");
  const hiddenPrompt: UserMessage = {
    role: "user",
    content: hiddenPromptText,
    timestamp: Date.now(),
  };
  const context: Context = {
    ...baseContext,
    tools: memoryBundle.tools,
    systemPrompt: appendSystemPrompt(baseContext.systemPrompt, SILENT_MEMORY_SYSTEM_PROMPT),
    messages: [...baseContext.messages, hiddenPrompt],
  };
  const timeoutSignal = createTimeoutSignal(
    params.signal,
    SILENT_MEMORY_EXTRACTION_TIMEOUT_MS,
  );
  const visibleEvents = params.visibleEvents;
  const mapRound = (round: number) => (visibleEvents?.roundOffset ?? 0) + round;
  const forwardedTurnRounds = new Set<number>();
  let lastAssistantRound: number | null = null;

  try {
    const result = await runAssistantWithTools({
      providerId: params.providerId,
      model: params.model,
      runtime: params.runtime,
      context,
      workdir,
      sessionId: `${params.sessionId}:memory:${params.conversationId}:${Date.now()}`,
      tools: memoryBundle.tools,
      executeToolCall: memoryBundle.executeToolCall,
      onTurnStart: (round) => {
        const mapped = mapRound(round);
        forwardedTurnRounds.add(mapped);
        visibleEvents?.onTurnStart?.(mapped);
      },
      // The assistant's raw text is the four-block machine protocol. Do not
      // stream it to chat; after parsing, emit only block-4's concise status.
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolCall: (toolCall, round) =>
        visibleEvents?.onToolCall?.(toolCall, mapRound(round)),
      onToolExecutionStart: (toolCall, round) =>
        visibleEvents?.onToolExecutionStart?.(toolCall, mapRound(round)),
      onToolResult: (toolCall, toolResult, round) => {
        if (toolResult.role !== "toolResult") return;
        visibleEvents?.onToolResult?.(toolCall, toolResult, mapRound(round));
        if (
          toolCall.name === "MemoryManager" &&
          !toolResult.isError &&
          toolCall.arguments &&
          typeof toolCall.arguments === "object"
        ) {
          const args = toolCall.arguments as Record<string, unknown>;
          const action = typeof args.action === "string" ? args.action : "";
          const slug = typeof args.slug === "string" ? args.slug : "";
          if ((action === "write" || action === "update") && slug) {
            noteSilentMemoryWrittenSlug(params.conversationId, slug);
          }
        }
      },
      onAssistantMessage: (assistant, round) => {
        if (assistant.role !== "assistant") return;
        lastAssistantRound = mapRound(round);
      },
      onToolStatus: (status) => visibleEvents?.onToolStatus?.(status),
      signal: timeoutSignal.signal,
      debugLogger: params.debugLogger,
      allowEmptyWorkdir: true,
    });
    let emittedMessages = result.emittedMessages;
    // Parse the four-block protocol from the LAST assistant message only —
    // intermediate rounds (those triggering tool calls) do not contain the
    // protocol payload and would otherwise pollute the decision log with
    // spurious parse-failed entries.
    const finalAssistantIndex = findLastAssistantIndex(result.emittedMessages);
    const finalAssistant =
      finalAssistantIndex >= 0
        ? (result.emittedMessages[finalAssistantIndex] as AssistantMessage)
        : undefined;
    const finalAssistantText = extractFinalAssistantTextForProtocol(
      result.emittedMessages,
    );
    if (finalAssistantText) {
      const parseResult = parseSilentMemoryProtocol(finalAssistantText);
      recordSilentMemoryDecision(params.conversationId, parseResult);
      if (parseResult.parseFailed) {
        console.warn(
          "Silent memory four-block protocol parse failed:",
          parseResult.reason,
        );
      }
      const statusAssistant = createSilentMemoryStatusAssistant({
        template: finalAssistant,
        model: params.model,
        text: statusTextForParseResult(parseResult, finalAssistantText),
      });
      emittedMessages = replaceFinalAssistantWithStatus(
        result.emittedMessages,
        statusAssistant,
      );
      emitSilentMemoryStatus({
        visibleEvents,
        statusAssistant,
        round:
          lastAssistantRound ??
          mapRound(Math.max(1, countAssistantMessages(result.emittedMessages))),
        forwardedTurnRounds,
      });

      if (!parseResult.parseFailed) {
        const planRound = mapRound(countAssistantMessages(emittedMessages) + 1);
        const mutationMessages = await applySilentMemoryPlan({
          parseResult,
          localDate,
          workdir,
          conversationId: params.conversationId,
          model: params.model,
          signal: timeoutSignal.signal,
          visibleEvents,
          round: planRound,
        });
        if (mutationMessages.length > 0) {
          emittedMessages = [...emittedMessages, ...mutationMessages];
        }
      }
    }
    return {
      ok: true,
      emittedMessages,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timeoutSignal.timedOut()) {
      console.warn("Silent memory extraction timed out");
    } else if (!params.signal?.aborted && !isAbortLikeError(error)) {
      console.warn("Silent memory extraction failed", message);
    }
    return {
      ok: false,
      emittedMessages: [] as Message[],
      aborted:
        params.signal?.aborted === true ||
        (!timeoutSignal.timedOut() && isAbortLikeError(error)),
    };
  } finally {
    timeoutSignal.cleanup();
  }
}
