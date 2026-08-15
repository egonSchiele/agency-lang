// The statelog project-secrets API (`/api/projects/:slug/secrets*`), sealed
// here. The store is WRITE-ONLY — no route ever returns a secret's value, and
// this client must uphold the same property on the error path: everything a
// response could echo back (the submitted value, the API key) is redacted from
// every failure before it can reach an error message. Raw diagnostic text is
// sanitized inside readJsonBody BEFORE whitespace collapsing/truncation (a
// value containing whitespace or spanning the snippet cutoff would otherwise
// survive); parsed server messages are redacted here, post-parse.

import { z } from "zod";
import { statelogRequest } from "./statelogRequest.js";
import type { StatelogFailure } from "./statelogRequest.js";
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

  /** The mapper owns redaction: every string a failure can carry — the
   *  unreachable message as a WHOLE (a sensitive value in the ORIGIN must
   *  redact, not only one in the cause), server errors, and diagnostics
   *  (already sanitized by the seam; redacting again is harmless defense in
   *  depth) — passes through the per-verb redactor before an error exists. */
  function toSecretError(
    failure: StatelogFailure,
    redact: (text: string) => string,
  ): SecretRequestError {
    switch (failure.kind) {
      case "unreachable":
        return new SecretRequestError(redact(`could not reach ${origin} (${failure.cause})`));
      case "http":
        if (failure.status === 404) {
          // Match the error FIELD, not the whole object — extra response
          // fields must not turn a project error into an upgrade message. Any
          // other 404 means the host predates the secrets routes.
          if (failure.serverError === "Project not found") {
            return new SecretRequestError(
              `project '${projectSlug}' not found — check the slug, or that it's deployed`,
              404,
            );
          }
          return new SecretRequestError(
            "this statelog host does not support the secrets API (upgrade the host)",
            404,
          );
        }
        return new SecretRequestError(
          failure.serverError !== undefined
            ? redact(failure.serverError)
            : `statelog request failed (HTTP ${failure.status})`,
          failure.status,
        );
      case "non-json":
        return new SecretRequestError(redact(failure.diagnostic), failure.status);
      case "bad-envelope":
        return new SecretRequestError("unexpected secrets response shape", failure.status);
      case "envelope-error":
        return new SecretRequestError(
          failure.serverError !== undefined
            ? redact(failure.serverError)
            : "secrets request failed",
          failure.status,
        );
    }
  }

  async function request(input: SecretRequest): Promise<{ value: unknown; status: number }> {
    const redact = (text: string) => redactValues(text, [apiKey, ...input.sensitive]);
    const result = await statelogRequest({
      method: input.method,
      url: routeUrl(input.segments),
      apiKey,
      body: input.body,
      sanitizeDiagnostic: redact,
    });
    if (!result.ok) {
      throw toSecretError(result.failure, redact);
    }
    return { value: result.value, status: result.status };
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
