/**
 * Copyright 2026 Rakuten Group, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenTelemetry instrumentation for the Prompt API playground.
 *
 * Spans follow the OpenTelemetry GenAI semantic conventions and go to a local
 * MLflow server over OTLP/HTTP JSON. MLflow reads `gen_ai.*` natively, so no
 * collector is needed.
 *
 * Conventions transcribed from open-telemetry/semantic-conventions-genai at
 * commit 67dff02 (2026-08-27). See README for the reasoning behind each
 * mapping choice.
 */

import { trace, context, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

// --- Tweak here ------------------------------------------------------------

const MLFLOW_TRACKING_URI = "http://localhost:5000";
/** Required OTLP header — default experiment (see mlflow/server/otel_api.py). */
const MLFLOW_DEFAULT_EXPERIMENT_ID = "0";

/** Set to false to keep prompts and responses out of exported spans. */
const CAPTURE_CONTENT = true;

/**
 * No registry value exists for browser built-in models. This names the
 * implementation supplying the model, not the API, so change it on other
 * browsers.
 */
const PROVIDER_NAME = "google.chrome";

// --- Semantic conventions --------------------------------------------------

const GEN_AI = {
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_STREAM: "gen_ai.request.stream",
  OUTPUT_TYPE: "gen_ai.output.type",
  INPUT_MESSAGES: "gen_ai.input.messages",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  TIME_TO_FIRST_CHUNK: "gen_ai.response.time_to_first_chunk",
  FINISH_REASONS: "gen_ai.response.finish_reasons",
  CONVERSATION_ID: "gen_ai.conversation.id",
  CONVERSATION_COMPACTED: "gen_ai.conversation.compacted",
};

/**
 * Prompt API concepts no OTel convention covers, namespaced so they cannot
 * collide with a future standard name. The context values are session-context
 * measurements in context-window units, not per-request token usage, so they
 * deliberately do not map onto `gen_ai.usage.*`.
 */
const WEB_AI = {
  BROWSER_NAME: "web_ai.runtime.browser.name",
  BROWSER_VERSION: "web_ai.runtime.browser.version",
  /** Coarse RAM hint from the Device Memory API (`navigator.deviceMemory`), in GiB. */
  DEVICE_MEMORY_GIB: "web_ai.runtime.device_memory_gib",
  CONTEXT_WINDOW: "web_ai.context.window_tokens",
  CONTEXT_USAGE_BEFORE: "web_ai.context.usage_before_tokens",
  CONTEXT_USAGE_AFTER: "web_ai.context.usage_after_tokens",
  CONTEXT_USAGE_DELTA: "web_ai.context.usage_delta_tokens",
  CONTEXT_REMAINING_AFTER: "web_ai.context.remaining_after_tokens",
  CONTEXT_UTILIZATION_AFTER: "web_ai.context.utilization_after",
  CONTEXT_OVERFLOWED: "web_ai.context.overflowed",
  CHUNK_COUNT: "web_ai.stream.chunk_count",
  TURN_INDEX: "web_ai.conversation.turn_index",
  SAMPLING_MODE: "web_ai.request.sampling_mode",
  SESSION_EXPECTED_INPUTS: "web_ai.session.expected_inputs",
  SESSION_EXPECTED_OUTPUTS: "web_ai.session.expected_outputs",
};

const ERROR_TYPE = "error.type";
const SESSION_ID = "session.id";

/**
 * MLflow's trace-table preview (mlflow/tracing/utils/truncation.py) understands
 * OpenAI-shaped `{messages: [{role, content}]}` on mlflow.spanInputs/Outputs,
 * not GenAI `parts` arrays. Set these alongside gen_ai.* so the Response column
 * shows plain text; span detail still uses the GenAI attributes.
 */
const MLFLOW_INPUTS = "mlflow.spanInputs";
const MLFLOW_OUTPUTS = "mlflow.spanOutputs";

/**
 * The spec's span name is `{operation} {request.model}`, but the Prompt API
 * exposes no model identifier, so the model half is omitted rather than
 * invented. Same reason `gen_ai.request.model`, `gen_ai.response.model` and
 * `gen_ai.usage.*` are never set below.
 */
const OPERATION = "generate_content";

const TRACER_NAME = "prompt-api-observability";
const TRACER_VERSION = "0.2.0";

let currentProvider = null;
let tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);

