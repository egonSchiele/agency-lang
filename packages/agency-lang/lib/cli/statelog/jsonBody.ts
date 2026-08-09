// Reading the JSON body every statelog client expects, and describing the
// response when it is not JSON. The description carries what a debugger needs
// on the first failure: which request produced it, the final URL when a
// redirect moved the request, and how the body starts. "non-JSON response"
// alone identifies neither the call site nor the cause — the classic case is
// an http:// host whose https redirect turns an authenticated POST into an
// anonymous GET of the sign-in page, served as HTML with HTTP 200.

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; error: string };

const SNIPPET_LIMIT = 200;

export async function readJsonBody(
  response: Response,
  request: { method: string; url: string },
): Promise<JsonBodyResult> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      error: `${headline(response, request)}\nThe response body could not be read (${message(error)}).`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: describeNonJson(response, request, text) };
  }
}

function describeNonJson(
  response: Response,
  request: { method: string; url: string },
  text: string,
): string {
  const lines = [headline(response, request)];
  // response.url is the FINAL URL after fetch followed any redirects — when it
  // differs from what we asked for, that detour is almost always the story.
  const finalUrl = typeof response.url === "string" ? response.url : "";
  if (finalUrl !== "" && finalUrl !== request.url) {
    lines.push(
      `The request was redirected to ${finalUrl}. An http:// host URL is the usual cause — ` +
        `the https redirect turns a POST into an unauthenticated GET; use https:// in the host.`,
    );
  }
  const snippet = text.replace(/\s+/g, " ").trim();
  lines.push(
    snippet === ""
      ? "The response body was empty."
      : `The response body starts: ${snippet.slice(0, SNIPPET_LIMIT)}${snippet.length > SNIPPET_LIMIT ? "…" : ""}`,
  );
  return lines.join("\n");
}

function headline(response: Response, request: { method: string; url: string }): string {
  return `statelog returned a non-JSON response (HTTP ${response.status}) for ${request.method} ${request.url}.`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
