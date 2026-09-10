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
  TOOL_DEFINITIONS: "gen_ai.tool.definitions",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_DESCRIPTION: "gen_ai.tool.description",
  TOOL_TYPE: "gen_ai.tool.type",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  /**
   * Opt-in in the spec, so both are gated on CAPTURE_CONTENT. The spec asks for
   * a structured object and allows a JSON string where the format cannot carry
   * one, which is the case for OTel span attributes.
   */
  TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
  TOOL_CALL_RESULT: "gen_ai.tool.call.result",
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
  TOOL_COUNT: "web_ai.tool.count",
  TOOL_NAMES: "web_ai.tool.names",
  TOOL_CALL_COUNT: "web_ai.tool.call_count",
  TOOL_CALL_NAMES: "web_ai.tool.call_names",
  TOOL_RESPONSE_COUNT: "web_ai.tool.response_count",
  TOOL_CALL_INDEX: "web_ai.tool.call_index",
  TURN_CONTINUATION: "web_ai.conversation.turn_continuation",
  EXCHANGE_TURN_COUNT: "web_ai.exchange.turn_count",
  EXCHANGE_TOOL_CALL_COUNT: "web_ai.exchange.tool_call_count",
  EXCHANGE_ABANDONED: "web_ai.exchange.abandoned",
};

const ERROR_TYPE = "error.type";
const SESSION_ID = "session.id";

/**
 * MLflow's trace-table preview (mlflow/tracing/utils/truncation.py) understands
 * OpenAI-shaped `{messages: [...]}` on mlflow.spanInputs/Outputs, not GenAI
 * `parts` arrays. Always set alongside gen_ai.*; see mlflowChatPreview.
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
const OPERATION_INVOKE_AGENT = "invoke_agent";
const OPERATION_EXECUTE_TOOL = "execute_tool";
const TOOL_TYPE_FUNCTION = "function";
const FINISH_STOP = "stop";
const FINISH_TOOL_CALL = "tool_call";
const MAX_ATTRIBUTE_LENGTH = 8192;

const TRACER_NAME = "prompt-api-observability";
const TRACER_VERSION = "0.3.0";

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

function truncateAttribute(value, max = MAX_ATTRIBUTE_LENGTH) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

// --- Tool traffic ----------------------------------------------------------

/** Tool objects keep fields on the prototype; read each one by name. */
function fieldsOf(value) {
  if (value === null || typeof value !== "object") return;
  return value;
}

function stringField(fields, key) {
  const value = fields[key];
  return typeof value === "string" ? value : undefined;
}

function readToolCall(value) {
  const fields = fieldsOf(value);
  const name = fields && stringField(fields, "name");
  if (!(fields && name)) return;
  return {
    id: stringField(fields, "callID") ?? "",
    name,
    arguments: fields.arguments,
  };
}

function readToolResult(value) {
  if (!Array.isArray(value)) return value ?? undefined;
  return value.map((entry) => {
    const fields = fieldsOf(entry);
    return fields ? { type: fields.type, value: fields.value } : entry;
  });
}

function readToolResponse(value) {
  const fields = fieldsOf(value);
  const name = fields && stringField(fields, "name");
  if (!(fields && name)) return;

  const id = stringField(fields, "callID") ?? "";
  const errorMessage = stringField(fields, "errorMessage");
  if (errorMessage !== undefined) {
    return { id, name, errorMessage };
  }
  return { id, name, result: readToolResult(fields.result) };
}

function toolCallFromChunk(chunk) {
  const fields = fieldsOf(chunk);
  if (fields?.type !== "tool-call") return;
  return readToolCall(fields.value);
}

function collectToolPart(part, traffic) {
  const fields = fieldsOf(part);
  if (!fields) return;
  if (fields.type === "tool-call") {
    const call = readToolCall(fields.value);
    if (call) traffic.calls.push(call);
    return;
  }
  if (fields.type === "tool-response") {
    const response = readToolResponse(fields.value);
    if (response) traffic.responses.push(response);
  }
}

