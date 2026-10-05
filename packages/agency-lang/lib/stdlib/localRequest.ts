import { mlxBaseUrl, isNoServerError } from "./mlxServerModels.js";

/** Posting a request to the server `agency local serve` runs. Every
 *  caller goes through `postLocalJson`: the image provider, the vision
 *  helpers, and the functions `agency-lang/local` exports. */

/** Where to send one request, and how its caller cancels it.
 *
 *  baseUrl  the server's address, such as `http://127.0.0.1:8080/v1`.
 *           Absent: `client.baseUrl.mlx`, then `MLX_BASE_URL`, then the
 *           default
 *  signal   aborting it ends the request with the `CANCELLED` failure */
export type LocalRequestOptions = { baseUrl?: string; signal?: AbortSignal };

/** The server's reply as parsed JSON, or why there is none. */
export type LocalReply = { reply: Record<string, unknown> } | { error: string };

/** The failure a caller gets when it aborts its own request. */
export const CANCELLED = "Cancelled";

/** The request's signal: the timeout, joined with the caller's signal
 *  when there is one. */
function requestSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/** A failed fetch's message, with the cause's code when it has one:
 *  "fetch failed (ECONNREFUSED)". */
function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return `${(err as Error).message}${cause === undefined ? "" : ` (${cause})`}`;
}

/** Posts `body` as JSON to `route` on the local server and returns the
 *  parsed reply. `serverNoun` is "image" or "vision", for the messages. A
 *  reply that is not a success returns the server's own error message.
 *
 *  A caller that aborts gets `CANCELLED`, whether the abort lands while
 *  the request is waiting or while the reply's body is arriving. A request
 *  that runs out of time keeps the timeout's own message. */
export async function postLocalJson(
  route: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  serverNoun: string,
  options: LocalRequestOptions = {},
): Promise<LocalReply> {
  const cancelled = () => options.signal?.aborted === true;
  let res: Response;
  try {
    res = await fetch(`${mlxBaseUrl(options.baseUrl)}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal(timeoutMs, options.signal),
    });
  } catch (err) {
    return { error: cancelled() ? CANCELLED : describeFetchError(err) };
  }
  let reply: Record<string, unknown>;
  try {
    reply = (await res.json()) as Record<string, unknown>;
  } catch {
    if (cancelled()) {
      return { error: CANCELLED };
    }
    return {
      error: `The ${serverNoun} server answered ${res.status} with a body that is not JSON.`,
    };
  }
  if (!res.ok) {
    const message = (reply.error as { message?: unknown } | undefined)?.message;
    return {
      error:
        typeof message === "string" ? message : `The ${serverNoun} server answered ${res.status}.`,
    };
  }
  return { reply };
}

/** `error`, or what to do about it when it means no server is running at
 *  `baseUrl`. `serveCommand` is the command that starts one. */
export function explainNoServer(error: string, baseUrl: string, serveCommand: string): string {
  if (!isNoServerError(error)) {
    return error;
  }
  return `no local model server answered at ${baseUrl}. Start one with:\n  ${serveCommand}`;
}
