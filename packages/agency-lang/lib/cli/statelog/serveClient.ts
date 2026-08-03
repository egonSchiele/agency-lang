// The statelog *serve* wire, sealed here. This is the only file that knows the
// serve routes, the `{ success, value }` envelope, and how a node pause is
// encoded. Callers ask for a manifest, a function value, or an interrupt-driver
// result and never see the transport shape. Every failure — network, HTTP,
// JSON, schema, or a `success:false` body — surfaces as a ServeRequestError.

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
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  async function requestJson(
    url: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: authHeaders,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch (error) {
      throw new ServeRequestError(`could not reach ${url} (${message(error)})`);
    }

    let json: unknown;
    let parsed = true;
    try {
      json = await response.json();
    } catch {
      parsed = false;
    }

    // A non-2xx is a failure even with a valid JSON body — surface it as a
    // ServeRequestError (with the server's message when it gave one) rather than
    // letting a 404/500 body flow on as a bogus value or manifest.
    if (!response.ok) {
      const envelopeError =
        parsed && json !== null && typeof json === "object"
          ? (json as { error?: unknown }).error
          : undefined;
      throw new ServeRequestError(
        typeof envelopeError === "string"
          ? envelopeError
          : `statelog request failed (HTTP ${response.status})`,
      );
    }
    if (!parsed) {
      throw new ServeRequestError(`statelog returned a non-JSON response (HTTP ${response.status})`);
    }
    return json;
  }

  // node/function/resume speak the { success, value } envelope; /list does not.
  async function requestValue(url: string, body: unknown): Promise<unknown> {
    const json = await requestJson(url, "POST", body);
    if (json === null || typeof json !== "object" || typeof (json as { success?: unknown }).success !== "boolean") {
      throw new ServeRequestError("unexpected serve response shape");
    }
    const envelope = json as { success: boolean; value?: unknown; error?: unknown };
    if (!envelope.success) {
      throw new ServeRequestError(
        typeof envelope.error === "string" ? envelope.error : "serve request failed",
      );
    }
    return envelope.value;
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
  if (json === null || typeof json !== "object") {
    throw new ServeRequestError("manifest is not an object");
  }
  const body = json as { nodes?: unknown; functions?: unknown };
  if (!Array.isArray(body.nodes) || !Array.isArray(body.functions)) {
    throw new ServeRequestError("manifest is missing nodes/functions arrays");
  }
  return {
    nodes: body.nodes.map(validateNode),
    functions: body.functions.map(validateFunction),
  };
}

function validateNode(item: unknown): ServeNodeManifest {
  const fields = asManifestObject(item, "node");
  const name = requireString(fields.name, "node name");
  return {
    name,
    parameters: requireStringArray(fields.parameters, `node ${name} parameters`),
    interruptEffects: requireStringArray(fields.interruptEffects, `node ${name} interruptEffects`),
  };
}

function validateFunction(item: unknown): ServeFunctionManifest {
  const fields = asManifestObject(item, "function");
  const name = requireString(fields.name, "function name");
  const manifest: ServeFunctionManifest = {
    name,
    parameters: requireStringArray(fields.parameters, `function ${name} parameters`),
    interruptEffects: requireStringArray(fields.interruptEffects, `function ${name} interruptEffects`),
  };
  if (typeof fields.description === "string") manifest.description = fields.description;
  if (typeof fields.destructive === "boolean") manifest.destructive = fields.destructive;
  if (typeof fields.idempotent === "boolean") manifest.idempotent = fields.idempotent;
  return manifest;
}

function asManifestObject(item: unknown, kind: string): Record<string, unknown> {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new ServeRequestError(`each ${kind} entry must be an object`);
  }
  return item as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ServeRequestError(`${label} must be a string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ServeRequestError(`${label} must be an array of strings`);
  }
  return value as string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