/** Spans that already received overflow event/attrs (listener + reconcile may both run). */
const overflowRecordedSpans = new WeakSet();

// --- Setup -----------------------------------------------------------------

/** GREASE noise entries: "Not;A=Brand" and its rotating punctuation variants. */
const isRealBrand = (b) =>
  b.brand.replace(/[^a-z]/gi, "").toLowerCase() !== "notabrand";

/** Prefer the specific brand over the "Chromium" engine entry. */
const pickBrand = (brands = []) => {
  const real = brands.filter(isRealBrand);
  return real.find((b) => !/^chromium$/i.test(b.brand)) ?? real[0];
};

/**
 * Stable runtime identity for the page load. OTel resource attributes; MLflow
 * stores them as trace tags (not span attributes). Per-prompt data stays on spans.
 */
async function browserResourceAttributes() {
  const attributes = {
    "browser.language": navigator.language,
    "user_agent.original": navigator.userAgent,
  };

  const deviceMemory = navigator.deviceMemory;
  if (Number.isFinite(deviceMemory)) {
    attributes[WEB_AI.DEVICE_MEMORY_GIB] = deviceMemory;
  }

  const uaData = navigator.userAgentData;
  // No UA Client Hints: don't regex the UA string, and per the convention don't
  // fall back to the legacy navigator.platform.
  if (!uaData) return attributes;

  attributes["browser.brands"] = uaData.brands.map(
    (b) => `${b.brand} ${b.version}`,
  );
  attributes["browser.mobile"] = uaData.mobile;
  attributes["browser.platform"] = uaData.platform;

  let brand = pickBrand(uaData.brands);
  try {
    const { fullVersionList } = await uaData.getHighEntropyValues([
      "fullVersionList",
    ]);
    brand = pickBrand(fullVersionList) ?? brand;
  } catch {
    // Keep the low-entropy major version.
  }
  if (brand) {
    attributes[WEB_AI.BROWSER_NAME] = brand.brand;
    attributes[WEB_AI.BROWSER_VERSION] = brand.version;
  }
  return attributes;
}

/** @param {{ serviceName?: string, otlpUrl?: string, otlpHeaders?: Record<string,string> }} opts */
export async function initTelemetry(opts = {}) {
  const {
    serviceName = TRACER_NAME,
    otlpUrl = `${MLFLOW_TRACKING_URI}/v1/traces`,
    otlpHeaders = { "x-mlflow-experiment-id": MLFLOW_DEFAULT_EXPERIMENT_ID },
  } = opts;

  if (currentProvider) {
    try {
      await currentProvider.shutdown();
    } catch (err) {
      console.warn("[telemetry] shutdown failed:", err);
    }
    currentProvider = null;
  }

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      ...(await browserResourceAttributes()),
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: otlpUrl, headers: otlpHeaders }),
      ),
    ],
  });

  provider.register();
  currentProvider = provider;
  tracer = provider.getTracer(TRACER_NAME, TRACER_VERSION);

  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") provider.forceFlush();
  });
  addEventListener("pagehide", () => provider.forceFlush());

  return provider;
}

export async function flushTelemetry() {
  if (!currentProvider) return;
  try {
    await currentProvider.forceFlush();
  } catch (err) {
    console.warn("[telemetry] forceFlush failed:", err);
  }
}

// --- Message encoding ------------------------------------------------------

/**
 * `gen_ai.{input,output}.messages` and `gen_ai.system_instructions` follow the
 * GenAI message JSON schemas. They are written as JSON strings because
 * OpenTelemetry JS has no structured attribute support and the spec permits
 * the fallback (see README).
 */
