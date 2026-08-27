# Prompt API Observability

Observability PoC for Chrome's Prompt API — a standalone demo based on [`prompt-api-playground`](../prompt-api-playground).

## Motivation

Teams shipping server-side GenAI products already rely on OpenTelemetry-based observability stacks to observe real behavior, evaluate, diagnose and implement an improvement loop.

Built-in AI runs in the browser with no backend. The same observability stacks do not apply out of the box, which is a practical blocker for moving from demos to production. Without traces, teams cannot close the loop on prompt quality, latency, or failures for on-device inference.

This PoC shows that **we can instrument Chrome's Prompt API in the client and export [OpenInference](https://arize-ai.github.io/openinference/spec/) traces to the same backends used for server-side GenAI services**. It is an early step toward observability parity between built-in AI and traditional GenAI — not a production-ready SDK.

## What this is

A copy of the Prompt API playground with OpenTelemetry instrumentation added. Export traces directly to an OpenTelemetry backend like Langfuse or LangSmith via OTLP/HTTP JSON.

There is no app backend. Run it with `npm start`. The chat UI matches the playground — observability is layered on with minimal extra code.

## Changes vs prompt-api-playground

| File | Change |
| ---- | ------ |
| `script.js` | Imports `telemetry.js` + `config.js`; calls `initTelemetry()` on load; replaces `LanguageModel.create()` with `createInstrumentedSession()` |
| `index.html` | Adds an OpenTelemetry import map in `<head>` (loads SDK from esm.sh) and a local-dev telemetry setup panel |
| `telemetry.js` | **New.** OpenTelemetry setup, OTLP/console export, Prompt API span instrumentation |
| `config.js` | **New.** Client-side config from `sessionStorage` + URL params; OTLP header helpers |

Suggested review order: this README → `script.js` (diff vs playground) → `index.html` (import map + setup panel) → `config.js` → `telemetry.js` (core).

## Setup

```bash
cd prompt-api-observability
npm start
```

Open http://localhost:8080. By default, spans go to the **console** backend (printed in DevTools).

### Configure export (Langfuse / LangSmith)

Expand **Telemetry export (local dev)** on the page, enter credentials, and click **Apply and reload**. Values are stored in `sessionStorage` for the current tab only — nothing is written to disk or committed.

### URL parameters (non-secrets)

You can also set the backend or service name via query string:

```
http://localhost:8080/?backend=console
http://localhost:8080/?backend=langfuse&service-name=my-demo
```

Credentials still come from the setup panel (or existing `sessionStorage` for that tab).

## What gets traced

| Span | Kind | When |
| ---- | ---- | ---- |
| `LanguageModel.create` | CHAIN | Session start — assigns a `session.id` |
| `LanguageModel.promptStreaming` | LLM | Each prompt (streaming) |
| `LanguageModel.destroy` | CHAIN | Session reset |

Spans use [OpenInference](https://arize-ai.github.io/openinference/spec/) attributes: `llm.input_messages`, `llm.output_messages`, `llm.token_count.*`, `session.id` (groups turns into a thread), and `llm.time_to_first_token_ms`.

## Future work

### Client-safe credentials (prerequisite for next phase)

This PoC stores credentials in `sessionStorage` via an in-page dev panel. That avoids committing secrets, but is **not** safe for shipping observability in a public client — exported traces still include prompts and responses, and keys are visible in the browser.

### Typed npm SDK

Publish a typed npm package that bundles OpenTelemetry setup, backend config, and Prompt API instrumentation — so developers add a dependency instead of copying `telemetry.js` or wiring an esm.sh import map.

### Other built-in AI APIs

Extend instrumentation to the other [Chrome built-in AI APIs](https://developer.chrome.com/docs/ai/built-in-apis): Summarizer, Translator, Language Detector, Writer, Rewriter, and Proofreader.
