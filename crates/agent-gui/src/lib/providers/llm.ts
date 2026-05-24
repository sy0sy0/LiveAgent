import { getModel } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { streamAnthropic } from "@mariozechner/pi-ai/anthropic";
import {
  streamOpenAICompletions,
  type OpenAICompletionsOptions,
} from "@mariozechner/pi-ai/openai-completions";
import {
  streamOpenAIResponses,
  type OpenAIResponsesOptions,
} from "@mariozechner/pi-ai/openai-responses";
import {
  streamGoogle,
  type GoogleOptions,
} from "@mariozechner/pi-ai/google";

import {
  buildStreamRequestDebugPayload,
  type StreamDebugLogger,
} from "../debug/agentDebug";
import { withPowerActivity } from "../system/powerActivity";
import {
  getProviderModelDefaults,
  type CodexRequestFormat,
  type ProviderId,
  type ProviderModelConfig,
  type ReasoningLevel,
} from "../settings";

import { providerSupportsNativeWebSearch } from "./nativeWebSearch";
import {
  createHostedSearchProbeId,
  createHostedSearchEventAggregator,
  startHostedSearchFetchProbe,
  withHostedSearchProbeHeader,
} from "./hostedSearchEvents";
import { prepareProxyRequest } from "./proxy";
import {
  attachAnthropicMessagesNativeAttachments,
  attachGeminiGenerativeAINativeAttachments,
  attachOpenAIResponsesNativeAttachments,
} from "./nativeResponsesAttachments";
import {
  appendHostedSearchBlocksToAssistant,
  mergeHostedSearchBlocks,
  type HostedSearchBlock,
  type HostedSearchOrderedBlock,
} from "../chat/messages/hostedSearch";

export { providerSupportsNativeWebSearch } from "./nativeWebSearch";

export type ModelOption = {
  value: string;         // encodes customProviderId::model
  label: string;         // model id
  providerName: string;  // provider display name (for grouping)
  providerType: ProviderId; // routes Claude Code, Codex, Gemini, etc.
  model: string;
};

type ProviderRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  nativeWebSearchEnabled?: boolean;
  modelConfig?: ProviderModelConfig;
};

const VALUE_SEP = "::";
const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

type CodexApi = "openai-responses" | "openai-completions";

type AnthropicEffort = "low" | "medium" | "high" | "max" | "xhigh";
type AnthropicThinkingMode = "disabled" | "adaptive" | "budget";
type AnthropicThinkingRuntime = {
  thinkingEnabled: boolean;
  mode: AnthropicThinkingMode;
  maxTokens: number;
  effort?: AnthropicEffort;
  thinkingBudgetTokens?: number;
  display?: "summarized";
  omitDisabledThinking?: boolean;
};

type ToolChoice =
  | "auto"
  | "any"
  | "none"
  | {
      type: "tool";
      name: string;
    };

export type StreamOptionsEx = SimpleStreamOptions & {
  /**
   * 注意：pi-ai 的 streamSimpleAnthropic() 在内部会通过 buildBaseOptions() 丢弃 toolChoice，
   * 所以这里我们自己调用 streamAnthropic() 并把 toolChoice 显式传下去。
   */
  toolChoice?: ToolChoice;
};

export function buildDualAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };
}

export function buildGeminiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-goog-api-key": apiKey,
  };
}

export function buildProviderAuthHeaders(
  providerId: ProviderId,
  apiKey: string,
): Record<string, string> {
  return providerId === "gemini"
    ? buildGeminiAuthHeaders(apiKey)
    : buildDualAuthHeaders(apiKey);
}

function appendSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  if (!head) return suffix;
  return `${head}\n\n${suffix}`;
}

function buildTextOnlySystemSuffix(allowJsonOutput = false) {
  return [
    "Important Rules:",
    allowJsonOutput
      ? "- Your final user-visible output must be plain text. Markdown or valid JSON is allowed."
      : "- Your final user-visible output must be plain text. Markdown is allowed.",
    allowJsonOutput
      ? "- Do not output event streams or raw tool-call structures."
      : "- Do not output event streams, raw JSON, or raw tool-call structures.",
    "- You are currently in text-only mode: do not make any tool calls.",
  ].join("\n");
}

function supportsAdaptiveAnthropicThinking(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    isAnthropicMythosPreview(id) ||
    isClaudeFamilyVersionAtLeast(id, "opus", 6) ||
    isClaudeFamilyVersionAtLeast(id, "sonnet", 6)
  );
}

function isAnthropicMythosPreview(modelId: string) {
  return modelId.toLowerCase().includes("mythos-preview");
}

function isClaudeFamilyVersionAtLeast(
  normalizedModelId: string,
  family: "opus" | "sonnet",
  minimumMinor: number,
) {
  const match = normalizedModelId.match(
    new RegExp(`${family}[-.]4[-.](\\d+)`),
  );
  if (!match) return false;
  const minor = Number(match[1]);
  return Number.isFinite(minor) && minor >= minimumMinor;
}

function supportsXHighAnthropicEffort(modelId: string) {
  const id = modelId.toLowerCase();
  return id.includes("mythos-preview") || isClaudeFamilyVersionAtLeast(id, "opus", 7);
}

function supportsMaxAnthropicEffort(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    id.includes("mythos-preview") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("sonnet-4-6") ||
    id.includes("sonnet-4.6")
  );
}

const ANTHROPIC_THINKING_BUDGETS: Record<
  NonNullable<SimpleStreamOptions["reasoning"]>,
  number
> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
};