function toolTrafficFrom(input) {
  const traffic = { calls: [], responses: [] };
  if (typeof input === "string" || !input) return traffic;

  const messages = Array.isArray(input) ? input : [input];
  for (const message of messages) {
    const content = fieldsOf(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      collectToolPart(part, traffic);
    }
  }
  return traffic;
}

function readAssistantTurn(output) {
  if (typeof output === "string") {
    return { text: output, toolCalls: [] };
  }
  if (!Array.isArray(output)) {
    return { text: "", toolCalls: [] };
  }

  const turn = { text: "", toolCalls: [] };
  for (const part of output) {
    const fields = fieldsOf(part);
    if (!fields) continue;
    if (fields.type === "text") {
      turn.text += String(fields.value ?? "");
      continue;
    }
    const call = toolCallFromChunk(fields);
    if (call) turn.toolCalls.push(call);
  }
  return turn;
}

function toolCallPart(call) {
  const part = { type: "tool_call", name: call.name };
  if (call.id) part.id = call.id;
  if (call.arguments !== undefined) part.arguments = call.arguments;
  return part;
}

function toolResponsePartEncoded(response) {
  const part = { type: "tool_call_response", name: response.name };
  if (response.id) part.id = response.id;
  if (response.errorMessage === undefined) {
    part.response = response.result;
  } else {
    part.error = response.errorMessage;
  }
  return part;
}

function encodePart(part) {
  if (part.type === "text") {
    return { type: "text", content: String(part.value) };
  }
  if (part.type === "tool-call") {
    const call = readToolCall(part.value);
    if (call) return toolCallPart(call);
  }
  if (part.type === "tool-response") {
    const response = readToolResponse(part.value);
    if (response) return toolResponsePartEncoded(response);
  }
  return { type: "redacted", modality: part.type };
}

function encodeParts(content) {
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return [];
  return content.map(encodePart);
}

/** `finish_reason` is required by the output message schema. */
function encodeOutputMessages(output, finishReason) {
  const parts =
    typeof output === "string"
      ? [{ type: "text", content: output }]
      : [
          ...(output.text ? [{ type: "text", content: output.text }] : []),
          ...output.toolCalls.map(toolCallPart),
        ];
  return [{ role: "assistant", parts, finish_reason: finishReason }];
}

function mlflowToolCall(part) {
  const call = {
    type: TOOL_TYPE_FUNCTION,
    // OpenAI carries arguments as a JSON string, not as an object.
    function: { name: part.name, arguments: safeJson(part.arguments ?? {}) },
  };
  if (part.id) call.id = part.id;
  return call;
}

/** A result is its own message here, whatever role the Prompt API used. */
function mlflowToolMessage(part) {
  const message = {
    role: "tool",
    content: safeJson(part.error === undefined ? part.response : part.error),
  };
  if (part.id) message.tool_call_id = part.id;
  return message;
}

/** Splits one message's parts into the pieces the OpenAI shape needs. */
function shapeParts(parts) {
  const shaped = { text: [], toolCalls: [], toolMessages: [] };
  for (const part of parts) {
    if (part.type === "text") {
      shaped.text.push(part.content);
    } else if (part.type === "tool_call") {
      shaped.toolCalls.push(mlflowToolCall(part));
    } else if (part.type === "tool_call_response") {
      shaped.toolMessages.push(mlflowToolMessage(part));
    } else {
      // Enough to show the turn carried an image or audio, never the value.
      shaped.text.push(`[${part.modality}]`);
    }
  }
  return shaped;
}

function openAiMessages(message) {
  const { text, toolCalls, toolMessages } = shapeParts(message.parts ?? []);
  if (text.length === 0 && toolCalls.length === 0) return toolMessages;

  const entry = { role: message.role, content: text.join("\n") || null };
  if (toolCalls.length > 0) entry.tool_calls = toolCalls;
  return [...toolMessages, entry];
}

