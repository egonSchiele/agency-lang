// The statelog project-secrets API (`/api/projects/:slug/secrets*`), sealed
// here. The store is WRITE-ONLY — no route ever returns a secret's value, and
// this client must uphold the same property on the error path: everything a
// response could echo back (the submitted value, the API key) is redacted from
// every failure before it can reach an error message. Raw diagnostic text is
// sanitized inside readJsonBody BEFORE whitespace collapsing/truncation (a
// value containing whitespace or spanning the snippet cutoff would otherwise
// survive); parsed server messages are redacted here, post-parse.

import { z } from "zod";
import { readJsonBody } from "./jsonBody.js";
import { redactValues } from "./redact.js";

export type SecretMetadata = { name: string; createdAt: string; updatedAt: string };

export class SecretRequestError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type SecretsClient = {
  /** `alsoRedact`: additional sensitive values (e.g. the whole import batch)
   *  that must join the FIRST redaction pass. A later pass cannot recover a
   *  value the first pass partially destroyed — if one value overlaps another,
   *  redacting only the current one can leave the other's suffix visible. */
  set(name: string, value: string, options?: { alsoRedact?: string[] }): Promise<SecretMetadata>;
  list(): Promise<SecretMetadata[]>;
  delete(name: string): Promise<SecretMetadata>;
};

const secretMetadataSchema: z.ZodType<SecretMetadata> = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type SecretRequest = {
  method: "GET" | "POST" | "DELETE";
  segments: string[];
  body?: Record<string, unknown>;
  /** Sensitive values beyond the API key (the submitted secret on `set`). */
  sensitive: string[];
};

export function createSecretsClient(
  origin: string,
  projectSlug: string,
  apiKey: string,
): SecretsClient {
  function routeUrl(segments: string[]): string {
    const path = ["api", "projects", projectSlug, "secrets", ...segments]
      .map(encodeURIComponent)
      .join("/");
    return new URL(`/${path}`, origin).toString();
  }

  async function request(input: SecretRequest): Promise<{ value: unknown; status: number }> {
    const redact = (text: string) => redactValues(text, [apiKey, ...input.sensitive]);
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    const init: RequestInit = { method: input.method, headers };
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }

    const url = routeUrl(input.segments);
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new SecretRequestError(redact(`could not reach ${origin} (${message(error)})`));
    }

    const parsed = await readJsonBody(
      response,
      { method: input.method, url },
      { sanitizeDiagnostic: redact },
    );

    // Non-2xx first: auth middleware returns a bare `{ error }`, not an envelope.
    if (!response.ok) {
      const serverError = parsed.ok ? asObject(parsed.value)?.error : undefined;
      if (response.status === 404) {
        // Match the error FIELD, not the whole object — extra response fields
        // must not turn a project error into an upgrade message. Any other 404
        // means the host predates the secrets routes.
        if (serverError === "Project not found") {
          throw new SecretRequestError(
            `project '${projectSlug}' not found — check the slug, or that it's deployed`,
            404,
          );
        }
        throw new SecretRequestError(
          "this statelog host does not support the secrets API (upgrade the host)",
          404,
        );
      }
      if (typeof serverError === "string") {
        throw new SecretRequestError(redact(serverError), response.status);
      }
      throw new SecretRequestError(
        `statelog request failed (HTTP ${response.status})`,
        response.status,
      );
    }

    if (!parsed.ok) {
      // Already sanitized by the diagnostic seam; redact again for the
      // post-parse fields the seam cannot see. Double redaction is harmless.
      throw new SecretRequestError(redact(parsed.error), response.status);
    }
    const envelope = asObject(parsed.value);
    if (!envelope || typeof envelope.success !== "boolean") {
      throw new SecretRequestError("unexpected secrets response shape", response.status);
    }
    if (!envelope.success) {
      throw new SecretRequestError(
        typeof envelope.error === "string" ? redact(envelope.error) : "secrets request failed",
        response.status,
      );
    }
    return { value: envelope.value, status: response.status };
  }

  function parseWire<T>(
    schema: z.ZodType<T>,
    response: { value: unknown; status: number },
    sensitive: string[],
  ): T {
    const result = schema.safeParse(response.value);
    if (!result.success) {
      throw new SecretRequestError(
        redactValues(
          `unexpected secrets response value: ${result.error.issues[0]?.message ?? "invalid"}`,
          [apiKey, ...sensitive],
        ),
        response.status,
      );
    }
    return result.data;
  }

  return {
    async set(name, value, options = {}) {
      const sensitive = [value, ...(options.alsoRedact ?? [])];
      return parseWire(
        secretMetadataSchema,
        await request({ method: "POST", segments: [], body: { name, value }, sensitive }),
        sensitive,
      );
    },
    async list() {
      return parseWire(
        z.array(secretMetadataSchema),
        await request({ method: "GET", segments: [], sensitive: [] }),
        [],
      );
    },
    async delete(name) {
      return parseWire(
        secretMetadataSchema,
        await request({ method: "DELETE", segments: [name], sensitive: [] }),
        [],
      );
    },
  };
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