function mapReasoningToAnthropicEffort(
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
  modelId: string,
): AnthropicEffort {
  // Anthropic effort: low / medium / high / max / xhigh（按模型能力降级）。
  const supportsMax = supportsMaxAnthropicEffort(modelId);

  switch (reasoning) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      if (supportsXHighAnthropicEffort(modelId)) return "xhigh";
      return supportsMax ? "max" : "high";
    default:
      return "high";
  }
}

function resolveAnthropicThinkingRuntime(
  model: Model<any>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const maxTokens = resolveMaxTokens(options.maxTokens, model.maxTokens);
  if (!options.reasoning) {
    return {
      thinkingEnabled: false,
      mode: "disabled",
      maxTokens,
      omitDisabledThinking: isAnthropicMythosPreview(model.id),
    };
  }

  if (supportsAdaptiveAnthropicThinking(model.id)) {
    return {
      thinkingEnabled: true,
      mode: "adaptive",
      maxTokens,
      effort: mapReasoningToAnthropicEffort(options.reasoning, model.id),
      display: "summarized",
    };
  }

  let thinkingBudgetTokens = ANTHROPIC_THINKING_BUDGETS[options.reasoning];
  const adjustedMaxTokens = Math.min(maxTokens + thinkingBudgetTokens, model.maxTokens);
  if (adjustedMaxTokens <= thinkingBudgetTokens) {
    thinkingBudgetTokens = Math.max(0, adjustedMaxTokens - 1_024);
  }

  return {
    thinkingEnabled: true,
    mode: "budget",
    maxTokens: adjustedMaxTokens,
    thinkingBudgetTokens,
  };
}

function applyAnthropicThinkingPayloadOverride(
  payload: unknown,
  thinking: AnthropicThinkingRuntime,
): unknown {
  if (!isRecord(payload)) return payload;

  if (thinking.mode === "disabled" && thinking.omitDisabledThinking) {
    const { thinking: _thinking, ...rest } = payload;
    return rest;
  }

  if (thinking.mode !== "adaptive") return payload;

  const outputConfig: Record<string, unknown> = isRecord(payload.output_config)
    ? { ...payload.output_config }
    : {};
  if (thinking.effort) {
    outputConfig.effort = thinking.effort;
  }

  return {
    ...payload,
    thinking: {
      type: "adaptive",
      ...(thinking.display ? { display: thinking.display } : {}),
    },
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

function isDeepSeekAnthropicReplayModel(model: Model<any>, payload?: Record<string, unknown>) {
  const modelId = String(model.id ?? "").toLowerCase();
  const payloadModelId = String(payload?.model ?? "").toLowerCase();
  const baseUrl = String((model as { baseUrl?: unknown }).baseUrl ?? "").toLowerCase();
  return (
    modelId.includes("deepseek") ||
    payloadModelId.includes("deepseek") ||
    baseUrl.includes("deepseek")
  );
}

function hasEnabledAnthropicThinkingPayload(payload: Record<string, unknown>) {
  const thinking = payload.thinking;
  if (!isRecord(thinking)) return false;
  return thinking.type === "enabled" || thinking.type === "adaptive";
}

function isSameAnthropicReplayAssistant(
  assistant: AssistantMessage,
  model: Model<any>,
) {
  return (
    assistant.provider === model.provider &&
    assistant.api === model.api &&
    assistant.model === model.id
  );
}

function getDeepSeekReplayThinkingBlocks(
  assistant: AssistantMessage,
  payloadBlocks: unknown[],
): Array<Record<string, unknown>> {
  const existingSignatures = new Set(
    payloadBlocks.flatMap((block) => {
      if (!isRecord(block) || block.type !== "thinking") return [];
      return typeof block.signature === "string" && block.signature.trim()
        ? [block.signature]
        : [];
    }),
  );

  return assistant.content.flatMap((block) => {
    if (block.type !== "thinking") return [];
    const signature = block.thinkingSignature?.trim();
    if (!signature || existingSignatures.has(signature)) return [];
    return [{
      type: "thinking",
      thinking: block.thinking,
      signature,
    }];
  });
}

function insertThinkingBeforeFirstToolUse(
  payloadBlocks: unknown[],
  thinkingBlocks: Array<Record<string, unknown>>,
) {
  const firstToolUseIndex = payloadBlocks.findIndex(
    (block) => isRecord(block) && block.type === "tool_use",
  );
  const insertIndex = firstToolUseIndex >= 0 ? firstToolUseIndex : 0;
  return [
    ...payloadBlocks.slice(0, insertIndex),
    ...thinkingBlocks,
    ...payloadBlocks.slice(insertIndex),
  ];
}

export function repairDeepSeekAnthropicThinkingReplayPayload(
  payload: unknown,
  context: Context,
  model: Model<any>,
): unknown {
  if (!isRecord(payload)) return payload;
  if (!isDeepSeekAnthropicReplayModel(model, payload)) return payload;
  if (!hasEnabledAnthropicThinkingPayload(payload)) return payload;
  if (!Array.isArray(payload.messages)) return payload;

  const sourceAssistants = context.messages.filter(
    (message): message is AssistantMessage =>
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted",
  );
  let sourceIndex = 0;
  let changed = false;

  const messages = payload.messages.map((message) => {
    if (!isRecord(message) || message.role !== "assistant") return message;
    const sourceAssistant = sourceAssistants[sourceIndex];
    sourceIndex += 1;
    if (!sourceAssistant || !isSameAnthropicReplayAssistant(sourceAssistant, model)) {
      return message;
    }
    if (!Array.isArray(message.content)) return message;

    const hasToolUse = message.content.some(
      (block) => isRecord(block) && block.type === "tool_use",
    );
    const hasThinking = message.content.some(
      (block) => isRecord(block) && block.type === "thinking",
    );
    if (!hasToolUse || hasThinking) return message;

    const replayThinkingBlocks = getDeepSeekReplayThinkingBlocks(
      sourceAssistant,
      message.content,
    );
    if (replayThinkingBlocks.length === 0) return message;

    changed = true;
    return {
      ...message,
      content: insertThinkingBeforeFirstToolUse(
        message.content,
        replayThinkingBlocks,
      ),
    };
  });

  return changed ? { ...payload, messages } : payload;
}

function attachDeepSeekAnthropicThinkingReplayRepair(
  options: StreamOptionsEx,
  context: Context,
  model: Model<any>,
  thinking: AnthropicThinkingRuntime,
): StreamOptionsEx {
  if (!thinking.thinkingEnabled || !isDeepSeekAnthropicReplayModel(model)) {
    return options;
  }

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, streamModel) => {
      let nextPayload = repairDeepSeekAnthropicThinkingReplayPayload(
        payload,
        context,
        streamModel,
      );
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, streamModel);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      return nextPayload;
    },
  };
}

