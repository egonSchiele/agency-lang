const BASE_URL = "https://api.browser-use.com/api/v3";
const TERMINAL_STATUSES = ["stopped", "error", "timed_out"];
function isTerminal(status) {
    return TERMINAL_STATUSES.includes(status);
}
async function pollSession(sessionId, apiKey) {
    const pollInterval = 2000;
    const maxWait = 600000; // 10 minutes
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        const response = await fetch(`${BASE_URL}/sessions/${sessionId}`, {
            headers: {
                "X-Browser-Use-API-Key": apiKey,
            },
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Browser Use API error polling session (${response.status}): ${body}`);
        }
        const data = (await response.json());
        if (isTerminal(data.status)) {
            return data;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    throw new Error(`Browser Use session ${sessionId} timed out after ${maxWait / 1000}s`);
}
export async function _browserUse(task, options) {
    const apiKey = options?.apiKey || process.env.BROWSER_USE_API_KEY;
    if (!apiKey) {
        throw new Error("Missing Browser Use API key. Set BROWSER_USE_API_KEY env var or pass apiKey option.");
    }
    const body = { task };
    if (options?.model)
        body.model = options.model;
    if (options?.maxCostUsd !== undefined)
        body.maxCostUsd = options.maxCostUsd;
    if (options?.proxyCountryCode)
        body.proxyCountryCode = options.proxyCountryCode;
    if (options?.outputSchema)
        body.outputSchema = options.outputSchema;
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
        throw new Error(`Browser Use API error (${response.status}): ${responseBody}`);
    }
    const session = (await response.json());
    const sessionId = session.id;
    if (isTerminal(session.status)) {
        return {
            output: session.output ?? "",
            status: session.status,
            sessionId,
        };
    }
    const result = await pollSession(sessionId, apiKey);
    return {
        output: result.output ?? "",
        status: result.status,
        sessionId: result.id,
    };
}