function encodeInputMessages(input) {
  if (typeof input === "string") {
    return [{ role: "user", parts: [{ type: "text", content: input }] }];
  }
  const messages = Array.isArray(input) ? input : [input];
  return messages.map((message) => ({
    role: message.role ?? "user",
    parts: encodeParts(message.content),
  }));
}

function encodeParts(content) {
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return [];

  return content.map((part) =>
    part.type === "text"
      ? { type: "text", content: String(part.value) }
      : // Never export image or audio bytes. This is a GenericPart, which needs
        // only `type`; a BlobPart would require inline base64 content.
        { type: "redacted", modality: part.type },
  );
}

/** `finish_reason` is required by the output message schema. */
const encodeOutputMessages = (text, finishReason) => [
  {
    role: "assistant",
    parts: [{ type: "text", content: text }],
    finish_reason: finishReason,
  },
];

/** Flatten GenAI message parts to plain text for MLflow list previews. */
function textFromGenAiMessages(messages) {
  const lines = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.content) lines.push(part.content);
    }
  }
  return lines.join("\n");
}

/** OpenAI-shaped JSON for MLflow request/response preview columns. */
function mlflowChatPreview(role, text) {
  return JSON.stringify({ messages: [{ role, content: text }] });
}

/**
 * MLflow session grouping: `session.id` / `gen_ai.conversation.id` on spans
 * (not resource — ids are assigned per LanguageModel session).
 */
function mlflowSessionAttributes(conversationId, sessionId) {
  return {
    [GEN_AI.CONVERSATION_ID]: conversationId,
    [SESSION_ID]: sessionId,
  };
}

/** Plain text from GenAI system-instruction parts. */
function textFromSystemInstructions(parts) {
  return parts
    .map((part) => (part.type === "text" ? part.content : ""))
    .filter(Boolean)
    .join("\n");
}

// --- Context measurements --------------------------------------------------

/** `contextWindow` is current; `inputQuota` is the deprecated spelling. */
function readContextWindow(session) {
  const value = session.contextWindow ?? session.inputQuota;
  return Number.isFinite(value) ? value : undefined;
}

/** `contextUsage` is current; `inputUsage` is the deprecated spelling. */
function readContextUsage(session) {
  const value = session.contextUsage ?? session.inputUsage;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Per-turn context measurements on inference spans. Window size is stable for
 * the session and is recorded only on `web_ai.create_session`.
 */
function contextAttributes(windowTokens, before, after) {
  const attributes = {};
  if (before !== undefined) attributes[WEB_AI.CONTEXT_USAGE_BEFORE] = before;
  if (after === undefined) return attributes;

  attributes[WEB_AI.CONTEXT_USAGE_AFTER] = after;
  if (before !== undefined) {
    attributes[WEB_AI.CONTEXT_USAGE_DELTA] = after - before;
  }
  if (windowTokens !== undefined) {
    attributes[WEB_AI.CONTEXT_REMAINING_AFTER] = windowTokens - after;
    attributes[WEB_AI.CONTEXT_UTILIZATION_AFTER] = after / windowTokens;
  }
  return attributes;
}

/** GenAI system-instructions schema from Prompt API `initialPrompts`. */
function encodeSystemInstructions(initialPrompts) {
  const parts = [];
  for (const message of initialPrompts) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") {
      parts.push({ type: "text", content: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({
            type: "text",
            content: String(part.value ?? part.content),
          });
        }
      }
    }
  }
  return parts.length ? parts : undefined;
}

// --- Instrumentation -------------------------------------------------------