function attachAnthropicThinkingPayloadOverride(
  options: StreamOptionsEx,
  thinking: AnthropicThinkingRuntime,
): StreamOptionsEx {
  if (thinking.mode !== "adaptive" && !thinking.omitDisabledThinking) return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = applyAnthropicThinkingPayloadOverride(payload, thinking);
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }
      return nextPayload;
    },
  };
}

export function toSimpleStreamReasoning(
  reasoning: ReasoningLevel | undefined,
): SimpleStreamOptions["reasoning"] | undefined {
  return reasoning && reasoning !== "off" ? reasoning : undefined;
}

function extractStructuredErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value == null) return undefined;

  if (typeof value === "string") {
    const text = value.trim();
    return text || undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractStructuredErrorMessage(item, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }

  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["error", "message", "detail", "details", "errorMessage", "msg", "title"]) {
    const nested = extractStructuredErrorMessage(record[key], depth + 1);
    if (nested) return nested;
  }

  return undefined;
}

export function normalizeErrorMessage(rawMessage: string | undefined, fallback = "Request failed") {
  const raw = (rawMessage || "").trim();
  if (!raw) return fallback;

  const parseCandidates = [raw];
  const objectStart = raw.indexOf("{");
  if (objectStart > 0) parseCandidates.push(raw.slice(objectStart));
  const arrayStart = raw.indexOf("[");
  if (arrayStart > 0) parseCandidates.push(raw.slice(arrayStart));

  for (const candidate of parseCandidates) {
    try {
      const structured = extractStructuredErrorMessage(JSON.parse(candidate));
      if (structured) return structured;
    } catch {
      // Ignore parse failures and fall back to the raw message below.
    }
  }

  return raw;
}

function formatErrorDisplayText(rawMessage: string | undefined, fallback = "Request failed") {
  const message = normalizeErrorMessage(rawMessage, fallback);
  if (!message || message === fallback) return fallback;
  if (message.startsWith(`${fallback}：`) || message.startsWith(`${fallback}:`)) {
    return message;
  }
  return `${fallback}：${message}`;
}

function mapToolChoiceToOpenAI(
  toolChoice: ToolChoice | undefined,
): OpenAICompletionsOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "any") return "required";
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  };
}

function mapToolChoiceToGoogle(
  toolChoice: ToolChoice | undefined,
): GoogleOptions["toolChoice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "any") {
    return toolChoice;
  }
  return "auto";
}

function buildOpenAIBaseOptions(
  model: Model<any>,
  options: StreamOptionsEx,
) {
  return {
    temperature: options.temperature,
    maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
    signal: options.signal,
    apiKey: options.apiKey,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    headers: options.headers,
    onPayload: options.onPayload,
    maxRetryDelayMs: options.maxRetryDelayMs,
    metadata: options.metadata,
  };
}

function resolveMaxTokens(
  requestedMaxTokens: number | undefined,
  modelMaxTokens: number,
) {
  if (!requestedMaxTokens || requestedMaxTokens <= 0) return modelMaxTokens;
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

function normalizeSessionId(sessionId: string | undefined) {
  const value = sessionId?.trim();
  return value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildAnthropicAutomaticCacheControl(
  baseUrl: string,
  cacheRetention?: CacheRetention,
): Record<string, unknown> | undefined {
  if (!cacheRetention || cacheRetention === "none") return undefined;

  return {
    type: "ephemeral",
    ...(cacheRetention === "long" && baseUrl.includes("api.anthropic.com")
      ? { ttl: "1h" }
      : {}),
  };
}

function stripNestedAnthropicCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripNestedAnthropicCacheControl(item);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? next : value;
  }

  if (!isRecord(value)) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "cache_control") {
      changed = true;
      continue;
    }

    const stripped = stripNestedAnthropicCacheControl(nested);
    if (stripped !== nested) changed = true;
    next[key] = stripped;
  }

  return changed ? next : value;
}

function normalizeAnthropicMessagesForCaching(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== "string") {
      return message;
    }

    changed = true;
    return {
      ...message,
      content: [{
        type: "text",
        text: message.content,
      }],
    };
  });

  return changed ? next : messages;
}

function markLastCacheableAnthropicBlock(
  blocks: unknown,
  cacheControl: Record<string, unknown>,
): unknown {
  if (!Array.isArray(blocks)) return blocks;

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!isRecord(block)) continue;

    if (block.type === "thinking") continue;
    if (block.type === "text" && typeof block.text === "string" && !block.text.trim()) continue;

    const next = blocks.slice();
    next[index] = {
      ...block,
      cache_control: cacheControl,
    };
    return next;
  }

  return blocks;
}

