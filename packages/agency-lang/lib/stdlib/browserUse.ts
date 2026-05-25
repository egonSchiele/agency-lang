import { runHttp } from "./http.js";
import { abortableSleep } from "./abortable.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";

const BASE_URL = "https://api.browser-use.com/api/v3";
const TERMINAL_STATUSES = ["stopped", "error", "timed_out"] as const;
const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes

export type BrowserUseResult = {
  output: string;
  status: string;
  sessionId: string;
};

export type BrowserUseOptions = {
  apiKey?: string;
  model?: string;
  maxCostUsd?: number;
  proxyCountryCode?: string;
  outputSchema?: Record<string, unknown>;
  timeout?: number;
  allowedDomains?: string[];
};

type SessionResponse = {
  id: string;
  status: string;
  output?: string;
  [key: string]: unknown;
};

function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

async function pollSession(
  sessionId: string,
  apiKey: string,
  timeout: number,
  signal: AbortSignal,
): Promise<SessionResponse> {
  const pollInterval = 2000;
  const start = Date.now();
  const url = `${BASE_URL}/sessions/${sessionId}`;

  while (Date.now() - start < timeout) {
    const data = await runHttp(async () => {
      const response = await fetch(url, {
        headers: {
          "X-Browser-Use-API-Key": apiKey,
        },
        signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Browser Use API error polling session (${response.status}): ${body}`
        );
      }

      return (await response.json()) as SessionResponse;
    }, url);

    if (isTerminal(data.status)) {
      return data;
    }

    // abortableSleep tears down the polling delay on cancel so we
    // don't sit waiting 2s after the user has aborted.
    await abortableSleep(pollInterval, signal);
  }

  throw new Error(
    `Browser Use session ${sessionId} timed out after ${timeout / 1000}s`
  );
}

/**
 * Context-injected so the session-creation fetch, the polling fetch,
 * and the inter-poll sleep all see `ctx.getAbortSignal(stack)`. A
 * browser-use task can run for many minutes, and previously an
 * aborted run kept polling the remote service and burning the user's
 * quota.
 */
export async function __internal_browserUse(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  task: string,
  options?: BrowserUseOptions
): Promise<BrowserUseResult> {
  const apiKey = options?.apiKey || process.env.BROWSER_USE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Browser Use API key. Set BROWSER_USE_API_KEY env var or pass apiKey option."
    );
  }

  const timeout = options?.timeout || DEFAULT_TIMEOUT_MS;
  let finalTask = task;
  if (options?.allowedDomains && options.allowedDomains.length > 0) {
    const domainList = options.allowedDomains.join(", ");
    finalTask = `IMPORTANT: You must ONLY navigate to these domains: ${domainList}. Do not visit any other domains.\n\n${task}`;
  }
  const body: Record<string, unknown> = { task: finalTask };

  if (options?.model) body.model = options.model;
  if (options?.maxCostUsd !== undefined) body.maxCostUsd = options.maxCostUsd;
  if (options?.proxyCountryCode)
    body.proxyCountryCode = options.proxyCountryCode;
  if (options?.outputSchema) body.outputSchema = options.outputSchema;

  const signal = ctx.getAbortSignal(stack);
  const sessionsUrl = `${BASE_URL}/sessions`;
  const session = await runHttp(async () => {
    const response = await fetch(sessionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Browser-Use-API-Key": apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(
        `Browser Use API error (${response.status}): ${responseBody}`
      );
    }

    return (await response.json()) as SessionResponse;
  }, sessionsUrl);
  const sessionId = session.id;

  if (isTerminal(session.status)) {
    return {
      output: session.output ?? "",
      status: session.status,
      sessionId,
    };
  }

  const result = await pollSession(sessionId, apiKey, timeout, signal);

  return {
    output: result.output ?? "",
    status: result.status,
    sessionId: result.id,
  };
}
