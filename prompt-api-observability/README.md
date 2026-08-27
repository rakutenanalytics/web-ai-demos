# Prompt API Observability

Observability PoC for the [Prompt API](https://webmachinelearning.github.io/prompt-api/) — a standalone demo based on [`prompt-api-playground`](https://chrome.dev/web-ai-demos/prompt-api-playground/).

The Prompt API lets web apps call on-device language models directly from JavaScript (`LanguageModel.create`, `prompt`, `promptStreaming`, …). Implementations are available in browsers today; the API is being developed as an open web standard. This demo shows how to instrument those client-side calls and export traces to a local observability backend.

## Motivation

Teams shipping server-side GenAI already use OpenTelemetry to observe behavior, evaluate quality, and debug failures. On-device inference has no app backend, so the same stacks do not apply out of the box. Without traces, teams cannot close the loop on prompt quality, latency, or errors for built-in AI.

This PoC instruments the Prompt API in the browser and exports [OpenInference](https://arize-ai.github.io/openinference/spec/) spans to [MLflow](https://mlflow.org/docs/latest/genai/tracing/quickstart/) via OTLP/HTTP JSON — a fully local, open-source end-to-end path. It is not a production-ready SDK.

## What this is

A copy of the Prompt API playground with a thin OpenTelemetry layer added. The chat UI is unchanged. Spans are sent from the browser to a local [MLflow](https://mlflow.org/) tracking server; there is no application backend.

### Changes vs prompt-api-playground

| File | Role |
| ---- | ---- |
| `telemetry.js` | OpenTelemetry setup, MLflow OTLP export (`localhost:5000`, experiment `0`), Prompt API span instrumentation |
| `script.js` | Wires telemetry in; replaces `LanguageModel.create()` with `createInstrumentedSession()` |
| `index.html` | OpenTelemetry import map (SDK loaded from esm.sh) |

Suggested review order: this README → `script.js` (diff vs playground) → `telemetry.js`.

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

Opens the MLflow UI at http://localhost:5000.

**Terminal 2 — playground**

```bash
cd prompt-api-observability
npm start
```

`npm start` generates a [DevTools Workspace](https://developer.chrome.com/docs/devtools/workspaces) mapping (`.well-known/appspecific/com.chrome.devtools.json`, gitignored), then serves the app at http://localhost:8080.

Submit a prompt in the browser. Traces appear in MLflow → **Default** experiment (ID `0`) → **Traces** tab.

## What gets traced

| Span | Kind | When |
| ---- | ---- | ---- |
| `LanguageModel.create` | CHAIN | Session start — assigns a `session.id` |
| `LanguageModel.promptStreaming` | LLM | Each prompt (streaming) |
| `LanguageModel.destroy` | CHAIN | Session reset |

Spans use OpenInference attributes: `llm.input_messages`, `llm.output_messages`, `llm.token_count.*`, `session.id`, and `llm.time_to_first_token_ms`.

## Future work

**Typed npm SDK** — publish a package that bundles OpenTelemetry setup and Prompt API instrumentation so developers add a dependency instead of copying `telemetry.js`.

**Other built-in AI APIs** — extend the same pattern to Summarizer, Translator, Writer, and the other [browser built-in AI APIs](https://developer.chrome.com/docs/ai/built-in-apis).

**Production observability** — this demo targets local MLflow only. Shipping client-side trace export in production raises separate questions (credentials, privacy, CORS) that are out of scope here.


### List of LLM Observability Products

[Agenta](https://agenta.ai), [AgentNeo](https://github.com/raga-ai-hub/agentneo), [AgentOps](https://www.agentops.ai), [Agentuity](https://agentuity.com), [Amazon Bedrock AgentCore Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html), [Amazon CloudWatch GenAI Observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/GenAI-observability.html), [Arize AX](https://arize.com/ax), [Arize Phoenix](https://arize.com/phoenix), [Arthur AI](https://www.arthur.ai), [Braintrust](https://www.braintrust.dev), [Cleanlab TLM](https://cleanlab.ai/tlm), [Comet Opik](https://www.comet.com/site/products/opik/), [Confident AI](https://www.confident-ai.com), [Coralogix AI Center](https://coralogix.com/platform/ai-observability/), [CrewAI AMP](https://www.crewai.com/), [Databricks MLflow Production Monitoring](https://www.databricks.com/product/managed-mlflow), [Datadog Agent Observability](https://www.datadoghq.com/products/ai/agent-observability/), [DeepEval](https://deepeval.com), [Dynatrace AI Observability](https://www.dynatrace.com/solutions/ai-observability/), [Elastic LLM and Agentic AI Observability](https://www.elastic.co/observability/llm-monitoring), [Evidently](https://www.evidentlyai.com), [Fiddler](https://www.fiddler.ai), [Galileo](https://galileo.ai), [Giskard Hub](https://www.giskard.ai), [Google Cloud Agent Observability](https://docs.cloud.google.com/stackdriver/docs/observability/agent-observability), [Grafana Agent Observability](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/), [Helicone](https://www.helicone.ai), [HoneyHive](https://www.honeyhive.ai), [Laminar](https://laminar.sh), [Langfuse](https://langfuse.com), [LangSmith](https://www.langchain.com/langsmith), [Langtrace](https://github.com/Scale3-Labs/langtrace), [LangWatch](https://langwatch.ai), [Lunary](https://lunary.ai), [Maxim AI](https://www.getmaxim.ai), [Microsoft Foundry Agent Tracing](https://learn.microsoft.com/azure/ai-foundry/agents/concepts/tracing), [MLflow](https://mlflow.org), [New Relic AI Monitoring](https://docs.newrelic.com/docs/ai-monitoring/intro-to-ai-monitoring/), [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/), [Openlayer](https://www.openlayer.com), [OpenLIT](https://openlit.io), [OpenObserve](https://openobserve.ai), [Parea](https://www.parea.ai), [Patronus AI](https://www.patronus.ai), [Portkey](https://portkey.ai), [PostHog AI Observability](https://posthog.com/ai-engineering), [Pydantic Logfire](https://pydantic.dev/logfire), [Qualifire](https://www.qualifire.ai), [Sentry AI Monitoring](https://docs.sentry.io/product/insights/ai/), [SigNoz](https://signoz.io), [Traccia](https://traccia.ai), [Traceloop](https://www.traceloop.com), [TruLens](https://www.trulens.org), [Weights & Biases Weave](https://wandb.ai/site/weave)

