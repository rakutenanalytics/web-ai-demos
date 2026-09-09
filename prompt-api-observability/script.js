/**
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { marked } from "https://cdn.jsdelivr.net/npm/marked@13.0.3/lib/marked.esm.js";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs";

import { initTelemetry, createInstrumentedSession } from "./telemetry.js";

const NUMBER_FORMAT_LANGUAGE = "en-US";
const SYSTEM_PROMPT = "You are a helpful and friendly assistant.";
const TOOL_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer questions by calling the tools you " +
  "have when you need the current time or the weather in a city. Call every " +
  "tool you need, then answer in one short sentence using only what the " +
  "tools returned.";

const MAX_TOOL_CALLS = 8;

// Mock weather keyed by city. `get_weather` stamps each answer with the
// current time so the model can relate conditions to "now".
const WEATHER = {
  tokyo: { tempC: 24, conditions: "clear" },
  kyoto: { tempC: 22, conditions: "light rain" },
  osaka: { tempC: 26, conditions: "cloudy" },
};

const tools = [
  {
    name: "get_current_time",
    description:
      "Get the current date and time in the user's locale and time zone.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute() {
      const now = new Date();
      return Promise.resolve({
        iso: now.toISOString(),
        local: now.toLocaleString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    },
  },
  {
    name: "get_weather",
    description:
      "Get the current weather for a city at the present moment. Only " +
      "Tokyo, Kyoto and Osaka are known.",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: 'The city name, for example "Kyoto".',
        },
      },
      required: ["city"],
    },
    execute({ city }) {
      const now = new Date();
      const key = String(city ?? "").toLowerCase();
      const base = WEATHER[key];
      if (!base) {
        return Promise.reject(
          new Error(`No weather for "${city}". Try Tokyo, Kyoto or Osaka.`),
        );
      }
      return Promise.resolve({
        city,
        observedAt: now.toISOString(),
        localTime: now.toLocaleString(),
        tempC: base.tempC,
        conditions: base.conditions,
      });
    },
  },
];

const declarations = tools.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

function toolUseSupported() {
  return (
    "LanguageModelToolCall" in self &&
    "LanguageModelToolSuccess" in self &&
    "LanguageModelToolError" in self
  );
}

// Chrome rejects a tool result that contains a JSON null anywhere inside it.
function withoutNulls(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map(withoutNulls);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, withoutNulls(item)]),
    );
  }
  return value;
}

function missingArguments(tool, args) {
  const required = tool.inputSchema?.required ?? [];
  return required.filter((key) => {
    const value = args?.[key];
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    return value === undefined || value === null || value === "";
  });
}

async function runTool(name, args) {
  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      ok: false,
      message: `There is no tool named ${name}.`,
    };
  }

  const missing = missingArguments(tool, args);
  if (missing.length) {
    const list = missing.map((key) => `"${key}"`).join(" and ");
    return {
      ok: false,
      message:
        `${name} was called without ${list}. Call it again and provide ` +
        `${missing.length > 1 ? "those arguments" : "that argument"}.`,
    };
  }

  try {
    const value = await tool.execute(args ?? {});
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

function toolResponsePart(call, outcome) {
  const value = outcome.ok
    ? new LanguageModelToolSuccess({
        callID: call.callID,
        name: call.name,
        result: [{ type: "object", value: withoutNulls(outcome.value) ?? {} }],
      })
    : new LanguageModelToolError({
        callID: call.callID,
        name: call.name,
        errorMessage: outcome.message,
      });
  return { type: "tool-response", value };
}

/**
 * Streams one model turn. Text chunks are passed to `onText` when provided;
 * tool-call chunks are collected for the caller to run.
 */
async function streamTurn(input, onText) {
  const calls = [];
  let text = "";
  let previousChunk = "";

  for await (const chunk of session.promptStreaming(input)) {
    if (typeof chunk !== "string") {
      if (chunk?.type === "tool-call") {
        calls.push(chunk.value);
      }
      continue;
    }

    const newChunk = chunk.startsWith(previousChunk)
      ? chunk.slice(previousChunk.length)
      : chunk;
    text += newChunk;
    previousChunk = chunk;
    onText?.(text);
  }

  return { calls, text };
}

