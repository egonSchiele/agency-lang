// The statelog *serve* wire, sealed here. This is the only file that knows the
// serve routes, the `{ success, value }` envelope, and how a node pause is
// encoded. Callers ask for a manifest, a function value, or an interrupt-driver
// result and never see the transport shape. Every failure — network, HTTP,
// JSON, schema, or a `success:false` body — surfaces as a ServeRequestError.

import { z } from "zod";
import { statelogRequest } from "./statelogRequest.js";
import type { StatelogFailure, StatelogRequestResult } from "./statelogRequest.js";
import { hasInterrupts } from "@/runtime/interrupts.js";
import type { Interrupt } from "@/runtime/interrupts.js";
import { isFailure } from "@/runtime/result.js";
import type { InterruptResult, ResumeFn } from "@/runtime/interruptResolution.js";
import { serveRouteUrl } from "./serveUrl.js";
import type { ServeAddress } from "./serveUrl.js";

export type ServeFunctionManifest = {
  name: string;
  description?: string;
  parameters: string[];
  destructive?: boolean;
  idempotent?: boolean;
  interruptEffects: string[];
};

export type ServeNodeManifest = {
  name: string;
  parameters: string[];
  interruptEffects: string[];
};

export type ServeManifest = {
  functions: ServeFunctionManifest[];
  nodes: ServeNodeManifest[];
};

/** Any serve request that did not produce a usable result. */
export class ServeRequestError extends Error {}

// Wire schemas for the serve manifest. The optional function fields tolerate a
// wrong-typed value by falling back to `undefined` (via `.catch`), matching the
// original hand-rolled leniency: a malformed optional is dropped, not fatal.
const nodeManifestSchema = z.object({
  name: z.string(),
  parameters: z.array(z.string()),
  interruptEffects: z.array(z.string()),
});

const functionManifestSchema = z.object({
  name: z.string(),
  parameters: z.array(z.string()),
  interruptEffects: z.array(z.string()),
  description: z.string().optional().catch(undefined),
  destructive: z.boolean().optional().catch(undefined),
  idempotent: z.boolean().optional().catch(undefined),
});

const manifestSchema = z.object({
  nodes: z.array(nodeManifestSchema),
  functions: z.array(functionManifestSchema),
});

export type ServeClient = {
  /** GET /list, validated. */
  fetchManifest(): Promise<ServeManifest>;
  /** POST /node/:name — a final value or a pause, as an InterruptResult. */
  invokeNode(name: string, args: Record<string, unknown>): Promise<InterruptResult>;
  /** POST /function/:name — one-shot, never pauses. */
  invokeFunction(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** POST /resume — the shape the shared interrupt driver expects. */
  resume: ResumeFn<InterruptResult>;
};

export function createServeClient(address: ServeAddress, apiKey: string): ServeClient {
  function toServeError(failure: StatelogFailure, url: string): ServeRequestError {
    switch (failure.kind) {
      case "unreachable":
        // Serve names the full URL, not the origin.
        return new ServeRequestError(`could not reach ${url} (${failure.cause})`);
      case "http":
        // A non-2xx is a failure even with a valid JSON body — surface the
        // server's message when it gave one rather than letting a 404/500
        // body flow on as a bogus value or manifest.
        return new ServeRequestError(
          failure.serverError ?? `statelog request failed (HTTP ${failure.status})`,
        );
      case "non-json":
        return new ServeRequestError(failure.diagnostic);
      case "bad-envelope":
        return new ServeRequestError("unexpected serve response shape");
      case "envelope-error":
        return new ServeRequestError(failure.serverError ?? "serve request failed");
    }
  }

  // node/function/resume speak the { success, value } envelope; /list does not.
  // Serve has always sent Content-Type on every call (bodyless GET /list
  // included) and serialized {} for an undefined POST body — wire behavior,
  // preserved via contentType:"always" and body ?? {}.
  async function request(
    url: string,
    method: "GET" | "POST",
    body: unknown,
    envelope: boolean,
  ): Promise<unknown> {
    let result: StatelogRequestResult;
    try {
      result = await statelogRequest({
        method,
        url,
        apiKey,
        body: method === "POST" ? (body ?? {}) : undefined,
        envelope,
        contentType: "always",
      });
    } catch (error) {
      // Serve historically serialized the body inside its fetch try, so an
      // unserializable body surfaced as could-not-reach. The core's only
      // pre-fetch throw here is serialization (serve passes no sanitizer);
      // preserve that serve-specific mapping.
      throw new ServeRequestError(`could not reach ${url} (${message(error)})`);
    }
    if (!result.ok) {
      throw toServeError(result.failure, url);
    }
    return result.value;
  }

  function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function requestJson(
    url: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> {
    return request(url, method, body, false);
  }

  async function requestValue(url: string, body: unknown): Promise<unknown> {
    return request(url, "POST", body, true);
  }

  async function fetchManifest(): Promise<ServeManifest> {
    const json = await requestJson(serveRouteUrl(address.serveUrl, ["list"]), "GET");
    return validateManifest(json);
  }

  async function invokeNode(name: string, args: Record<string, unknown>): Promise<InterruptResult> {
    const value = await requestValue(serveRouteUrl(address.serveUrl, ["node", name]), args);
    return toInterruptResult(value);
  }

  async function invokeFunction(name: string, args: Record<string, unknown>): Promise<unknown> {
    const value = await requestValue(serveRouteUrl(address.serveUrl, ["function", name]), args);
    throwIfAgentFailure(value);
    return value;
  }

  const resume: ResumeFn<InterruptResult> = async (interrupts, responses) => {
    const value = await requestValue(serveRouteUrl(address.serveUrl, ["resume"]), {
      interrupts,
      responses,
    });
    return toInterruptResult(value);
  };

  return { fetchManifest, invokeNode, invokeFunction, resume };
}

/**
 * A node/resume success value is a *pause* only when it carries a serialized
 * `state` string AND a non-empty runtime `Interrupt[]`. Anything else — a plain
 * value, or a final result that happens to have an `interrupts` field — is the
 * final value. Pauses become `{ data: interrupts }` so the shared driver's
 * `hasInterrupts(data)` loops; final values become `{ data: value }`.
 */
function toInterruptResult(value: unknown): InterruptResult {
  if (value !== null && typeof value === "object") {
    const wrapped = value as { state?: unknown; interrupts?: unknown };
    if (typeof wrapped.state === "string" && hasInterrupts(wrapped.interrupts)) {
      return { data: wrapped.interrupts as Interrupt[] };
    }
  }
  // A final value that is a failed AgencyResult is an agent failure, not a
  // result to print — surface it as an error (a served function that raises an
  // unhandled interrupt lands here, one-shot, wrapped in the success envelope).
  throwIfAgentFailure(value);
  return { data: value };
}

/** The serve adapter wraps a function/node's own result in its success
 *  envelope, so a failed AgencyResult arrives as a "successful" value. Treat it
 *  as the failure it is. A *successful* Result passes through untouched. */
function throwIfAgentFailure(value: unknown): void {
  if (isFailure(value)) {
    const error = (value as { error?: unknown }).error;
    throw new ServeRequestError(
      typeof error === "string" ? error : "the served agent returned a failure",
    );
  }
}

function validateManifest(json: unknown): ServeManifest {
  return parseValue(manifestSchema, json);
}

/** Validate a wire value against a schema, surfacing any failure as a
 *  ServeRequestError with the offending field path. */
function parseValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new ServeRequestError(
      `unexpected serve manifest value: ${where}${issue?.message ?? "invalid"}`,
    );
  }
  return result.data;
}
