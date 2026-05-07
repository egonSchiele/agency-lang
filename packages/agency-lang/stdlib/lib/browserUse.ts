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
  timeout: number
): Promise<SessionResponse> {
  const pollInterval = 2000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const response = await fetch(`${BASE_URL}/sessions/${sessionId}`, {
      headers: {
        "X-Browser-Use-API-Key": apiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Browser Use API error polling session (${response.status}): ${body}`
      );
    }

    const data = (await response.json()) as SessionResponse;

    if (isTerminal(data.status)) {
      return data;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Browser Use session ${sessionId} timed out after ${timeout / 1000}s`
  );
}

export async function _browserUse(
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

  const response = await fetch(`${BASE_URL}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Browser Use API error (${response.status}): ${responseBody}`
    );
  }

  const session = (await response.json()) as SessionResponse;
  const sessionId = session.id;

  if (isTerminal(session.status)) {
    return {
      output: session.output ?? "",
      status: session.status,
      sessionId,
    };
  }

  const result = await pollSession(sessionId, apiKey, timeout);

  return {
    output: result.output ?? "",
    status: result.status,
    sessionId: result.id,
  };
}
