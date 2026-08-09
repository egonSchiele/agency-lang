// `agency remote secrets` — thin recipes over the sealed secrets client. The
// store is write-only (no route returns a value), and these recipes uphold the
// CLI's matching invariants: a value reaches `set` only through injected seams
// (never argv), and no code path prints one — presentSecretError is the single
// place that composes redaction, terminal-safe escaping, and trusted auth
// guidance, in that order. Recipes render and return semantic outcomes; the
// Commander actions own process.exitCode.

import { color } from "@/utils/termcolors.js";
import { resolveProjectTarget, fail } from "./util.js";
import type { ProjectCommandOptions, RemoteCommandContext } from "./util.js";
import { createSecretsClient, SecretRequestError } from "../../statelog/secretsClient.js";
import type { SecretMetadata, SecretsClient } from "../../statelog/secretsClient.js";
import { redactValues } from "../../statelog/redact.js";
import { resolveSecretValue, terminalSafe } from "../secretsInput.js";
import type { SecretValueSources } from "../secretsInput.js";

/** The set recipe's terminal dependencies, injected by the Commander action
 *  and faked in tests. Same fields as SecretValueSources minus fromEnv, which
 *  arrives via options. */
export type SecretsSetIO = Omit<SecretValueSources, "fromEnv">;

export type SecretsSetResult = { kind: "set" } | { kind: "canceled" };

/** THE one presenter for SecretRequestError, used by all four recipes
 *  (including every collected import failure): redacts any additional known
 *  values BEFORE terminal-safe escaping, then appends the trusted one-line
 *  full-access-key guidance on status 401/403. Stays one line so import
 *  summaries keep one outcome per line. */
export function presentSecretError(
  error: SecretRequestError,
  sensitiveValues: string[] = [],
): string {
  const safe = terminalSafe(redactValues(error.message, sensitiveValues));
  if (error.status === 401 || error.status === 403) {
    return `${safe} — Secret management needs a full-access API key; invoke-only keys and sessions are rejected.`;
  }
  return safe;
}

export async function runSecretsSet(
  name: string,
  options: ProjectCommandOptions & { fromEnv?: string },
  context: RemoteCommandContext,
  io: SecretsSetIO,
): Promise<SecretsSetResult> {
  const target = resolveProjectTarget(context, options);
  const resolved = await resolveSecretValue(name, { ...io, fromEnv: options.fromEnv });
  if (resolved.kind === "canceled") {
    console.log("Canceled.");
    return { kind: "canceled" };
  }
  if (resolved.kind === "error") {
    fail(resolved.message);
  }
  const client = createSecretsClient(target.origin, target.projectSlug, target.apiKey);
  try {
    await client.set(name, resolved.value);
  } catch (error) {
    failSecretRequest(error);
  }
  const safeName = terminalSafe(name);
  console.log(`${color.green("Set")} secret ${safeName}.`);
  console.log(`Available to hosted runs as env("${safeName}") from the next invocation.`);
  return { kind: "set" };
}

export async function runSecretsList(
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const client = clientFor(options, context);
  let secrets: SecretMetadata[];
  try {
    secrets = await client.list();
  } catch (error) {
    failSecretRequest(error);
  }
  console.log(formatSecretsTable(secrets));
}

export async function runSecretsRm(
  name: string,
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const client = clientFor(options, context);
  try {
    await client.delete(name);
  } catch (error) {
    failSecretRequest(error);
  }
  console.log(`${color.green("Removed")} secret ${terminalSafe(name)}.`);
}

function clientFor(
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
): SecretsClient {
  const target = resolveProjectTarget(context, options);
  return createSecretsClient(target.origin, target.projectSlug, target.apiKey);
}

function failSecretRequest(error: unknown): never {
  if (!(error instanceof SecretRequestError)) {
    throw error;
  }
  fail(presentSecretError(error));
}

function formatSecretsTable(secrets: SecretMetadata[]): string {
  if (secrets.length === 0) {
    return "No secrets set for this project. Use 'agency remote secrets set <NAME>' to add one.";
  }
  const rows = secrets.map((secret) => ({
    name: terminalSafe(secret.name),
    created: secret.createdAt.slice(0, 10),
    updated: secret.updatedAt.slice(0, 10),
  }));
  const headers = { name: "Name", created: "Created", updated: "Updated" };
  const columns = ["name", "created", "updated"] as const;
  const width = (column: (typeof columns)[number]) =>
    Math.max(headers[column].length, ...rows.map((row) => row[column].length)) + 2;
  const render = (row: Record<(typeof columns)[number], string>) =>
    columns
      .map((column, index) =>
        index === columns.length - 1 ? row[column] : row[column].padEnd(width(column)),
      )
      .join("");
  return [render(headers), ...rows.map(render)].join("\n");
}
