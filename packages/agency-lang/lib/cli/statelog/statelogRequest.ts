// The one place that talks HTTP to statelog. Every sealed client in this
// directory builds its URL, calls statelogRequest, and maps the returned
// failure to its own error type and wording — the core returns failures as
// data, formats no user-facing messages, and builds no URLs. Commands never
// call this directly; they use the sealed family clients.
//
// The core returns transport and response-protocol failures as data.
// Programmer errors — a body JSON.stringify cannot serialize, a sanitizer
// callback that throws — propagate as exceptions; inventing a failure kind
// for them would launder bugs into user-facing error text.

import { readJsonBody } from "./jsonBody.js";

/** Everything that can go wrong with one request, as data. */
export type StatelogFailure =
  | { kind: "unreachable"; cause: string }
  | { kind: "non-json"; status: number; diagnostic: string }
  | { kind: "http"; status: number; serverError?: string }
  | { kind: "bad-envelope"; status: number }
  | { kind: "envelope-error"; status: number; serverError?: string };

export type StatelogRequestOptions = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Families build their own URLs; the core receives a finished one. */
  url: string;
  apiKey: string;
  /** JSON.stringify'd (exactly once) when present. */
  body?: unknown;
  /** Unwrap the { success, value | error } envelope. Default true; serve's
   *  bare-JSON /list manifest passes false. */
  envelope?: boolean;
  /** Default true: a non-2xx response is an `http` failure, and that
   *  classification wins over non-json and envelope handling. uploadClient
   *  passes false — its route's settled semantics let the envelope decide the
   *  outcome regardless of status. */
  requireOk?: boolean;
  /** Default "when-body". serveClient passes "always" — it has always sent
   *  Content-Type on bodyless GETs, and dropping a header is a wire change. */
  contentType?: "when-body" | "always";
  /** Diagnostic-only redaction, forwarded to readJsonBody. */
  sanitizeDiagnostic?: (raw: string) => string;
};

export type StatelogRequestResult =
  | { ok: true; value: unknown; status: number }
  | { ok: false; failure: StatelogFailure };

export async function statelogRequest(
  options: StatelogRequestOptions,
): Promise<StatelogRequestResult> {
  const envelope = options.envelope ?? true;
  const requireOk = options.requireOk ?? true;
  // Serialize before the fetch try: an unserializable body is a programmer
  // error and must propagate, never classify as `unreachable`.
  const serializedBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  const sendContentType = options.contentType === "always" || serializedBody !== undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}` };
  if (sendContentType) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(options.url, {
      method: options.method,
      headers,
      body: serializedBody,
    });
  } catch (error) {
    return { ok: false, failure: { kind: "unreachable", cause: message(error) } };
  }

  const parsed = await readJsonBody(
    response,
    { method: options.method, url: options.url },
    { sanitizeDiagnostic: options.sanitizeDiagnostic },
  );

  // Non-2xx wins over non-json and envelope handling (the families' pinned
  // precedence): extract a string server error only when parsing succeeded —
  // from a bare { error } or an envelope's error field.
  if (requireOk && !response.ok) {
    const failure: StatelogFailure = { kind: "http", status: response.status };
    if (parsed.ok) {
      const serverError = asObject(parsed.value)?.error;
      if (typeof serverError === "string") {
        failure.serverError = serverError;
      }
    }
    return { ok: false, failure };
  }

  if (!parsed.ok) {
    return {
      ok: false,
      failure: { kind: "non-json", status: response.status, diagnostic: parsed.error },
    };
  }

  if (!envelope) {
    return { ok: true, value: parsed.value, status: response.status };
  }

  const envelopeObject = asObject(parsed.value);
  if (!envelopeObject || typeof envelopeObject.success !== "boolean") {
    return { ok: false, failure: { kind: "bad-envelope", status: response.status } };
  }
  if (!envelopeObject.success) {
    const failure: StatelogFailure = { kind: "envelope-error", status: response.status };
    if (typeof envelopeObject.error === "string") {
      failure.serverError = envelopeObject.error;
    }
    return { ok: false, failure };
  }
  return { ok: true, value: envelopeObject.value, status: response.status };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
