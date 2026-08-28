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
};

const ERROR_TYPE = "error.type";
const SESSION_ID = "session.id";

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

/**
 * Groups every trace from this browser application session, across all
 * conversations. In sessionStorage so a reload keeps it and a new tab gets a
 * new one.
 */
const applicationSessionId = (() => {
  const key = "web-ai.session.id";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
})();

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
 * The browser is the Prompt API runtime — it supplies the model and dominates
 * performance — so record its identity on every trace. Low-entropy hints ride
 * on every request already via `Sec-CH-UA*`; `getHighEntropyValues()` adds a
 * little fingerprinting surface in exchange for a full patch version.
 */
async function browserResourceAttributes() {
  const attributes = {
    "browser.language": navigator.language,
    "user_agent.original": navigator.userAgent,
  };
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
 * The delta is signed on purpose: when context overflow drops earlier turns,
 * usage goes down, and that decrease is the interesting signal.
 */
function contextAttributes(windowTokens, before, after) {
  const attributes = {};
  if (windowTokens !== undefined) {
    attributes[WEB_AI.CONTEXT_WINDOW] = windowTokens;
  }
  if (before !== undefined) attributes[WEB_AI.CONTEXT_USAGE_BEFORE] = before;
  if (after === undefined) return attributes;

  attributes[WEB_AI.CONTEXT_USAGE_AFTER] = after;
  if (before !== undefined) {
    attributes[WEB_AI.CONTEXT_USAGE_DELTA] = after - before;
  }
  if (windowTokens) {
    attributes[WEB_AI.CONTEXT_REMAINING_AFTER] = windowTokens - after;
    attributes[WEB_AI.CONTEXT_UTILIZATION_AFTER] = after / windowTokens;
  }
  return attributes;
}

// --- Instrumentation -------------------------------------------------------

/**
 * Creates a `LanguageModel` session and wraps it.
 *
 * `conversationId` is passed separately from the Prompt API options so it is
 * never forwarded to `LanguageModel.create()` and never reaches the model.
 *
 * @param {any} options Passed verbatim to `LanguageModel.create()`.
 * @param {{ conversationId?: string }} telemetryOptions
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
  const systemPrompt = options.initialPrompts?.find(
    (p) => p.role === "system",
  )?.content;

  // Not a GenAI inference span: creating a session generates nothing.
  const span = tracer.startSpan("web_ai.create_session", {
    kind: SpanKind.INTERNAL,
    attributes: {
      [GEN_AI.CONVERSATION_ID]: conversationId,
      [SESSION_ID]: applicationSessionId,
    },
  });

  try {
    const session = await LanguageModel.create(options);
    const windowTokens = readContextWindow(session);
    if (windowTokens !== undefined) {
      span.setAttribute(WEB_AI.CONTEXT_WINDOW, windowTokens);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    return wrapSession(session, { conversationId, systemPrompt });
  } catch (err) {
    recordError(span, err);
    throw err;
  } finally {
    span.end();
  }
}

function wrapSession(session, meta) {
  const state = {
    ...meta,
    turnIndex: 0,
    compacted: false,
    activeSpans: new Set(),
  };

  // `contextoverflow` means the browser dropped earlier turns to fit the
  // window, which is what gen_ai.conversation.compacted describes. It stays
  // true for every later turn on this conversation.
  session.addEventListener?.("contextoverflow", () => {
    state.compacted = true;
    for (const span of state.activeSpans) {
      span.addEvent("web_ai.context_overflow");
      span.setAttribute(WEB_AI.CONTEXT_OVERFLOWED, true);
      span.setAttribute(GEN_AI.CONVERSATION_COMPACTED, true);
    }
  });

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
            tracer
              .startSpan("web_ai.destroy_session", {
                kind: SpanKind.INTERNAL,
                attributes: {
                  [GEN_AI.CONVERSATION_ID]: state.conversationId,
                  [SESSION_ID]: applicationSessionId,
                },
              })
              .end();
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

/** Attributes known before the model runs. Set at creation so samplers see them. */
function requestAttributes(session, state, input, opts, streaming) {
  state.turnIndex += 1;

  const attributes = {
    [GEN_AI.OPERATION_NAME]: OPERATION,
    [GEN_AI.PROVIDER_NAME]: PROVIDER_NAME,
    [GEN_AI.CONVERSATION_ID]: state.conversationId,
    [SESSION_ID]: applicationSessionId,
    [WEB_AI.TURN_INDEX]: state.turnIndex,
  };

  if (streaming) attributes[GEN_AI.REQUEST_STREAM] = true;
  if (opts?.responseConstraint) attributes[GEN_AI.OUTPUT_TYPE] = "json";
  if (session.samplingMode) {
    attributes[WEB_AI.SAMPLING_MODE] = session.samplingMode;
  }
  // Never written as false: the convention treats it as a positive indicator
  // only and requires it left unset otherwise.
  if (state.compacted) attributes[GEN_AI.CONVERSATION_COMPACTED] = true;

  if (CAPTURE_CONTENT) {
    attributes[GEN_AI.INPUT_MESSAGES] = JSON.stringify(
      encodeInputMessages(input),
    );
    if (state.systemPrompt) {
      attributes[GEN_AI.SYSTEM_INSTRUCTIONS] = JSON.stringify([
        { type: "text", content: state.systemPrompt },
      ]);
    }
  }

  return attributes;
}

/** Attributes known once the call settled. */
function resultAttributes(session, state, windowTokens, before, text, finish) {
  const attributes = {
    ...contextAttributes(windowTokens, before, readContextUsage(session)),
    [GEN_AI.FINISH_REASONS]: [finish],
  };
  if (state.compacted) attributes[GEN_AI.CONVERSATION_COMPACTED] = true;
  if (CAPTURE_CONTENT && text !== undefined) {
    attributes[GEN_AI.OUTPUT_MESSAGES] = JSON.stringify(
      encodeOutputMessages(text, finish),
    );
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

  return tracer.startActiveSpan(
    OPERATION,
    { ...SPAN_OPTIONS, attributes },
    async (span) => {
      state.activeSpans.add(span);
      try {
        const text = await session.prompt(input, opts);
        span.setAttributes(
          resultAttributes(session, state, windowTokens, before, text, "stop"),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return text;
      } catch (err) {
        span.setAttributes(
          // No text: the response never completed.
          resultAttributes(
            session,
            state,
            windowTokens,
            before,
            undefined,
            finishReasonFor(err),
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
        span.setAttributes(
          resultAttributes(session, state, windowTokens, before, text, "stop"),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        controller.close();
      } catch (err) {
        // Keep the partial text: seeing where generation stopped is the point.
        span.setAttributes(
          resultAttributes(
            session,
            state,
            windowTokens,
            before,
            text,
            finishReasonFor(err),
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