/**
 * Re-shapes GenAI messages as OpenAI chat messages for MLflow.
 *
 * MLflow reads mlflow.spanInputs/Outputs both for the trace-table preview
 * columns and for a span's "Pretty" view. Left unset it derives them from the
 * GenAI attributes and then renders the derived copy alongside the original, so
 * every message appears twice; setting them here is what keeps a turn rendering
 * once. Tool calls and results have to come across too, or the turns that carry
 * nothing but tool traffic preview as blank.
 */
function mlflowChatPreview(messages) {
  const chat = messages.flatMap(openAiMessages);
  return chat.length > 0
    ? truncateAttribute(JSON.stringify({ messages: chat }))
    : undefined;
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

// --- Span timing -----------------------------------------------------------

/**
 * Epoch milliseconds for every timestamp this module sets by hand.
 *
 * Left alone, the SDK starts a span from `Date.now()`, which is whole
 * milliseconds, and derives its end from the monotonic clock. That is enough
 * for a span timed in one place, but an exchange is timed across several
 * calls: at millisecond granularity a fast tool collapses into a zero-length
 * span that starts on the same tick as the turn it precedes, and siblings
 * sharing a start have no order left for a trace viewer to show. Taking every
 * hand-set timestamp from the monotonic clock instead keeps a tool run
 * sub-millisecond and strictly between the turns it sits between.
 */
const spanTimestamp = () => performance.timeOrigin + performance.now();

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

  if (options.tools?.length) {
    attributes[WEB_AI.TOOL_COUNT] = options.tools.length;
    attributes[WEB_AI.TOOL_NAMES] = options.tools.map((tool) => tool.name);
    if (CAPTURE_CONTENT) {
      attributes[GEN_AI.TOOL_DEFINITIONS] = truncateAttribute(
        JSON.stringify(
          options.tools.map(({ name, description, inputSchema }) => ({
            type: TOOL_TYPE_FUNCTION,
            name,
            description,
            input_schema: inputSchema,
          })),
        ),
      );
    }
  }

  if (CAPTURE_CONTENT && options.initialPrompts?.length) {
    const instructions = encodeSystemInstructions(options.initialPrompts);
    if (instructions) {
      attributes[GEN_AI.SYSTEM_INSTRUCTIONS] = JSON.stringify(instructions);
      // Session Input preview uses the first trace (create_session); show the system
      // prompt because there is no user message yet. role=system — MLflow looks for
      // user first, then falls back to the last message in the preview JSON.
      const preview = mlflowChatPreview([
        { role: "system", parts: instructions },
      ]);
      if (preview) attributes[MLFLOW_INPUTS] = preview;
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
    return wrapSession(session, { conversationId, sessionId }, options);
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

/**
 * Remembers the calls a turn asked for, and hands each one an id.
 *
 * Chrome leaves `callID` empty, so a synthetic id is filled in: without one,
 * nothing ties the `tool_call` part recorded on the turn to the `execute_tool`
 * span that answers it. Calls are stamped with the moment the turn ended
 * rather than the moment each appeared, because the page cannot act on a call
 * until the stream closes — that wait belongs to the turn.
 */
function registerToolCalls(state, calls, parent, runnableAt) {
  return calls.map((call) => {
    state.toolCallSeq += 1;
    const identified = {
      ...call,
      id: call.id || `${state.sessionId}-${state.toolCallSeq}`,
    };
    state.pendingCalls.push({
      ...identified,
      index: state.toolCallSeq,
      turnIndex: state.turnIndex,
      runnableAt,
      parent,
    });
    return identified;
  });
}

/**
 * Finds the call a response answers. `callID` would say so, but Chrome leaves
 * it empty on both sides, so the name is matched instead and same-named calls
 * fall back to the order they were requested in.
 */
function takePendingCall(state, response) {
  const { pendingCalls } = state;
  const byId = response.id
    ? pendingCalls.findIndex((call) => call.id === response.id)
    : -1;
  const at =
    byId >= 0
      ? byId
      : pendingCalls.findIndex((call) => call.name === response.name);

  // A response that matches nothing must not consume some other call's record,
  // or the next response inherits its arguments and its start time.
  if (at < 0) return;
  return pendingCalls.splice(at, 1)[0];
}

function safeJson(value) {
  try {
    return truncateAttribute(JSON.stringify(value));
  } catch {
    return;
  }
}

function toolSpanAttributes(state, response, pending) {
  const name = response.name || pending?.name || "unknown";
  const attributes = {
    [GEN_AI.OPERATION_NAME]: OPERATION_EXECUTE_TOOL,
    [GEN_AI.PROVIDER_NAME]: PROVIDER_NAME,
    ...mlflowSessionAttributes(state.conversationId, state.sessionId),
    [GEN_AI.TOOL_NAME]: name,
    [GEN_AI.TOOL_TYPE]: TOOL_TYPE_FUNCTION,
  };

  // The response's own id when the model set one, otherwise the id handed to
  // the call, which is what the turn's tool_call part carries.
  const callId = response.id || pending?.id;
  if (callId) attributes[GEN_AI.TOOL_CALL_ID] = callId;
  if (pending) {
    attributes[WEB_AI.TOOL_CALL_INDEX] = pending.index;
    attributes[WEB_AI.TURN_INDEX] = pending.turnIndex;
  }

  const description = state.tools.get(name)?.description;
  if (description) attributes[GEN_AI.TOOL_DESCRIPTION] = description;
  if (CAPTURE_CONTENT && pending?.arguments !== undefined) {
    attributes[GEN_AI.TOOL_CALL_ARGUMENTS] = safeJson(pending.arguments);
  }
  // The spec records a result only for a call that succeeded; a failure is left
  // to `error.type` and the span status.
  if (CAPTURE_CONTENT && response.result !== undefined) {
    attributes[GEN_AI.TOOL_CALL_RESULT] = safeJson(response.result);
  }

  return attributes;
}

/**
 * Emits one `execute_tool` span per response received, ending them all at
 * `endTime` — the instant the turn that consumes them begins.
 *
 * The tool itself runs in page code this instrumentation never sees, so the
 * span is reconstructed after the fact: it runs from the turn that asked for
 * the call to the moment the page came back with a result. That covers the
 * page's own tool loop as well as the tool, which is the wait a developer can
 * actually act on.
 */
function emitToolExecutionSpans(state, responses, fallbackParent, endTime) {
  for (const response of responses) {
    const pending = takePendingCall(state, response);
    const name = response.name || pending?.name || "unknown";

    const span = tracer.startSpan(
      `${OPERATION_EXECUTE_TOOL} ${name}`,
      {
        kind: SpanKind.INTERNAL,
        // An unmatched response has no known start, so it collapses onto the
        // moment it arrived rather than borrowing another call's clock.
        startTime: pending?.runnableAt ?? endTime,
        attributes: toolSpanAttributes(state, response, pending),
      },
      pending?.parent ?? fallbackParent,
    );

    if (response.errorMessage === undefined) {
      span.setStatus({ code: SpanStatusCode.OK });
    } else {
      span.setAttribute(ERROR_TYPE, "ToolError");
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: response.errorMessage,
      });
    }
    span.end(endTime);
  }
}

function exchangeAttributes(state, input) {
  const attributes = {
    [GEN_AI.OPERATION_NAME]: OPERATION_INVOKE_AGENT,
    [GEN_AI.PROVIDER_NAME]: PROVIDER_NAME,
    ...mlflowSessionAttributes(state.conversationId, state.sessionId),
    [WEB_AI.TOOL_COUNT]: state.tools.size,
    [WEB_AI.TOOL_NAMES]: [...state.tools.keys()],
  };

  if (CAPTURE_CONTENT) {
    const inputMessages = encodeInputMessages(input);
    attributes[GEN_AI.INPUT_MESSAGES] = truncateAttribute(
      JSON.stringify(inputMessages),
    );
    const preview = mlflowChatPreview(inputMessages);
    if (preview) attributes[MLFLOW_INPUTS] = preview;
  }

  return attributes;
}

function exchangeResultAttributes(exchange, output) {
  const attributes = {
    [WEB_AI.EXCHANGE_TURN_COUNT]: exchange.turns,
    [WEB_AI.EXCHANGE_TOOL_CALL_COUNT]: exchange.toolCalls,
  };

  if (output === undefined) {
    attributes[WEB_AI.EXCHANGE_ABANDONED] = true;
    return attributes;
  }

  attributes[GEN_AI.FINISH_REASONS] = [FINISH_STOP];
  if (CAPTURE_CONTENT) {
    const outputMessages = encodeOutputMessages(output, FINISH_STOP);
    attributes[GEN_AI.OUTPUT_MESSAGES] = truncateAttribute(
      JSON.stringify(outputMessages),
    );
    const preview = mlflowChatPreview(outputMessages);
    if (preview) attributes[MLFLOW_OUTPUTS] = preview;
  }

  return attributes;
}

function wrapSession(session, meta, createOptions = {}) {
  const tools = createOptions.tools ?? [];
  const state = {
    ...meta,
    turnIndex: 0,
    compacted: false,
    activeSpans: new Set(),
    /** Turn that overflowed when no span was active (event fired after span.end). */
    overflowTurnIndex: undefined,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    pendingCalls: [],
    toolCallSeq: 0,
    exchange: undefined,
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

  const closeExchange = (output, at) => {
    const { exchange } = state;
    if (!exchange) return;
    state.exchange = undefined;
    state.pendingCalls = [];
    exchange.span.setAttributes(exchangeResultAttributes(exchange, output));
    exchange.span.setStatus({ code: SpanStatusCode.OK });
    // Ends where its last turn ended, so the root always covers its children.
    exchange.span.end(at);
  };

  const openExchange = (input, startTime) => {
    if (state.tools.size === 0) return;

    const span = tracer.startSpan(
      OPERATION_INVOKE_AGENT,
      {
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: exchangeAttributes(state, input),
      },
      context.active(),
    );
    const spanContext = trace.setSpan(context.active(), span);
    state.exchange = { span, context: spanContext, turns: 0, toolCalls: 0 };
    return spanContext;
  };

  const beginTurn = (input) => {
    const at = spanTimestamp();
    const traffic = toolTrafficFrom(input);
    const continuation =
      traffic.responses.length > 0 && Boolean(state.exchange);

    if (!continuation) closeExchange(undefined, at);

    const parent =
      (continuation ? state.exchange?.context : openExchange(input, at)) ??
      context.active();

    // Emitted before the turn opens so a tool run sits beside the turns rather
    // than inside the one being told its result. Sharing `at` with the turn
    // about to start is what keeps the two strictly ordered.
    if (traffic.responses.length > 0) {
      emitToolExecutionSpans(state, traffic.responses, parent, at);
    }

    if (state.exchange) state.exchange.turns += 1;

    return { traffic, parent, startTime: at };
  };

  const settleTurn = (turn, at) => {
    if (state.exchange && turn) {
      state.exchange.toolCalls += turn.toolCalls.length;
    }
    if (!turn || turn.toolCalls.length === 0) {
      closeExchange(turn, at);
    }
  };

  const toolParent = (fallback) => state.exchange?.context ?? fallback;

  return new Proxy(session, {
    get(target, prop) {
      if (prop === "prompt") {
        return (input, opts) =>
          tracedPrompt(target, state, input, opts, {
            beginTurn,
            settleTurn,
            toolParent,
          });
      }
      if (prop === "promptStreaming") {
        return (input, opts) =>
          tracedPromptStreaming(target, state, input, opts, {
            beginTurn,
            settleTurn,
            toolParent,
          });
      }
      if (prop === "destroy") {
        return () => {
          // Destroying mid-exchange means the tool results are never coming.
          closeExchange(undefined, spanTimestamp());
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
function requestAttributes(state, input, opts, streaming, traffic) {
  state.turnIndex += 1;

  const attributes = {
    [GEN_AI.OPERATION_NAME]: OPERATION,
    [GEN_AI.PROVIDER_NAME]: PROVIDER_NAME,
    ...mlflowSessionAttributes(state.conversationId, state.sessionId),
    [WEB_AI.TURN_INDEX]: state.turnIndex,
  };

  if (streaming) attributes[GEN_AI.REQUEST_STREAM] = true;
  if (opts?.responseConstraint) attributes[GEN_AI.OUTPUT_TYPE] = "json";
  if (state.compacted) attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  if (traffic.responses.length > 0) {
    attributes[WEB_AI.TURN_CONTINUATION] = true;
    attributes[WEB_AI.TOOL_RESPONSE_COUNT] = traffic.responses.length;
  }

  if (CAPTURE_CONTENT) {
    const inputMessages = encodeInputMessages(input);
    attributes[GEN_AI.INPUT_MESSAGES] = truncateAttribute(
      JSON.stringify(inputMessages),
    );
    const preview = mlflowChatPreview(inputMessages);
    if (preview) attributes[MLFLOW_INPUTS] = preview;
  }

  return attributes;
}

function toolCallAttributes(output) {
  if (typeof output === "string" || output.toolCalls.length === 0) {
    return {};
  }
  return {
    [WEB_AI.TOOL_CALL_COUNT]: output.toolCalls.length,
    [WEB_AI.TOOL_CALL_NAMES]: output.toolCalls.map((call) => call.name),
  };
}

/** Attributes known once the call settled. */
function resultAttributes(
  session,
  state,
  windowTokens,
  before,
  output,
  finish,
  after = readContextUsage(session),
) {
  const attributes = {
    ...contextAttributes(windowTokens, before, after),
    [GEN_AI.FINISH_REASONS]: [finish],
  };
  if (state.compacted) attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  if (before !== undefined && after !== undefined && after < before) {
    attributes[WEB_AI.CONTEXT_OVERFLOWED] = true;
    attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  }
  if (output === undefined) return attributes;

  Object.assign(attributes, toolCallAttributes(output));
  if (CAPTURE_CONTENT) {
    const outputMessages = encodeOutputMessages(output, finish);
    attributes[GEN_AI.OUTPUT_MESSAGES] = truncateAttribute(
      JSON.stringify(outputMessages),
    );
    const preview = mlflowChatPreview(outputMessages);
    if (preview) attributes[MLFLOW_OUTPUTS] = preview;
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

async function tracedPrompt(session, state, input, opts, exchange) {
  const { traffic, parent, startTime } = exchange.beginTurn(input);
  const windowTokens = readContextWindow(session);
  const before = readContextUsage(session);
  const attributes = requestAttributes(state, input, opts, false, traffic);
  const turnIndex = state.turnIndex;

  const span = tracer.startSpan(
    OPERATION,
    { ...SPAN_OPTIONS, startTime, attributes },
    parent,
  );
  const spanContext = trace.setSpan(parent, span);
  state.activeSpans.add(span);

  let turn;
  let endedAt;
  try {
    return await context.with(spanContext, async () => {
      const output = await session.prompt(input, opts);
      endedAt = spanTimestamp();
      const assistant = readAssistantTurn(output);
      // Registered before the attributes are written so the turn's own
      // tool_call parts carry the ids the tool spans will be labelled with.
      turn = {
        text: assistant.text,
        toolCalls: registerToolCalls(
          state,
          assistant.toolCalls,
          exchange.toolParent(spanContext),
          endedAt,
        ),
      };
      const after = readContextUsage(session);
      reconcileContextOverflow(span, state, turnIndex, before, after);
      span.setAttributes(
        resultAttributes(
          session,
          state,
          windowTokens,
          before,
          turn,
          turn.toolCalls.length > 0 ? FINISH_TOOL_CALL : FINISH_STOP,
          after,
        ),
      );
      span.setStatus({ code: SpanStatusCode.OK });
      return output;
    });
  } catch (err) {
    const after = readContextUsage(session);
    reconcileContextOverflow(span, state, turnIndex, before, after);
    span.setAttributes(
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
    // Unset only when the turn failed before it could be timed.
    endedAt ??= spanTimestamp();
    state.activeSpans.delete(span);
    span.end(endedAt);
    exchange.settleTurn(turn, endedAt);
  }
}

function tracedPromptStreaming(session, state, input, opts, exchange) {
  const { traffic, parent, startTime } = exchange.beginTurn(input);
  const windowTokens = readContextWindow(session);
  const before = readContextUsage(session);
  const attributes = requestAttributes(state, input, opts, true, traffic);
  const turnIndex = state.turnIndex;

  const span = tracer.startSpan(
    OPERATION,
    { ...SPAN_OPTIONS, startTime, attributes },
    parent,
  );
  const spanContext = trace.setSpan(parent, span);
  state.activeSpans.add(span);

  const startedAt = performance.now();
  let firstChunkAt = null;
  let chunkCount = 0;
  let text = "";
  const toolCalls = [];

  const finalize = (output, finishReason) => {
    const after = readContextUsage(session);
    reconcileContextOverflow(span, state, turnIndex, before, after);
    span.setAttributes(
      resultAttributes(
        session,
        state,
        windowTokens,
        before,
        output,
        finishReason,
        after,
      ),
    );
  };

  const pump = async (controller) => {
    const reader = session.promptStreaming(input, opts).getReader();
    let chunk = await reader.read();
    while (!chunk.done) {
      chunkCount += 1;
      firstChunkAt ??= performance.now();

      if (typeof chunk.value === "string") {
        text += chunk.value;
      } else {
        const call = toolCallFromChunk(chunk.value);
        if (call) toolCalls.push(call);
      }

      controller.enqueue(chunk.value);
      chunk = await reader.read();
    }
  };

  return new ReadableStream({
    async start(controller) {
      let turn;
      let endedAt;
      try {
        await context.with(spanContext, () => pump(controller));
        endedAt = spanTimestamp();
        // Registered before the attributes are written so the turn's own
        // tool_call parts carry the ids the tool spans will be labelled with.
        turn = {
          text,
          toolCalls: registerToolCalls(
            state,
            toolCalls,
            exchange.toolParent(spanContext),
            endedAt,
          ),
        };
        finalize(
          turn,
          turn.toolCalls.length > 0 ? FINISH_TOOL_CALL : FINISH_STOP,
        );
        span.setStatus({ code: SpanStatusCode.OK });
        controller.close();
      } catch (err) {
        finalize({ text, toolCalls }, finishReasonFor(err));
        recordError(span, err);
        controller.error(err);
      } finally {
        // Unset only when the turn failed before it could be timed.
        endedAt ??= spanTimestamp();
        span.setAttribute(WEB_AI.CHUNK_COUNT, chunkCount);
        if (firstChunkAt !== null) {
          span.setAttribute(
            GEN_AI.TIME_TO_FIRST_CHUNK,
            (firstChunkAt - startedAt) / 1000,
          );
        }
        state.activeSpans.delete(span);
        span.end(endedAt);
        exchange.settleTurn(turn, endedAt);
      }
    },
  });
}