/** `LanguageModel.create()` options for the web_ai.create_session span. */
function createSessionAttributes(options = {}) {
  const attributes = {};

  if (options.expectedInputs?.length) {
    attributes[WEB_AI.SESSION_EXPECTED_INPUTS] = JSON.stringify(
      options.expectedInputs,
    );
  }
  if (options.expectedOutputs?.length) {
    attributes[WEB_AI.SESSION_EXPECTED_OUTPUTS] = JSON.stringify(
      options.expectedOutputs,
    );
  }
  if (options.samplingMode) {
    attributes[WEB_AI.SAMPLING_MODE] = options.samplingMode;
  }

  if (CAPTURE_CONTENT && options.initialPrompts?.length) {
    const instructions = encodeSystemInstructions(options.initialPrompts);
    if (instructions) {
      attributes[GEN_AI.SYSTEM_INSTRUCTIONS] = JSON.stringify(instructions);
      const text = textFromSystemInstructions(instructions);
      if (text) {
        // Session Input preview uses the first trace (create_session); show the system
        // prompt because there is no user message yet. role=system — MLflow looks for
        // user first, then falls back to the last message in the preview JSON.
        attributes[MLFLOW_INPUTS] = mlflowChatPreview("system", text);
      }
    }
  }

  return attributes;
}

/**
 * Creates a `LanguageModel` session and wraps it.
 *
 * `conversationId` is passed separately from the Prompt API options so it is
 * never forwarded to `LanguageModel.create()` and never reaches the model.
 *
 * @param {any} options Passed verbatim to `LanguageModel.create()`.
 * @param {{ conversationId?: string, sessionId?: string }} telemetryOptions
 */
