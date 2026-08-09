// `agency remote secrets` — thin recipes over the sealed secrets client. The
// store is write-only (no route returns a value), and these recipes uphold the
// CLI's matching invariants: a value reaches `set` only through injected seams
// (never argv), and no code path prints one — presentSecretError is the single
// place that composes redaction, terminal-safe escaping, and trusted auth
// guidance, in that order. Recipes render and return semantic outcomes; the
// Commander actions own process.exitCode.

import * as fs from "fs";
import * as path from "path";
import { color } from "@/utils/termcolors.js";
import { resolveProjectTarget, fail } from "./util.js";
import type { ProjectCommandOptions, RemoteCommandContext } from "./util.js";
import { createSecretsClient, SecretRequestError } from "../../statelog/secretsClient.js";
import type { SecretMetadata, SecretsClient } from "../../statelog/secretsClient.js";
import { redactValues } from "../../statelog/redact.js";
import { resolveSecretValue, parseEnvSource, terminalSafe } from "../secretsInput.js";
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
  console.log(`${color.green("Set")} secret ${terminalSafe(name)}.`);
  // The hint shows real call-site syntax, so the name renders as an actual
  // string literal — JSON.stringify quotes AND escapes it in one step (a
  // terminalSafe'd name would end up double-quoted here).
  console.log(`Available to hosted runs as env(${JSON.stringify(name)}) from the next invocation.`);
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

export type ImportResult =
  | { kind: "declined" }
  | { kind: "succeeded" }
  | { kind: "failed" };

export type SecretsImportIO = {
  stdinIsTty: boolean;
  readStdin: () => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
};

type ImportOutcome = { name: string; ok: boolean; message?: string };

export async function runSecretsImport(
  file: string | undefined,
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
  io: SecretsImportIO,
): Promise<ImportResult> {
  const target = resolveProjectTarget(context, options);
  const fromStdin = file === "-";
  const sourceName = fromStdin ? "<stdin>" : (file ?? ".env");
  // The file argument is user/argv-controlled display text like any other.
  const safeSource = terminalSafe(sourceName);

  let text: string;
  if (fromStdin) {
    text = await io.readStdin();
  } else {
    const sourcePath = path.resolve(process.cwd(), sourceName);
    try {
      text = fs.readFileSync(sourcePath, "utf-8");
    } catch (error) {
      fail(`Could not read ${safeSource}: ${errorMessage(error)}`);
    }
  }

  const { entries } = parseEnvSource(text);
  if (entries.length === 0) {
    fail(`No variables found in ${safeSource}.`);
  }

  // Confirmation is for FILE sources on a TTY only. An explicit `-` never
  // prompts: after an interactive stdin entry the stream is exhausted at EOF,
  // and choosing `-` is itself the authorization.
  if (!fromStdin && io.stdinIsTty) {
    const plural = entries.length === 1 ? "" : "s";
    console.log(
      `Import ${entries.length} secret${plural} into project ${target.projectSlug} from ${safeSource}:`,
    );
    for (const entry of entries) {
      console.log(`  ${terminalSafe(entry.name)}`);
    }
    if (!(await io.confirm("Continue?"))) {
      console.log("Canceled.");
      return { kind: "declined" };
    }
  }

  const allValues = entries.map((entry) => entry.value);
  const client = createSecretsClient(target.origin, target.projectSlug, target.apiKey);
  const outcomes: ImportOutcome[] = [];
  for (const entry of entries) {
    if (entry.value === "") {
      outcomes.push({ name: entry.name, ok: false, message: "empty value — nothing sent" });
      continue;
    }
    try {
      // The whole batch joins the FIRST redaction pass: a response echoing a
      // DIFFERENT import's value that overlaps this one would otherwise be
      // partially destroyed before the presenter's pass could match it.
      await client.set(entry.name, entry.value, { alsoRedact: allValues });
      outcomes.push({ name: entry.name, ok: true });
    } catch (error) {
      if (!(error instanceof SecretRequestError)) {
        throw error;
      }
      outcomes.push({
        name: entry.name,
        ok: false,
        message: presentSecretError(error, allValues),
      });
    }
  }

  renderImportSummary(outcomes);
  return outcomes.some((outcome) => !outcome.ok) ? { kind: "failed" } : { kind: "succeeded" };
}

function renderImportSummary(outcomes: ImportOutcome[]): void {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const setCount = outcomes.length - failed.length;
  if (failed.length === 0) {
    const plural = setCount === 1 ? "" : "s";
    console.log(`${color.green("Imported")} ${setCount} secret${plural}.`);
    return;
  }
  console.log(`Imported ${setCount} of ${outcomes.length}; ${failed.length} failed:`);
  for (const outcome of failed) {
    console.log(`  ${terminalSafe(outcome.name)}: ${outcome.message}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
