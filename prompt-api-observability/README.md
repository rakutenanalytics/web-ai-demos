# Prompt API Observability

Observability PoC for the [Prompt API](https://webmachinelearning.github.io/prompt-api/) — a standalone demo based on [`prompt-api-playground`](https://chrome.dev/web-ai-demos/prompt-api-playground/).

The Prompt API lets web apps call on-device language models directly from JavaScript (`LanguageModel.create`, `prompt`, `promptStreaming`, …). Implementations are available in browsers today; the API is being developed as an open web standard. This demo shows how to instrument those client-side calls and export traces to a local observability backend.

## Motivation

Teams shipping server-side GenAI already use OpenTelemetry to observe behavior, evaluate quality, and debug failures. On-device inference has no app backend, so the same stacks do not apply out of the box. Without traces, teams cannot close the loop on prompt quality, latency, or errors for built-in AI.

This PoC instruments the Prompt API in the browser and exports spans following the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) to [MLflow](https://mlflow.org/docs/latest/genai/tracing/quickstart/) via OTLP/HTTP JSON — a fully local, open-source end-to-end path. It is not a production-ready SDK.

## What this is

A copy of the Prompt API playground with a thin OpenTelemetry layer added. The chat UI is unchanged. Spans are sent from the browser to a local [MLflow](https://mlflow.org/) tracking server; there is no application backend.

### Changes vs prompt-api-playground

| File           | Role                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `telemetry.js` | OpenTelemetry setup, MLflow OTLP export (`localhost:5000`, experiment `0`), Prompt API span instrumentation |
| `script.js`    | Wires telemetry in; replaces `LanguageModel.create()` with `createInstrumentedSession()`                    |
| `index.html`   | OpenTelemetry import map (SDK loaded from esm.sh)                                                           |

Suggested review order: this README → `script.js` (diff vs playground) → `telemetry.js`.

Everything you may want to tweak sits in one block at the top of `telemetry.js`: the MLflow URL, the experiment id, `CAPTURE_CONTENT`, and `PROVIDER_NAME`.

## Prerequisites

- A browser with Prompt API support (e.g. Chrome with the built-in model enabled)
- [uv](https://docs.astral.sh/uv/) (for `uvx mlflow server`) to run [MLflow](https://mlflow.org/)

## Run the demo

Two terminals:

**Terminal 1 — MLflow tracking server**

```bash
cd prompt-api-observability
npm run mlflow
```

Opens the MLflow UI at http://localhost:5000. MLflow's OTLP endpoint [recognises `gen_ai.*` attributes natively](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/genai-semconv/), so no collector is needed.

**Terminal 2 — playground**

```bash
cd prompt-api-observability
npm start
```

`npm start` generates a [DevTools Workspace](https://developer.chrome.com/docs/devtools/workspaces) mapping (`.well-known/appspecific/com.chrome.devtools.json`, gitignored), then serves the app at http://localhost:8080.

Submit a prompt in the browser. Traces appear in MLflow → **Default** experiment (ID `0`) → **Traces** tab.

To send to any other OTLP backend (e.g. an OpenTelemetry Collector feeding Grafana Tempo) instead:

```js
await initTelemetry({
  otlpUrl: "http://localhost:4318/v1/traces",
  otlpHeaders: {},
});
```

## What gets traced

| Span                     | Kind     | GenAI inference span | When          |
| ------------------------ | -------- | -------------------- | ------------- |
| `web_ai.create_session`  | INTERNAL | No                   | Session start |
| `generate_content`       | INTERNAL | **Yes**              | Each prompt   |
| `web_ai.destroy_session` | INTERNAL | No                   | Session reset |

Only `prompt()` and `promptStreaming()` generate content, so only they carry `gen_ai.operation.name`. Span kind is `INTERNAL` because the model runs in the same process — the convention reserves `CLIENT` for calls crossing a process boundary and explicitly allows `INTERNAL` for in-process models.

### Attributes

Standard OTel GenAI, on each inference span:

`gen_ai.operation.name` (`generate_content`), `gen_ai.provider.name` (`google.chrome`), `gen_ai.conversation.id`, `session.id`, `gen_ai.response.finish_reasons`, and when applicable `gen_ai.request.stream`, `gen_ai.output.type`, `gen_ai.response.time_to_first_chunk` (seconds), `gen_ai.conversation.compacted`, `error.type`.

With `CAPTURE_CONTENT = true`: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`.

Custom `web_ai.*` for Prompt API concepts no convention covers: `web_ai.context.window_tokens`, `usage_before_tokens`, `usage_after_tokens`, `usage_delta_tokens`, `remaining_after_tokens`, `utilization_after`, `overflowed`, plus `web_ai.stream.chunk_count`, `web_ai.conversation.turn_index`, `web_ai.request.sampling_mode`, and `web_ai.runtime.browser.{name,version}` on the resource.

### Notable choices

**No model attributes.** The Prompt API exposes no model name or version, so `gen_ai.request.model` and `gen_ai.response.model` are unset and the span name is bare `generate_content` rather than the spec's `{operation} {model}`. The previous OpenInference version hardcoded `gemini-nano`, which was invented. The browser version is recorded separately as a resource attribute and never substituted for a model version.

**No token usage.** The Prompt API reports context-window measurements, not per-request token counts, so `gen_ai.usage.*` is unset and those measurements live under `web_ai.context.*`. The previous version derived `llm.token_count.*` from context deltas, which was wrong.

**Messages are JSON strings.** OpenTelemetry JS has no structured attribute support — `AttributeValue` is a string, number, boolean or homogeneous array, and the SDK drops objects. The spec allows the fallback: _"When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported."_ The JSON follows the GenAI [input](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/gen-ai-input-messages.json) / [output](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/gen-ai-output-messages.json) message schemas exactly.

**`session.id` vs `gen_ai.conversation.id`.** `gen_ai.conversation.id` is one UUID per `LanguageModel` session, reused for every turn on it. `session.id` groups all conversations in one browser application session and lives in `sessionStorage`. The convention warns instrumentations not to invent a conversation id, but that targets libraries fabricating one per operation; here the application assigns it once at the real conversation boundary, which the same paragraph permits.

**Context overflow.** When the Prompt API fires `contextoverflow`, the in-flight span gets a `web_ai.context_overflow` event, `web_ai.context.overflowed = true`, and `gen_ai.conversation.compacted = true` — which then stays set for later turns, since they all run against a compacted view. It is never set to `false`, per the convention.

**Privacy.** `CAPTURE_CONTENT = false` keeps prompts and responses out of spans. Image and audio parts are never exported as bytes in either mode; they become `{ "type": "redacted", "modality": "image" }`.

### Not covered

`clone()` and `append()` are passed through untraced. Consumers that break out of a streaming loop early still export the span, but via the underlying stream draining rather than an explicit cancellation path. Spec revision: [`67dff02`](https://github.com/open-telemetry/semantic-conventions-genai/commit/67dff024110be5bd9f318006e733f4078e0f4c97) (2026-08-27).

> [!WARNING]
> Every `gen_ai.*` attribute used here, plus the `browser.*` and `session.id` conventions, is marked **Development** upstream and may change without a major version bump.

## Future work

**Typed npm SDK** — publish a package that bundles OpenTelemetry setup and Prompt API instrumentation so developers add a dependency instead of copying `telemetry.js`.

**Other built-in AI APIs** — extend the same pattern to Summarizer, Translator, Writer, and the other [browser built-in AI APIs](https://developer.chrome.com/docs/ai/built-in-apis).

**Production observability** — this demo targets local MLflow only. Shipping client-side trace export in production raises separate questions (credentials, privacy, CORS) that are out of scope here.

### List of LLM Observability Products

[Agenta](https://agenta.ai), [AgentNeo](https://github.com/raga-ai-hub/agentneo), [AgentOps](https://www.agentops.ai), [Agentuity](https://agentuity.com), [Amazon Bedrock AgentCore Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html), [Amazon CloudWatch GenAI Observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/GenAI-observability.html), [Arize AX](https://arize.com/ax), [Arize Phoenix](https://arize.com/phoenix), [Arthur AI](https://www.arthur.ai), [Braintrust](https://www.braintrust.dev), [Cleanlab TLM](https://cleanlab.ai/tlm), [Comet Opik](https://www.comet.com/site/products/opik/), [Confident AI](https://www.confident-ai.com), [Coralogix AI Center](https://coralogix.com/platform/ai-observability/), [CrewAI AMP](https://www.crewai.com/), [Databricks MLflow Production Monitoring](https://www.databricks.com/product/managed-mlflow), [Datadog Agent Observability](https://www.datadoghq.com/products/ai/agent-observability/), [DeepEval](https://deepeval.com), [Dynatrace AI Observability](https://www.dynatrace.com/solutions/ai-observability/), [Elastic LLM and Agentic AI Observability](https://www.elastic.co/observability/llm-monitoring), [Evidently](https://www.evidentlyai.com), [Fiddler](https://www.fiddler.ai), [Galileo](https://galileo.ai), [Giskard Hub](https://www.giskard.ai), [Google Cloud Agent Observability](https://docs.cloud.google.com/stackdriver/docs/observability/agent-observability), [Grafana Agent Observability](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/), [Helicone](https://www.helicone.ai), [HoneyHive](https://www.honeyhive.ai), [Laminar](https://laminar.sh), [Langfuse](https://langfuse.com), [LangSmith](https://www.langchain.com/langsmith), [Langtrace](https://github.com/Scale3-Labs/langtrace), [LangWatch](https://langwatch.ai), [Lunary](https://lunary.ai), [Maxim AI](https://www.getmaxim.ai), [Microsoft Foundry Agent Tracing](https://learn.microsoft.com/azure/ai-foundry/agents/concepts/tracing), [MLflow](https://mlflow.org), [New Relic AI Monitoring](https://docs.newrelic.com/docs/ai-monitoring/intro-to-ai-monitoring/), [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/), [Openlayer](https://www.openlayer.com), [OpenLIT](https://openlit.io), [OpenObserve](https://openobserve.ai), [Parea](https://www.parea.ai), [Patronus AI](https://www.patronus.ai), [Portkey](https://portkey.ai), [PostHog AI Observability](https://posthog.com/ai-engineering), [Pydantic Logfire](https://pydantic.dev/logfire), [Qualifire](https://www.qualifire.ai), [Sentry AI Monitoring](https://docs.sentry.io/product/insights/ai/), [SigNoz](https://signoz.io), [Traccia](https://traccia.ai), [Traceloop](https://www.traceloop.com), [TruLens](https://www.trulens.org), [Weights & Biases Weave](https://wandb.ai/site/weave)