function applyAnthropicExplicitCacheBreakpoint(
  payload: Record<string, unknown>,
  cacheControl: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedMessages = normalizeAnthropicMessagesForCaching(payload.messages);

  if (Array.isArray(normalizedMessages)) {
    for (let messageIndex = normalizedMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = normalizedMessages[messageIndex];
      if (!isRecord(message)) continue;

      const markedContent = markLastCacheableAnthropicBlock(message.content, cacheControl);
      if (markedContent === message.content) continue;

      const nextMessages = normalizedMessages.slice();
      nextMessages[messageIndex] = {
        ...message,
        content: markedContent,
      };

      return {
        ...payload,
        messages: nextMessages,
      };
    }
  }

  const markedSystem = markLastCacheableAnthropicBlock(payload.system, cacheControl);
  if (markedSystem !== payload.system) {
    return {
      ...payload,
      system: markedSystem,
    };
  }

  const markedTools = markLastCacheableAnthropicBlock(payload.tools, cacheControl);
  if (markedTools !== payload.tools) {
    return {
      ...payload,
      tools: markedTools,
    };
  }

  return normalizedMessages === payload.messages
    ? payload
    : {
        ...payload,
        messages: normalizedMessages,
      };
}

function supportsAnthropicTopLevelAutomaticCaching(baseUrl: string) {
  const normalized = baseUrl.trim().toLowerCase();
  return normalized.includes("api.anthropic.com");
}

function normalizeAnthropicPayloadMessages(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedMessages = normalizeAnthropicMessagesForCaching(payload.messages);
  return normalizedMessages === payload.messages
    ? payload
    : {
        ...payload,
        messages: normalizedMessages,
      };
}

export function attachAnthropicAutomaticCaching(
  providerId: ProviderId,
  baseUrl: string,
  options: StreamOptionsEx,
): StreamOptionsEx {
  const cacheControl = buildAnthropicAutomaticCacheControl(
    baseUrl,
    options.cacheRetention,
  );
  const previousOnPayload = options.onPayload;

  if (providerId !== "claude_code" || !cacheControl) {
    return options;
  }

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (model.api === "anthropic-messages" && isRecord(nextPayload)) {
        // Keep Anthropic payloads in a stable shape for exact-prefix matching.
        // For Anthropic-compatible proxies that ignore top-level automatic caching,
        // fall back to an explicit breakpoint on the last cacheable block.
        const sanitizedPayload = stripNestedAnthropicCacheControl(nextPayload) as Record<string, unknown>;
        nextPayload = supportsAnthropicTopLevelAutomaticCaching(baseUrl)
          ? {
              ...normalizeAnthropicPayloadMessages(sanitizedPayload),
              cache_control: cacheControl,
            }
          : applyAnthropicExplicitCacheBreakpoint(sanitizedPayload, cacheControl);
      }

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      return nextPayload;
    },
  };
}

export function resolveProviderCacheRetention(
  providerId: ProviderId,
  promptCachingEnabled?: boolean,
  override?: CacheRetention,
): CacheRetention | undefined {
  if (providerId !== "claude_code") return undefined;
  if (override) return override;
  return promptCachingEnabled === false ? "none" : "short";
}

export function buildProviderRequestMetadata(
  providerId: ProviderId,
  sessionId?: string,
): Record<string, unknown> | undefined {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (providerId !== "claude_code" || !normalizedSessionId) return undefined;
  return {
    user_id: normalizedSessionId,
  };
}

function hasOpenAIResponsesWebSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  const type = tool.type;
  return (
    type === "web_search" ||
    type === "web_search_2025_08_26" ||
    type === "web_search_preview" ||
    type === "web_search_preview_2025_03_11"
  );
}

function hasAnthropicWebSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  const type = tool.type;
  const name = tool.name;
  return (
    name === "web_search" ||
    type === "web_search_20260209" ||
    type === "web_search_20250305"
  );
}

function hasGeminiGoogleSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  return Boolean(tool.googleSearch || tool.google_search || tool.googleSearchRetrieval);
}

function appendUniqueTool(
  payload: Record<string, unknown>,
  tool: Record<string, unknown>,
  matches: (tool: unknown) => boolean,
) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.some(matches)) return payload;
  return {
    ...payload,
    tools: [...tools, tool],
  };
}

function appendGeminiGoogleSearchTool(payload: Record<string, unknown>) {
  const config = isRecord(payload.config) ? payload.config : {};
  const tools = Array.isArray(config.tools) ? config.tools : [];
  if (tools.some(hasGeminiGoogleSearchTool)) return payload;

  return {
    ...payload,
    config: {
      ...config,
      tools: [
        ...tools,
        { googleSearch: {} },
      ],
    },
  };
}

function isOpenAIWebSearchMinimalReasoningUnsupportedModel(modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  return normalized === "gpt-5" || normalized.startsWith("gpt-5-");
}

function normalizeOpenAIWebSearchReasoning(
  payload: Record<string, unknown>,
  model: Model<any>,
) {
  if (!isOpenAIWebSearchMinimalReasoningUnsupportedModel(model.id)) return payload;
  if (!isRecord(payload.reasoning) || payload.reasoning.effort !== "minimal") return payload;
  return {
    ...payload,
    reasoning: {
      ...payload.reasoning,
      effort: "low",
    },
  };
}