/**
 * Runs the tool loop until the model answers with text. Tool calls happen
 * silently: the UI only sees the final streamed answer, same as a plain turn.
 */
async function promptWithTools(prompt, onText) {
  let { calls, text } = await streamTurn(prompt);

  if (!calls.length) {
    onText(text);
    return text;
  }

  let rounds = 0;
  while (calls.length) {
    if (++rounds > MAX_TOOL_CALLS) {
      throw new Error(
        `Stopped after ${MAX_TOOL_CALLS} tool calls without a final answer.`,
      );
    }

    const responses = [];
    for (const call of calls) {
      const outcome = await runTool(call.name, call.arguments);
      responses.push(toolResponsePart(call, outcome));
    }

    ({ calls, text } = await streamTurn(
      [{ role: "user", content: responses }],
      onText,
    ));
  }

  return text;
}

(async () => {
  const errorMessage = document.getElementById("error-message");
  const costSpan = document.getElementById("cost");
  const promptArea = document.getElementById("prompt-area");
  const problematicArea = document.getElementById("problematic-area");
  const promptInput = document.getElementById("prompt-input");
  const responseArea = document.getElementById("response-area");
  const copyLinkButton = document.getElementById("copy-link-button");
  const resetButton = document.getElementById("reset-button");
  const copyHelper = document.querySelector("small");
  const rawResponse = document.querySelector("details div");
  const form = document.querySelector("form");
  const maxTokensInfo = document.getElementById("max-tokens");
  const tokensLeftInfo = document.getElementById("tokens-left");
  const tokensSoFarInfo = document.getElementById("tokens-so-far");

  await initTelemetry();

  responseArea.style.display = "none";

  let session = null;
  const toolsEnabled = toolUseSupported();

  if (!("LanguageModel" in self)) {
    errorMessage.style.display = "block";
    errorMessage.innerHTML = `Your browser doesn't support the Prompt API. If you're on Chrome, join the <a href="https://goo.gle/chrome-ai-dev-preview-join">Early Preview Program</a> to enable it.`;
    return;
  }

  promptArea.style.display = "block";
  copyLinkButton.style.display = "none";
  copyHelper.style.display = "none";

  const promptModel = async (highlight = false) => {
    copyLinkButton.style.display = "none";
    copyHelper.style.display = "none";
    problematicArea.style.display = "none";
    const prompt = promptInput.value.trim();
    if (!prompt) return;
    responseArea.style.display = "block";
    const heading = document.createElement("h3");
    heading.classList.add("prompt", "speech-bubble");
    heading.textContent = prompt;
    responseArea.append(heading);
    const p = document.createElement("p");
    p.classList.add("response", "speech-bubble");
    p.textContent = "Generating response...";
    responseArea.append(p);

    const renderText = (text) => {
      p.innerHTML = DOMPurify.sanitize(marked.parse(text));
      rawResponse.innerText = text;
    };

    try {
      if (!session) {
        await updateSession();
        updateStats();
      }

      if (toolsEnabled) {
        await promptWithTools(prompt, renderText);
      } else {
        let result = "";
        let previousChunk = "";
        for await (const chunk of session.promptStreaming(prompt)) {
          const newChunk = chunk.startsWith(previousChunk)
            ? chunk.slice(previousChunk.length)
            : chunk;
          result += newChunk;
          renderText(result);
          previousChunk = chunk;
        }
      }
    } catch (error) {
      p.textContent = `Error: ${error.message}`;
    } finally {
      if (highlight) {
        problematicArea.style.display = "block";
        problematicArea.querySelector("#problem").innerText =
          decodeURIComponent(highlight).trim();
      }
      copyLinkButton.style.display = "inline-block";
      copyHelper.style.display = "inline";
      updateStats();
    }
  };

  const updateStats = () => {
    if (!session) {
      return;
    }

    const numberFormat = new Intl.NumberFormat(NUMBER_FORMAT_LANGUAGE);
    const decimalNumberFormat = new Intl.NumberFormat(NUMBER_FORMAT_LANGUAGE, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });

    // In the latest API shape, currently in Chrome Canary, `session.inputQuota` was
    // renamed to `session.contextWindow` and `session.inputUsage` was renamed to
    // `session.contextUsage`. Previously `session.maxTokens` was renamed to
    // `session.inputQuota` and `session.tokensSoFar` was renamed to `session.inputUsage`.
    // `session.tokensSoFar` was removed, but the value can be calculated by subtracting
    // `inputUsage` from `inputQuota`. All APIs shapes are checked in the code below.
    maxTokensInfo.textContent = numberFormat.format(
      session.contextWindow ?? session.inputQuota ?? session.maxTokens,
    );
    tokensLeftInfo.textContent = numberFormat.format(
      session.tokensSoFar ??
        session.contextWindow - session.contextUsage ??
        session.inputQuota - session.inputUsage,
    );
    tokensSoFarInfo.textContent = numberFormat.format(
      session.contextUsage ?? session.inputUsage ?? session.tokensSoFar,
    );
  };

  const params = new URLSearchParams(location.search);
  const urlPrompt = params.get("prompt");
  const highlight = params.get("highlight");
  if (urlPrompt) {
    promptInput.value = decodeURIComponent(urlPrompt).trim();
    await promptModel(highlight);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await promptModel();
  });

  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event("submit"));
    }
  });

  promptInput.addEventListener("focus", () => {
    promptInput.select();
  });

  promptInput.addEventListener("input", async () => {
    if (!session) {
      return;
    }

    const value = promptInput.value.trim();
    if (!value) {
      return;
    }

    let cost;

    // The API that returns the token count for a prompt has been renamed
    // from `countPromptTokens(input)` to `measureInputUsage(input)` to
    // `measureContextUsage(input)`.
    // The code below ensures all cases are handled.
    if (session.countPromptTokens) {
      cost = await session.countPromptTokens(value);
    } else if (session.measureContextUsage) {
      cost = await session.measureContextUsage(value);
    } else if (session.measureInputUsage) {
      cost = await session.measureInputUsage(value);
    }

    if (!cost) {
      return;
    }
    costSpan.textContent = `${cost} token${cost === 1 ? "" : "s"}`;
  });

  const resetUI = () => {
    responseArea.style.display = "none";
    responseArea.innerHTML = "";
    rawResponse.innerHTML = "";
    problematicArea.style.display = "none";
    copyLinkButton.style.display = "none";
    copyHelper.style.display = "none";
    maxTokensInfo.textContent = "";
    tokensLeftInfo.textContent = "";
    tokensSoFarInfo.textContent = "";
    promptInput.focus();
  };

  resetButton.addEventListener("click", async () => {
    promptInput.value = "";
    resetUI();
    session.destroy();
    session = null;
    await updateSession();
  });

  copyLinkButton.addEventListener("click", () => {
    const prompt = promptInput.value.trim();
    if (!prompt) return;
    const url = new URL(self.location.href);
    url.searchParams.set("prompt", encodeURIComponent(prompt));
    const selection = getSelection().toString() || "";
    if (selection) {
      url.searchParams.set("highlight", encodeURIComponent(selection));
    } else {
      url.searchParams.delete("highlight");
    }
    navigator.clipboard.writeText(url.toString()).catch((err) => {
      alert("Failed to copy link: ", err);
    });
    const text = copyLinkButton.textContent;
    copyLinkButton.textContent = "Copied";
    setTimeout(() => {
      copyLinkButton.textContent = text;
    }, 3000);
  });

  const updateSession = async () => {
    if (self.LanguageModel) {
      const options = {
        expectedInputs: toolsEnabled
          ? [
              { type: "text", languages: ["en"] },
              { type: "tool-response" },
            ]
          : [
              {
                type: "text",
                languages: ["en" /* system prompt */, "en" /* user prompt */],
              },
            ],
        expectedOutputs: toolsEnabled
          ? [{ type: "text", languages: ["en"] }, { type: "tool-call" }]
          : [{ type: "text", languages: ["en"] }],
        samplingMode: "creative",
        initialPrompts: [
          {
            role: "system",
            content: toolsEnabled ? TOOL_SYSTEM_PROMPT : SYSTEM_PROMPT,
          },
        ],
      };
      if (toolsEnabled) {
        options.tools = declarations;
      }
      session = await createInstrumentedSession(options);
    }
    resetUI();
    updateStats();
  };

  if (!session) {
    await updateSession();
  }
})();
