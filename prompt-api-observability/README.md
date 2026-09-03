# Prompt API Observability

Observability PoC for the [Prompt API](https://webmachinelearning.github.io/prompt-api/) — a standalone demo based on `[prompt-api-playground](https://chrome.dev/web-ai-demos/prompt-api-playground/)`.

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

Opens the MLflow UI at [http://localhost:5000](http://localhost:5000). MLflow's OTLP endpoint [recognises](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/genai-semconv/) `gen_ai.*` [attributes natively](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/genai-semconv/), so no collector is needed.

**Terminal 2 — playground**

```bash
cd prompt-api-observability
npm start
```

`npm start` generates a [DevTools Workspace](https://developer.chrome.com/docs/devtools/workspaces) mapping (`.well-known/appspecific/com.chrome.devtools.json`, gitignored), then serves the app at [http://localhost:8080](http://localhost:8080).

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

**Resource vs span (OTel).** 

Stable for the page load → OTel **resource** (MLflow **trace tags**):

 `service.name`, `browser.*`, `user_agent.original`, `web_ai.runtime.{browser.name,browser.version,device_memory_gib}`. 


Changes per prompt or span → **span attributes**: 

`gen_ai.*`, per-turn `web_ai.context.*`, `web_ai.conversation.turn_index`, etc. 


Session-stable Prompt API options (`web_ai.context.window_tokens`, `gen_ai.system_instructions`, `web_ai.request.sampling_mode`, `web_ai.session.*`) live on `web_ai.create_session` only — not repeated on every `generate_content` span.

**MLflow-only span attributes:** 

`mlflow.spanInputs` / `mlflow.spanOutputs` (OpenAI-shaped previews for the trace table). `session.id` **/** `gen_ai.conversation.id` on spans for session grouping (not resource — assigned per `LanguageModel.create()`).

Standard OTel GenAI, on each inference span:

`gen_ai.operation.name` (`generate_content`), `gen_ai.provider.name` (`google.chrome`), `gen_ai.conversation.id`, `session.id`, `gen_ai.response.finish_reasons`, and when applicable `gen_ai.request.stream`, `gen_ai.output.type`, `gen_ai.response.time_to_first_chunk` (seconds), `gen_ai.conversation.compacted`, `error.type`.

With `CAPTURE_CONTENT = true`: `gen_ai.input.messages`, `gen_ai.output.messages`, plus `mlflow.spanInputs` / `mlflow.spanOutputs` for readable Request/Response columns (`gen_ai.system_instructions` only on `web_ai.create_session`).

Custom `web_ai.*` on inference spans: `usage_before_tokens`, `usage_after_tokens`, `usage_delta_tokens`, `remaining_after_tokens`, `utilization_after`, `overflowed`, `web_ai.stream.chunk_count`, `web_ai.conversation.turn_index`. On `web_ai.create_session`: `web_ai.context.window_tokens`, `gen_ai.system_instructions`, `web_ai.request.sampling_mode`, `web_ai.session.{expected_inputs,expected_outputs}`.

### Notable choices

**No model attributes** 
The Prompt API exposes no model name or version, so `gen_ai.request.model` and `gen_ai.response.model` are unset and the span name is bare `generate_content` rather than the spec's `{operation} {model}`. The previous OpenInference version hardcoded `gemini-nano`, which was invented. The browser version is recorded separately as a resource attribute and never substituted for a model version.

**No token usage** 
The Prompt API reports context-window measurements, not per-request token counts, so `gen_ai.usage.`* is unset and those measurements live under `web_ai.context.*`. The previous version derived `llm.token_count.*` from context deltas, which was wrong.

**Messages are JSON strings** 
OpenTelemetry JS has no structured attribute support — `AttributeValue` is a string, number, boolean or homogeneous array, and the SDK drops objects. The spec allows the fallback: *"When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported."* 

The JSON follows the GenAI [input](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/gen-ai-input-messages.json) / [output](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/gen-ai-output-messages.json) message schemas exactly.

`session.id` **vs** `gen_ai.conversation.id`
Both are assigned once per `LanguageModel.create()` and reused for every span on that session (create, prompts, destroy). A page reload or “Reset session” calls `createInstrumentedSession()` again and gets new ids. MLflow groups traces by `session.id`, so each Prompt API session is one MLflow conversation. By default `session.id` equals `gen_ai.conversation.id`; pass `telemetryOptions.sessionId` to override.

**Session Input preview** 

MLflow's session Input column comes from the first trace (`web_ai.create_session`), which has no user message. `mlflow.spanInputs` on that span carries the system prompt (OpenAI-shaped, `role: system`) so the session list shows it instead of an empty cell.

**Context overflow** 

When the Prompt API compacts history (`contextoverflow` / `quotaoverflow`, or `contextUsage` drops vs `usage_before_tokens`), the in-flight `generate_content` span gets a `web_ai.context_overflow` event (with usage attributes — MLflow's Events tab only renders events that carry attributes), plus `web_ai.context.overflowed = true` and `gen_ai.conversation.compacted = true` on later turns.

**Privacy** 

`CAPTURE_CONTENT = false` keeps prompts and responses out of spans. Image and audio parts are never exported as bytes in either mode; they become `{ "type": "redacted", "modality": "image" }`.

### Not covered

`clone()` and `append()` are passed through untraced. Consumers that break out of a streaming loop early still export the span, but via the underlying stream draining rather than an explicit cancellation path. Spec revision: `[67dff02](https://github.com/open-telemetry/semantic-conventions-genai/commit/67dff024110be5bd9f318006e733f4078e0f4c97)` (2026-08-27).

> [!WARNING]
> Every `gen_ai.*` attribute used here, plus the `browser.*` and `session.id` conventions, is marked **Development** upstream and may change without a major version bump.



## Future work

**Typed npm SDK** — publish a package that bundles OpenTelemetry setup and Prompt API instrumentation so developers add a dependency instead of copying `telemetry.js`.

**Other built-in AI APIs** — extend the same pattern to Summarizer, Translator, Writer, and the other [browser built-in AI APIs](https://developer.chrome.com/docs/ai/built-in-apis).

**Production observability** — this demo targets local MLflow only. Shipping client-side trace export in production raises separate questions (credentials, privacy, CORS) that are out of scope here.

### List of LLM Observability Products

[Agenta](https://agenta.ai), [AgentNeo](https://github.com/raga-ai-hub/agentneo), [AgentOps](https://www.agentops.ai), [Agentuity](https://agentuity.com), [Amazon Bedrock AgentCore Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html), [Amazon CloudWatch GenAI Observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/GenAI-observability.html), [Arize AX](https://arize.com/ax), [Arize Phoenix](https://arize.com/phoenix), [Arthur AI](https://www.arthur.ai), [Braintrust](https://www.braintrust.dev), [Cleanlab TLM](https://cleanlab.ai/tlm), [Comet Opik](https://www.comet.com/site/products/opik/), [Confident AI](https://www.confident-ai.com), [Coralogix AI Center](https://coralogix.com/platform/ai-observability/), [CrewAI AMP](https://www.crewai.com/), [Databricks MLflow Production Monitoring](https://www.databricks.com/product/managed-mlflow), [Datadog Agent Observability](https://www.datadoghq.com/products/ai/agent-observability/), [DeepEval](https://deepeval.com), [Dynatrace AI Observability](https://www.dynatrace.com/solutions/ai-observability/), [Elastic LLM and Agentic AI Observability](https://www.elastic.co/observability/llm-monitoring), [Evidently](https://www.evidentlyai.com), [Fiddler](https://www.fiddler.ai), [Galileo](https://galileo.ai), [Giskard Hub](https://www.giskard.ai), [Google Cloud Agent Observability](https://docs.cloud.google.com/stackdriver/docs/observability/agent-observability), [Grafana Agent Observability](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/), [Helicone](https://www.helicone.ai), [HoneyHive](https://www.honeyhive.ai), [Laminar](https://laminar.sh), [Langfuse](https://langfuse.com), [LangSmith](https://www.langchain.com/langsmith), [Langtrace](https://github.com/Scale3-Labs/langtrace), [LangWatch](https://langwatch.ai), [Lunary](https://lunary.ai), [Maxim AI](https://www.getmaxim.ai), [Microsoft Foundry Agent Tracing](https://learn.microsoft.com/azure/ai-foundry/agents/concepts/tracing), [MLflow](https://mlflow.org), [New Relic AI Monitoring](https://docs.newrelic.com/docs/ai-monitoring/intro-to-ai-monitoring/), [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/), [Openlayer](https://www.openlayer.com), [OpenLIT](https://openlit.io), [OpenObserve](https://openobserve.ai), [Parea](https://www.parea.ai), [Patronus AI](https://www.patronus.ai), [Portkey](https://portkey.ai), [PostHog AI Observability](https://posthog.com/ai-engineering), [Pydantic Logfire](https://pydantic.dev/logfire), [Qualifire](https://www.qualifire.ai), [Sentry AI Monitoring](https://docs.sentry.io/product/insights/ai/), [SigNoz](https://signoz.io), [Traccia](https://traccia.ai), [Traceloop](https://www.traceloop.com), [TruLens](https://www.trulens.org), [Weights & Biases Weave](https://wandb.ai/site/weave)