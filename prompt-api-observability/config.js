/**
 * Copyright 2026 Rakuten Group, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client-side telemetry configuration. Credentials live in sessionStorage
 * (set via the in-page dev panel) — never in committed files.
 */

const STORAGE_KEY = "prompt-api-observability:telemetry-config";

/** @typedef {"console"|"langfuse"|"langsmith"} TelemetryBackend */

/** @typedef {{
 *   backend: TelemetryBackend,
 *   serviceName: string,
 *   langfuse: { baseUrl: string, publicKey: string, secretKey: string },
 *   langsmith: { baseUrl: string, apiKey: string, project: string },
 * }} TelemetryConfig */

/** @returns {TelemetryConfig} */
export function defaultTelemetryConfig() {
  return {
    backend: "console",
    serviceName: "prompt-api-observability",
    langfuse: {
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "",
      secretKey: "",
    },
    langsmith: {
      baseUrl: "https://api.smith.langchain.com",
      apiKey: "",
      project: "prompt-api-observability",
    },
  };
}

/** @returns {TelemetryConfig} */
export function loadTelemetryConfig() {
  /** @type {TelemetryConfig} */
  let config = defaultTelemetryConfig();

  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      config = { ...config, ...JSON.parse(stored) };
      config.langfuse = { ...defaultTelemetryConfig().langfuse, ...config.langfuse };
      config.langsmith = { ...defaultTelemetryConfig().langsmith, ...config.langsmith };
    }
  } catch (err) {
    console.warn("[telemetry] invalid sessionStorage config:", err);
  }

  const params = new URLSearchParams(location.search);
  const backend = params.get("backend");
  if (backend === "console" || backend === "langfuse" || backend === "langsmith") {
    config.backend = backend;
  }
  const serviceName = params.get("service-name");
  if (serviceName) config.serviceName = serviceName;

  return config;
}

export function clearTelemetryConfig() {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** @param {TelemetryConfig} config */
export function saveTelemetryConfig(config) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** @param {TelemetryConfig} config */
export function toTelemetryOptions(config) {
  const base = { serviceName: config.serviceName || "prompt-api-observability" };

  if (config.backend === "console") {
    return { ...base, mode: "console" };
  }

  switch (config.backend) {
    case "langfuse": {
      const { baseUrl, publicKey, secretKey } = config.langfuse;
      const auth = btoa(`${publicKey}:${secretKey}`);
      return {
        ...base,
        mode: "otlp",
        otlpUrl: `${trimSlash(baseUrl)}/api/public/otel/v1/traces`,
        otlpHeaders: {
          Authorization: `Basic ${auth}`,
          "x-langfuse-ingestion-version": "4",
        },
      };
    }
    case "langsmith": {
      const { baseUrl, apiKey, project } = config.langsmith;
      return {
        ...base,
        mode: "otlp",
        otlpUrl: `${trimSlash(baseUrl)}/otel/v1/traces`,
        otlpHeaders: { "x-api-key": apiKey, "Langsmith-Project": project },
        resourceAttributes: { "langsmith.project": project },
      };
    }
    default:
      return { ...base, mode: "console" };
  }
}

function trimSlash(url) {
  return url.replace(/\/+$/, "");
}