export function attachProviderNativeWebSearch(
  providerId: ProviderId,
  options: StreamOptionsEx,
  enabled?: boolean,
): StreamOptionsEx {
  if (!enabled) return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (!isRecord(nextPayload) || !providerSupportsNativeWebSearch(providerId, model.api)) {
        return nextPayload;
      }

      if (providerId === "codex") {
        return appendUniqueTool(
          normalizeOpenAIWebSearchReasoning(nextPayload, model),
          { type: "web_search" },
          hasOpenAIResponsesWebSearchTool,
        );
      }

      if (providerId === "claude_code") {
        return appendUniqueTool(
          nextPayload,
          { type: "web_search_20250305", name: "web_search" },
          hasAnthropicWebSearchTool,
        );
      }

      if (providerId === "gemini") {
        return appendGeminiGoogleSearchTool(nextPayload);
      }

      return nextPayload;
    },
  };
}

export function attachCodexResponsesStorage(
  providerId: ProviderId,
  options: StreamOptionsEx,
): StreamOptionsEx {
  const previousOnPayload = options.onPayload;

  if (providerId !== "codex") {
    return options;
  }

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (model.api === "openai-responses" && isRecord(nextPayload)) {
        return {
          ...nextPayload,
          store: true,
        };
      }

      return nextPayload;
    },
  };
}

export function attachPayloadDebugLogging(
  options: StreamOptionsEx,
  debugLogger?: StreamDebugLogger,
  extra?: {
    phase?: string;
    round?: number;
    sessionId?: string;
  },
): StreamOptionsEx {
  const previousOnPayload = options.onPayload;
  if (!debugLogger && !previousOnPayload) return options;

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(payload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      debugLogger?.logRequest({
        phase: extra?.phase ?? "provider_payload",
        round: extra?.round,
        sessionId: extra?.sessionId,
        api: model.api,
        provider: model.provider,
        payload: nextPayload,
      });

      return nextPayload;
    },
  };
}

export function finalizeProviderStreamOptions(params: {
  providerId: ProviderId;
  baseUrl: string;
  options: StreamOptionsEx;
  context?: Context;
  model?: Model<any>;
  workdir?: string;
  nativeWebSearch?: boolean;
  debugLogger?: StreamDebugLogger;
  extra?: {
    phase?: string;
    round?: number;
    sessionId?: string;
  };
}): StreamOptionsEx {
  let options = attachAnthropicAutomaticCaching(
    params.providerId,
    params.baseUrl,
    params.options,
  );
  options = attachCodexResponsesStorage(params.providerId, options);
  options = attachProviderNativeWebSearch(params.providerId, options, params.nativeWebSearch);
  if (params.context && params.model) {
    options = attachOpenAIResponsesNativeAttachments(options, {
      context: params.context,
      model: params.model,
      providerId: params.providerId,
      workdir: params.workdir,
    });
    options = attachAnthropicMessagesNativeAttachments(options, {
      context: params.context,
      model: params.model,
      providerId: params.providerId,
      workdir: params.workdir,
    });
    options = attachGeminiGenerativeAINativeAttachments(options, {
      context: params.context,
      model: params.model,
      providerId: params.providerId,
      workdir: params.workdir,
    });
  }
  return attachPayloadDebugLogging(options, params.debugLogger, params.extra);
}

export function toModelValue(customProviderId: string, model: string) {
  return `${customProviderId}${VALUE_SEP}${model}`;
}

export function parseModelValue(value: string): { customProviderId: string; model: string } | null {
  const idx = value.indexOf(VALUE_SEP);
  if (idx <= 0) return null;
  const customProviderId = value.slice(0, idx);
  const model = value.slice(idx + VALUE_SEP.length);
  if (!model || !customProviderId) return null;
  return { customProviderId, model };
}

export function assistantMessageToText(message: AssistantMessage) {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  if (text.trim()) return text;
  if (message.stopReason === "error") {
    return formatErrorDisplayText(message.errorMessage, "Request failed");
  }
  if (message.stopReason === "aborted") {
    return formatErrorDisplayText(message.errorMessage, "Cancelled");
  }
  return text;
}

export function createStreamingTextReconciler() {
  const emittedTextByKey = new Map<string, string>();

  return {
    appendDelta(key: string, delta: string) {
      if (!delta) return "";
      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, previous + delta);
      return delta;
    },
    reconcileFinalText(key: string, finalText: string) {
      if (!finalText) return "";

      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, finalText);

      if (!previous) {
        return finalText;
      }
      if (finalText.startsWith(previous)) {
        return finalText.slice(previous.length);
      }
      return "";
    },
  };
}

function resolveKnownModel(
  provider: "openai" | "anthropic" | "google",
  modelId: string,
  baseUrl: string,
): Model<any> | undefined {
  const known = getModel(provider as any, modelId as any) as Model<any> | undefined;
  return known?.api ? ({ ...known, baseUrl } as Model<any>) : undefined;
}