export async function createInstrumentedSession(
  options = {},
  telemetryOptions = {},
) {
  /**
   * One id per LanguageModel session, which is the thing that owns the
   * conversation history. Reused for every turn — never regenerated per span,
   * never the trace id, never derived from prompt content.
   */
  const conversationId = telemetryOptions.conversationId ?? crypto.randomUUID();
  /**
   * MLflow groups traces by `session.id` into one conversation. A new Prompt
   * API session (`LanguageModel.create`) starts a new conversation, so assign
   * a fresh id here — not persisted across reloads or reused across creates.
   */
  const sessionId = telemetryOptions.sessionId ?? conversationId;

  // Not a GenAI inference span: creating a session generates nothing.
  const span = tracer.startSpan("web_ai.create_session", {
    kind: SpanKind.INTERNAL,
    attributes: {
      ...mlflowSessionAttributes(conversationId, sessionId),
      ...createSessionAttributes(options),
    },
  });

  try {
    const session = await LanguageModel.create(options);
    const windowTokens = readContextWindow(session);
    if (windowTokens !== undefined) {
      span.setAttribute(WEB_AI.CONTEXT_WINDOW, windowTokens);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    return wrapSession(session, { conversationId, sessionId });
  } catch (err) {
    recordError(span, err);
    throw err;
  } finally {
    span.end();
    // BatchSpanProcessor may not export until the next interval; flush so
    // create_session is visible in MLflow right after load or reset.
    await flushTelemetry();
  }
}

function wrapSession(session, meta) {
  const state = {
    ...meta,
    turnIndex: 0,
    compacted: false,
    activeSpans: new Set(),
    /** Turn that overflowed when no span was active (event fired after span.end). */
    overflowTurnIndex: undefined,
  };

  const onContextOverflow = () => {
    state.compacted = true;
    if (state.activeSpans.size === 0) {
      // Chrome may fire after the stream completes; attach on that turn's span in finally.
      state.overflowTurnIndex = state.turnIndex;
    }
    // Event + attrs are recorded in reconcileContextOverflow (with usage details for MLflow UI).
  };

  // `contextoverflow` means the browser dropped earlier turns to fit the
  // window, which is what gen_ai.conversation.compacted describes. It stays
  // true for every later turn on this conversation.
  session.addEventListener?.("contextoverflow", onContextOverflow);
  // Deprecated spelling still used in some extension builds.
  session.addEventListener?.("quotaoverflow", onContextOverflow);

  return new Proxy(session, {
    get(target, prop) {
      if (prop === "prompt") {
        return (input, opts) => tracedPrompt(target, state, input, opts);
      }
      if (prop === "promptStreaming") {
        return (input, opts) =>
          tracedPromptStreaming(target, state, input, opts);
      }
      if (prop === "destroy") {
        return () => {
          try {
            return target.destroy();
          } finally {
            const destroySpan = tracer.startSpan("web_ai.destroy_session", {
              kind: SpanKind.INTERNAL,
              attributes: mlflowSessionAttributes(
                state.conversationId,
                state.sessionId,
              ),
            });
            destroySpan.end();
          }
        };
      }
      // Native getters (contextWindow, contextUsage, …) need the real session as
      // `this`; using the Proxy as receiver throws "Illegal invocation".
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Span event + attrs when the Prompt API compacts conversation history. */
function recordContextOverflow(span, before, after) {
  if (overflowRecordedSpans.has(span)) return;
  overflowRecordedSpans.add(span);
  const eventAttrs = {
    [WEB_AI.CONTEXT_OVERFLOWED]: true,
    [GEN_AI.CONVERSATION_COMPACTED]: true,
  };
  if (before !== undefined) eventAttrs[WEB_AI.CONTEXT_USAGE_BEFORE] = before;
  if (after !== undefined) eventAttrs[WEB_AI.CONTEXT_USAGE_AFTER] = after;
  if (before !== undefined && after !== undefined) {
    eventAttrs[WEB_AI.CONTEXT_USAGE_DELTA] = after - before;
  }
  // MLflow's Events tab only renders events that carry attributes (empty events are stored but invisible).
  span.addEvent("web_ai.context_overflow", eventAttrs);
  span.setAttribute(WEB_AI.CONTEXT_OVERFLOWED, true);
  span.setAttribute(GEN_AI.CONVERSATION_COMPACTED, true);
}

/**
 * Overflow may fire after span.end (activeSpans empty). Reconcile in finally
 * using the turn index and/or a usage drop (compaction freed tokens).
 */
function reconcileContextOverflow(span, state, turnIndex, before, after) {
  const usageDropped =
    before !== undefined && after !== undefined && after < before;

  if (state.overflowTurnIndex === turnIndex) {
    state.compacted = true;
    recordContextOverflow(span, before, after);
    state.overflowTurnIndex = undefined;
    return;
  }
  if (usageDropped) {
    state.compacted = true;
    recordContextOverflow(span, before, after);
  }
}

/** Attributes known before the model runs. Set at creation so samplers see them. */
function requestAttributes(session, state, input, opts, streaming) {
  state.turnIndex += 1;

  const attributes = {
    [GEN_AI.OPERATION_NAME]: OPERATION,
    [GEN_AI.PROVIDER_NAME]: PROVIDER_NAME,
    ...mlflowSessionAttributes(state.conversationId, state.sessionId),
    [WEB_AI.TURN_INDEX]: state.turnIndex,
  };

  if (streaming) attributes[GEN_AI.REQUEST_STREAM] = true;
  if (opts?.responseConstraint) attributes[GEN_AI.OUTPUT_TYPE] = "json";
  // Never written as false: the convention treats it as a positive indicator
  // only and requires it left unset otherwise.
  if (state.compacted) attributes[GEN_AI.CONVERSATION_COMPACTED] = true;

  if (CAPTURE_CONTENT) {
    const inputMessages = encodeInputMessages(input);
    attributes[GEN_AI.INPUT_MESSAGES] = JSON.stringify(inputMessages);
    const previewText =
      typeof input === "string" ? input : textFromGenAiMessages(inputMessages);
    if (previewText) {
      attributes[MLFLOW_INPUTS] = mlflowChatPreview("user", previewText);
    }
  }

  return attributes;
}

/** Attributes known once the call settled. */
function resultAttributes(
  session,
  state,
  windowTokens,
  before,
  text,
  finish,
  after = readContextUsage(session),
) {
  const attributes = {
    ...contextAttributes(windowTokens, before, after),
    [GEN_AI.FINISH_REASONS]: [finish],
  };
  if (state.compacted) attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  if (
    before !== undefined &&
    after !== undefined &&
    after < before
  ) {
    attributes[WEB_AI.CONTEXT_OVERFLOWED] = true;
    attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  }
  if (CAPTURE_CONTENT && text !== undefined) {
    attributes[GEN_AI.OUTPUT_MESSAGES] = JSON.stringify(
      encodeOutputMessages(text, finish),
    );
    attributes[MLFLOW_OUTPUTS] = mlflowChatPreview("assistant", text);
  }
  return attributes;
}

function recordError(span, err) {
  span.recordException(err);
  span.setAttribute(ERROR_TYPE, err?.name ?? "Error");
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: String(err?.message ?? err),
  });
}

/** Separates `AbortSignal` cancellation from a real failure. */
const finishReasonFor = (err) =>
  err?.name === "AbortError" ? "abort" : "error";

/**
 * INTERNAL, not CLIENT: the model runs in the same process. The convention
 * reserves CLIENT for calls crossing a process boundary and explicitly permits
 * INTERNAL for in-process models.
 */
const SPAN_OPTIONS = { kind: SpanKind.INTERNAL };

async function tracedPrompt(session, state, input, opts) {
  const windowTokens = readContextWindow(session);
  const before = readContextUsage(session);
  const attributes = requestAttributes(session, state, input, opts, false);
  const turnIndex = state.turnIndex;

  return tracer.startActiveSpan(
    OPERATION,
    { ...SPAN_OPTIONS, attributes },
    async (span) => {
      state.activeSpans.add(span);
      try {
        const text = await session.prompt(input, opts);
        const after = readContextUsage(session);
        reconcileContextOverflow(span, state, turnIndex, before, after);
        span.setAttributes(
          resultAttributes(session, state, windowTokens, before, text, "stop", after),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return text;
      } catch (err) {
        const after = readContextUsage(session);
        reconcileContextOverflow(span, state, turnIndex, before, after);
        span.setAttributes(
          // No text: the response never completed.
          resultAttributes(
            session,
            state,
            windowTokens,
            before,
            undefined,
            finishReasonFor(err),
            after,
          ),
        );
        recordError(span, err);
        throw err;
      } finally {
        state.activeSpans.delete(span);
        span.end();
      }
    },
  );
}

function tracedPromptStreaming(session, state, input, opts) {
  const windowTokens = readContextWindow(session);
  const before = readContextUsage(session);
  const attributes = requestAttributes(session, state, input, opts, true);
  const turnIndex = state.turnIndex;

  const span = tracer.startSpan(
    OPERATION,
    { ...SPAN_OPTIONS, attributes },
    context.active(),
  );
  state.activeSpans.add(span);

  const startedAt = performance.now();
  let firstChunkAt = null;
  let chunkCount = 0;
  let text = "";

  // One span for the whole stream: it stays open until the stream is fully
  // consumed or fails.
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of session.promptStreaming(input, opts)) {
          chunkCount += 1;
          if (firstChunkAt === null) firstChunkAt = performance.now();
          text += chunk;
          controller.enqueue(chunk);
        }
        const after = readContextUsage(session);
        reconcileContextOverflow(span, state, turnIndex, before, after);
        span.setAttributes(
          resultAttributes(session, state, windowTokens, before, text, "stop", after),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        controller.close();
      } catch (err) {
        const after = readContextUsage(session);
        reconcileContextOverflow(span, state, turnIndex, before, after);
        // Keep the partial text: seeing where generation stopped is the point.
        span.setAttributes(
          resultAttributes(
            session,
            state,
            windowTokens,
            before,
            text,
            finishReasonFor(err),
            after,
          ),
        );
        recordError(span, err);
        controller.error(err);
      } finally {
        span.setAttribute(WEB_AI.CHUNK_COUNT, chunkCount);
        if (firstChunkAt !== null) {
          // Seconds, per the convention.
          span.setAttribute(
            GEN_AI.TIME_TO_FIRST_CHUNK,
            (firstChunkAt - startedAt) / 1000,
          );
        }
        state.activeSpans.delete(span);
        span.end();
      }
    },
  });
}