function maybeAppendGeminiApiVersion(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    let pathname = url.pathname.replace(/\/+$/, "");
    const lowerPathname = pathname.toLowerCase();
    for (const suffix of [":streamgeneratecontent", ":generatecontent"]) {
      if (lowerPathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }
    const modelsIndex = pathname.toLowerCase().lastIndexOf("/models");
    if (
      modelsIndex >= 0 &&
      (pathname.length === modelsIndex + "/models".length ||
        pathname.charAt(modelsIndex + "/models".length) === "/")
    ) {
      pathname = pathname.slice(0, modelsIndex);
    }
    if (!pathname || pathname === "/") {
      url.pathname = "/v1beta";
      return url.toString().replace(/\/+$/, "");
    }
    if (/\/v\d+(?:beta)?$/i.test(pathname)) {
      url.pathname = pathname;
      return url.toString().replace(/\/+$/, "");
    }
    url.pathname = `${pathname}/v1beta`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

function maybeAppendCodexApiVersion(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname) {
      url.pathname = "/v1";
      return url.toString().replace(/\/+$/, "");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

function supportsCodexReasoningModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    normalizedModelId.startsWith("gpt-5") ||
    normalizedModelId.includes("codex") ||
    normalizedModelId.startsWith("o1") ||
    normalizedModelId.startsWith("o3") ||
    normalizedModelId.startsWith("o4")
  );
}

function normalizeCodexBaseUrl(baseUrl: string): {
  baseUrl: string;
  preferredApi?: CodexApi;
} {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  let preferredApi: CodexApi | undefined;

  if (lower.endsWith(CODEX_CHAT_COMPLETIONS_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_CHAT_COMPLETIONS_SUFFIX.length);
    preferredApi = "openai-completions";
  } else if (lower.endsWith(CODEX_RESPONSES_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_RESPONSES_SUFFIX.length);
    preferredApi = "openai-responses";
  } else if (lower.endsWith(CODEX_RESPONSE_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_RESPONSE_SUFFIX.length);
    preferredApi = "openai-responses";
  }

  return {
    baseUrl: maybeAppendCodexApiVersion(normalized),
    preferredApi,
  };
}

function inferCodexApi(
  requestFormat?: CodexRequestFormat,
  preferredApi?: CodexApi,
): CodexApi {
  return requestFormat ?? preferredApi ?? "openai-responses";
}

type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type GeminiReasoningLevel = Exclude<NonNullable<StreamOptionsEx["reasoning"]>, "xhigh">;

function normalizeGeminiReasoning(
  reasoning: StreamOptionsEx["reasoning"] | undefined,
): GeminiReasoningLevel | undefined {
  if (reasoning === "xhigh") return "high";
  return reasoning;
}

function isGemini3ProModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

function mapGeminiThinkingLevel(
  modelId: string,
  reasoning: GeminiReasoningLevel,
): GeminiThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    return reasoning === "minimal" || reasoning === "low" ? "LOW" : "HIGH";
  }

  switch (reasoning) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
    default:
      return "HIGH";
  }
}

function mapGeminiThinkingBudget(
  modelId: string,
  reasoning: GeminiReasoningLevel,
) {
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedModelId.includes("2.5-pro")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 32_768,
    }[reasoning];
  }
  if (normalizedModelId.includes("2.5-flash")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 24_576,
    }[reasoning];
  }
  return -1;
}

function resolveGeminiThinkingRuntime(
  model: Model<any>,
  reasoning: StreamOptionsEx["reasoning"] | undefined,
): GoogleOptions["thinking"] {
  const normalizedReasoning = normalizeGeminiReasoning(reasoning);
  if (!normalizedReasoning) {
    return { enabled: false };
  }

  if (isGemini3ProModel(model.id) || isGemini3FlashModel(model.id)) {
    return {
      enabled: true,
      level: mapGeminiThinkingLevel(model.id, normalizedReasoning),
    };
  }

  return {
    enabled: true,
    budgetTokens: mapGeminiThinkingBudget(model.id, normalizedReasoning),
  };
}

export function createModelFromConfig(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string,
  requestFormat?: CodexRequestFormat,
  modelConfig?: ProviderModelConfig,
): Model<any> {
  const defaults = getProviderModelDefaults(providerId);
  const contextWindow = modelConfig?.contextWindow ?? defaults.contextWindow;
  const maxTokens = modelConfig?.maxOutputToken ?? defaults.maxOutputToken;

  if (providerId === "codex") {
    const {
      baseUrl: normalizedBaseUrl,
      preferredApi,
    } = normalizeCodexBaseUrl(baseUrl);
    const api = inferCodexApi(requestFormat, preferredApi);
    const known = resolveKnownModel("openai", modelId, normalizedBaseUrl);
    if (known && known.api === api) {
      return {
        ...known,
        contextWindow,
        maxTokens,
      };
    }

    const custom: Model<any> = {
      id: modelId,
      name: modelId,
      api,
      provider: "openai",
      baseUrl: normalizedBaseUrl,
      reasoning: supportsCodexReasoningModel(modelId),
      input: api === "openai-responses" ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
    return custom;
  }

  if (providerId === "gemini") {
    const normalizedBaseUrl = maybeAppendGeminiApiVersion(baseUrl);
    const known = resolveKnownModel("google", modelId, normalizedBaseUrl);
    if (known && known.api === "google-generative-ai") {
      return {
        ...known,
        contextWindow,
        maxTokens,
      };
    }

    const custom: Model<"google-generative-ai"> = {
      id: modelId,
      name: modelId,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: normalizedBaseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
    return custom;
  }

  const known = resolveKnownModel("anthropic", modelId, baseUrl);
  if (known) {
    return {
      ...known,
      contextWindow,
      maxTokens,
    };
  }

  const custom: Model<"anthropic-messages"> = {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  return custom;
}

export function streamSimpleByApi(
  model: Model<any>,
  context: Context,
  options: StreamOptionsEx,
) {
  switch (model.api) {
    case "anthropic-messages":
      // Anthropic：需要我们自己调用 streamAnthropic()，以便显式传 toolChoice（以及启用/禁用 thinking）。
      const anthropicThinking = resolveAnthropicThinkingRuntime(model, options);
      let anthropicOptions = attachDeepSeekAnthropicThinkingReplayRepair(
        options,
        context,
        model,
        anthropicThinking,
      );
      anthropicOptions = attachAnthropicThinkingPayloadOverride(
        anthropicOptions,
        anthropicThinking,
      );
      return streamAnthropic(model as any, context, {
        temperature: anthropicOptions.temperature,
        maxTokens: anthropicThinking.maxTokens,
        signal: anthropicOptions.signal,
        apiKey: anthropicOptions.apiKey,
        cacheRetention: anthropicOptions.cacheRetention,
        sessionId: anthropicOptions.sessionId,
        headers: anthropicOptions.headers,
        onPayload: anthropicOptions.onPayload,
        maxRetryDelayMs: anthropicOptions.maxRetryDelayMs,
        metadata: anthropicOptions.metadata,
        thinkingEnabled: anthropicThinking.thinkingEnabled,
        ...(anthropicThinking.effort ? { effort: anthropicThinking.effort as any } : {}),
        ...(anthropicThinking.thinkingBudgetTokens !== undefined
          ? { thinkingBudgetTokens: anthropicThinking.thinkingBudgetTokens }
          : {}),
        toolChoice: anthropicOptions.toolChoice ?? "none",
      });
    case "openai-completions": {
      const openAIOptions: OpenAICompletionsOptions = {
        ...buildOpenAIBaseOptions(model, options),
        toolChoice: mapToolChoiceToOpenAI(options.toolChoice),
      };
      return streamOpenAICompletions(model as any, context, openAIOptions);
    }
    case "openai-responses": {
      const openAIOptions: OpenAIResponsesOptions = {
        ...buildOpenAIBaseOptions(model, options),
        reasoningEffort: options.reasoning,
      };
      return streamOpenAIResponses(model as any, context, openAIOptions);
    }
    case "google-generative-ai": {
      const googleOptions: GoogleOptions = {
        temperature: options.temperature,
        maxTokens: resolveMaxTokens(options.maxTokens, model.maxTokens),
        signal: options.signal,
        apiKey: options.apiKey,
        headers: options.headers,
        onPayload: options.onPayload,
        maxRetryDelayMs: options.maxRetryDelayMs,
        metadata: options.metadata,
        thinking: resolveGeminiThinkingRuntime(model, options.reasoning),
        toolChoice: mapToolChoiceToGoogle(options.toolChoice) ?? "none",
      };
      return streamGoogle(model as any, context, googleOptions);
    }
    default:
      throw new Error(`Unsupported model API: ${model.api}`);
  }
}

function buildTextOnlyCallContext(
  context: Context,
  options?: { allowJsonOutput?: boolean },
): Context {
  return {
    ...context,
    systemPrompt: appendSystemPrompt(
      context.systemPrompt,
      buildTextOnlySystemSuffix(options?.allowJsonOutput),
    ),
  };
}

function buildTextOnlyStreamOptions(params: {
  providerId: ProviderId;
  runtime: ProviderRuntimeConfig;
  model: Model<any>;
  context?: Context;
  workdir?: string;
  headers: Record<string, string>;
  hostedSearchProbeId?: string;
  signal?: AbortSignal;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  nativeWebSearch?: boolean;
  debugLogger?: StreamDebugLogger;
}): StreamOptionsEx {
  const sessionId = normalizeSessionId(params.sessionId);
  const nativeWebSearch = providerSupportsNativeWebSearch(
    params.providerId,
    params.model.api,
  ) && params.nativeWebSearch;
  let options: StreamOptionsEx = {
    apiKey: params.runtime.apiKey,
    headers: withHostedSearchProbeHeader(params.headers, params.hostedSearchProbeId),
    signal: params.signal,
    sessionId,
    cacheRetention: resolveProviderCacheRetention(
      params.providerId,
      params.runtime.promptCachingEnabled,
      params.cacheRetention,
    ),
    metadata: buildProviderRequestMetadata(params.providerId, sessionId),
    reasoning:
      (params.providerId === "codex" && params.model.api === "openai-responses") ||
      (params.providerId === "claude_code" && params.model.api === "anthropic-messages") ||
      (params.providerId === "gemini" && params.model.api === "google-generative-ai")
        ? toSimpleStreamReasoning(params.runtime.reasoning)
        : undefined,
    // Text-only mode cannot execute local tools. Provider-native web search is
    // hosted by the upstream provider, so it can stay on auto when explicitly enabled.
    toolChoice: nativeWebSearch ? "auto" : "none",
  };
  return finalizeProviderStreamOptions({
    providerId: params.providerId,
    baseUrl: params.runtime.baseUrl,
    options,
    context: params.context,
    model: params.model,
    workdir: params.workdir,
    nativeWebSearch: params.nativeWebSearch,
    debugLogger: params.debugLogger,
    extra: { sessionId },
  });
}

export async function streamAssistantMessage(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  context: Context;
  workdir?: string;
  onTextDelta: (delta: string) => void;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  allowJsonOutput?: boolean;
  nativeWebSearch?: boolean;
  onHostedSearch?: (block: HostedSearchBlock) => void;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");

  const proxyRequest = await prepareProxyRequest(
    params.providerId,
    params.runtime.baseUrl.trim(),
    buildProviderAuthHeaders(params.providerId, params.runtime.apiKey),
  );

  const m = createModelFromConfig(
    params.providerId,
    modelId,
    proxyRequest.baseUrl,
    params.runtime.requestFormat,
    params.runtime.modelConfig,
  );

  const callContext = buildTextOnlyCallContext(params.context, {
    allowJsonOutput: params.allowJsonOutput,
  });
  const shouldProbeHostedSearch =
    Boolean(params.nativeWebSearch) &&
    providerSupportsNativeWebSearch(params.providerId, m.api);
  const hostedSearchProbeId = shouldProbeHostedSearch
    ? createHostedSearchProbeId(params.providerId)
    : undefined;
  const options = buildTextOnlyStreamOptions({
    providerId: params.providerId,
    runtime: params.runtime,
    model: m,
    context: callContext,
    workdir: params.workdir,
    headers: proxyRequest.headers,
    hostedSearchProbeId,
    signal: params.signal,
    sessionId: params.sessionId,
    cacheRetention: params.cacheRetention,
    nativeWebSearch: params.nativeWebSearch,
    debugLogger: params.debugLogger,
  });

  params.debugLogger?.logRequest(
    buildStreamRequestDebugPayload({
      runtime: params.runtime,
      context: callContext,
      options,
    }),
  );

  return withPowerActivity("assistant-stream", `${params.providerId}:${modelId}`, async () => {
    const orderedBlocks: HostedSearchOrderedBlock[] = [];
    const appendOrderedText = (delta: string) => {
      if (!delta) return;
      const last = orderedBlocks[orderedBlocks.length - 1];
      if (last?.kind === "text") {
        orderedBlocks[orderedBlocks.length - 1] = {
          kind: "text",
          text: last.text + delta,
        };
      } else {
        orderedBlocks.push({ kind: "text", text: delta });
      }
    };
    const upsertOrderedHostedSearch = (hostedSearch: HostedSearchBlock) => {
      const idx = orderedBlocks.findIndex(
        (block) => block.kind === "hostedSearch" && block.item.id === hostedSearch.id,
      );
      if (idx >= 0) {
        const existing = orderedBlocks[idx];
        if (existing?.kind === "hostedSearch") {
          orderedBlocks[idx] = {
            kind: "hostedSearch",
            item: mergeHostedSearchBlocks(existing.item, hostedSearch),
          };
        }
        return;
      }
      orderedBlocks.push({ kind: "hostedSearch", item: hostedSearch });
    };
    const hostedSearchAggregator = createHostedSearchEventAggregator({
      providerId: params.providerId,
      onHostedSearch: (hostedSearch) => {
        upsertOrderedHostedSearch(hostedSearch);
        params.onHostedSearch?.(hostedSearch);
      },
    });
    const hostedSearchProbe = startHostedSearchFetchProbe({
      providerId: params.providerId,
      sessionId: normalizeSessionId(params.sessionId),
      requestId: hostedSearchProbeId,
      enabled: shouldProbeHostedSearch,
      onRawEvent: hostedSearchAggregator.accept,
    });
    try {
      const s = streamSimpleByApi(m, callContext, options);
      const textReconciler = createStreamingTextReconciler();

      for await (const event of s) {
        params.debugLogger?.logResponse(event);
        if (event.type === "text_delta") {
          const delta = textReconciler.appendDelta(String(event.contentIndex), event.delta);
          if (delta) {
            appendOrderedText(delta);
            params.onTextDelta(delta);
          }
        } else if (event.type === "text_end") {
          const delta = textReconciler.reconcileFinalText(
            String(event.contentIndex),
            event.content,
          );
          if (delta) {
            appendOrderedText(delta);
            params.onTextDelta(delta);
          }
        }
      }

      let final = await s.result();
      if (final.stopReason === "error" || final.stopReason === "aborted") {
        throw new Error(
          normalizeErrorMessage(
            final.errorMessage,
            final.stopReason === "aborted" ? "Cancelled" : "Request failed",
          ),
        );
      }

      await hostedSearchProbe.finish();
      final = appendHostedSearchBlocksToAssistant(
        final as AssistantMessage & { content: unknown[] },
        hostedSearchAggregator.complete(),
        { orderedBlocks },
      ) as AssistantMessage;
      params.debugLogger?.logResult(final);
      await params.debugLogger?.flush();
      return final;
    } catch (error) {
      await hostedSearchProbe.finish();
      if (params.signal?.aborted) {
        hostedSearchAggregator.dispose();
      } else {
        hostedSearchAggregator.fail();
      }
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    }
  });
}

export async function completeAssistantMessage(params: {
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  context: Context;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  signal?: AbortSignal;
  debugLogger?: StreamDebugLogger;
  allowJsonOutput?: boolean;
}) {
  const modelId = params.model.trim();
  if (!modelId) throw new Error("No model selected");
  if (!params.runtime.baseUrl.trim()) throw new Error("Base URL cannot be empty");
  if (!params.runtime.apiKey.trim()) throw new Error("API Key cannot be empty");

  const proxyRequest = await prepareProxyRequest(
    params.providerId,
    params.runtime.baseUrl.trim(),
    buildProviderAuthHeaders(params.providerId, params.runtime.apiKey),
  );

  const m = createModelFromConfig(
    params.providerId,
    modelId,
    proxyRequest.baseUrl,
    params.runtime.requestFormat,
    params.runtime.modelConfig,
  );

  const callContext = buildTextOnlyCallContext(params.context, {
    allowJsonOutput: params.allowJsonOutput,
  });
  const options = buildTextOnlyStreamOptions({
    providerId: params.providerId,
    runtime: params.runtime,
    model: m,
    context: callContext,
    headers: proxyRequest.headers,
    signal: params.signal,
    sessionId: params.sessionId,
    cacheRetention: params.cacheRetention,
    debugLogger: params.debugLogger,
  });

  params.debugLogger?.logRequest(
    buildStreamRequestDebugPayload({
      runtime: params.runtime,
      context: callContext,
      options,
    }),
  );

  return withPowerActivity("assistant-complete", `${params.providerId}:${modelId}`, async () => {
    try {
      const s = streamSimpleByApi(m, callContext, options);
      const final = await s.result();

      if (final.stopReason === "error" || final.stopReason === "aborted") {
        throw new Error(
          normalizeErrorMessage(
            final.errorMessage,
            final.stopReason === "aborted" ? "Cancelled" : "Request failed",
          ),
        );
      }

      params.debugLogger?.logResult(final);
      await params.debugLogger?.flush();
      return final;
    } catch (error) {
      params.debugLogger?.logError(error);
      await params.debugLogger?.flush();
      throw error;
    }
  });
}
