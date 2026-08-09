// The `remote` schedule backend: schedules that live on a hosted statelog
// server, not in the local registry. Pure resolvers translate CLI options into
// declarative requests for the sealed schedules client; thin async recipes
// sequence target resolution, deployment policy, and the API call. Nothing
// here reads or writes the local Registry — the server is authoritative.

import * as path from "path";
import { color } from "@/utils/termcolors.js";
import { resolveProjectTarget, fail } from "../remote/commands/util.js";
import type {
  ProjectCommandOptions,
  ProjectTarget,
  RemoteCommandContext,
} from "../remote/commands/util.js";
import { buildArgs } from "../remote/args.js";
import type { RemoteArgsOptions } from "../remote/args.js";
import { runDeploy } from "../remote/commands/deploy.js";
import { resolveCron } from "./cron.js";
import { createSchedulesClient, ScheduleRequestError } from "../statelog/schedulesClient.js";
import type {
  CreateScheduleInput,
  PatchScheduleInput,
  RemoteSchedule,
  ScheduleTarget,
} from "../statelog/schedulesClient.js";
import { createProjectClient, ProjectRequestError } from "../statelog/projectClient.js";

export type DeployMode = "if-missing" | "always" | "never";

export type AddRemoteOptions = ProjectCommandOptions &
  RemoteArgsOptions & {
    node?: string;
    function?: string;
    every?: string;
    cron?: string;
    timezone?: string;
    name?: string;
    redeploy?: boolean;
    /** Commander's `--no-deploy` value: `false` when the flag was passed. */
    deploy?: boolean;
  };

export type ResolvedScheduleAdd = {
  input: CreateScheduleInput;
  deployMode: DeployMode;
};

/** Translate `schedule add --backend remote` options into a create request and
 *  a deployment policy. Pure: every invalid combination throws before any
 *  target resolution or network work can happen. */
export function resolveScheduleAdd(
  file: string,
  options: AddRemoteOptions,
  defaultTimezone: string,
): ResolvedScheduleAdd {
  const target = resolveTargetSelection(options);
  if ((options.every === undefined) === (options.cron === undefined)) {
    throw new Error("Pass exactly one of --every <preset> or --cron <expression>.");
  }
  const { cron } = resolveCron({ every: options.every, cron: options.cron });
  const input: CreateScheduleInput = {
    fileName: path.basename(file, ".agency"),
    target,
    args: buildArgs(options),
    cronExpr: cron,
    timezone: options.timezone ?? defaultTimezone,
  };
  if (options.name !== undefined) {
    input.name = options.name;
  }
  return { input, deployMode: resolveDeployMode(options) };
}

function resolveTargetSelection(options: AddRemoteOptions): ScheduleTarget {
  if (options.node !== undefined && options.function !== undefined) {
    throw new Error("Pass exactly one of --node <name> or --function <name>, not both.");
  }
  if (options.node !== undefined) {
    return { kind: "node", name: options.node };
  }
  if (options.function !== undefined) {
    return { kind: "function", name: options.function };
  }
  throw new Error("Pass exactly one of --node <name> or --function <name>.");
}

function resolveDeployMode(options: AddRemoteOptions): DeployMode {
  if (options.redeploy && options.deploy === false) {
    throw new Error("--redeploy conflicts with --no-deploy.");
  }
  if (options.redeploy) {
    return "always";
  }
  if (options.deploy === false) {
    return "never";
  }
  return "if-missing";
}

export async function addRemote(
  file: string,
  options: AddRemoteOptions,
  context: RemoteCommandContext,
): Promise<void> {
  let resolved: ResolvedScheduleAdd;
  try {
    resolved = resolveScheduleAdd(
      file,
      options,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  } catch (error) {
    fail(errorMessage(error));
  }
  const target = resolveProjectTarget(context, options);
  await ensureDeployed(file, resolved.input.fileName, resolved.deployMode, target, context);
  const client = createSchedulesClient(target.origin, target.projectSlug, target.apiKey);

  let schedule;
  try {
    schedule = await client.create(resolved.input);
  } catch (error) {
    failScheduleRequest(error, {
      missingAgent: `Deploy it first: agency remote deploy ${file}`,
    });
  }
  const { input } = resolved;
  console.log(
    `${color.green("Created")} schedule ${schedule.id}: ${input.target.kind} ${input.target.name} in ${input.fileName} (${input.cronExpr}, timezone ${input.timezone})`,
  );
}

/** Enforce the deploy policy before creating a schedule. Returns only when the
 *  agent is on the server or the policy says to trust the server's own
 *  validation ("never"). The deploy runs against the SAME resolved target as
 *  the schedule request — never re-derived from config — so the schedule can't
 *  point at a different project than the upload. */
async function ensureDeployed(
  file: string,
  fileName: string,
  mode: DeployMode,
  target: ProjectTarget,
  context: RemoteCommandContext,
): Promise<void> {
  if (mode === "never") {
    return;
  }
  if (mode === "if-missing" && (await sourceExists(target, fileName))) {
    return;
  }
  const outcome = await runDeploy(
    file,
    { host: target.origin, project: target.projectSlug, apiKeyEnv: target.apiKeyEnvName },
    context,
  );
  if (outcome !== "deployed") {
    fail("Deploy did not complete, so the schedule was not created.");
  }
}

async function sourceExists(target: ProjectTarget, fileName: string): Promise<boolean> {
  const client = createProjectClient(target.origin, target.projectSlug, target.apiKey);
  let files;
  try {
    files = await client.pullSource();
  } catch (error) {
    if (error instanceof ProjectRequestError) {
      fail(error.message);
    }
    throw error;
  }
  return files.some((source) => source.name === `${fileName}.agency`);
}

/** Exit with the server's message, adding guidance for the two failures a user
 *  can act on: a not-deployed agent and an under-privileged key. Anything that
 *  is not a ScheduleRequestError is a bug — rethrow it. */
function failScheduleRequest(
  error: unknown,
  guidance: { missingAgent?: string; notFoundId?: string } = {},
): never {
  if (!(error instanceof ScheduleRequestError)) {
    throw error;
  }
  if (error.status === 401 || error.status === 403) {
    fail(
      `${error.message}\nSchedule management needs a full-access API key; invoke-only keys are rejected.`,
    );
  }
  if (guidance.missingAgent && /^Agent '.*' not found/.test(error.message)) {
    fail(`${error.message}\n${guidance.missingAgent}`);
  }
  if (guidance.notFoundId && /not found/i.test(error.message)) {
    fail(guidance.notFoundId);
  }
  fail(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type EditRemoteOptions = ProjectCommandOptions & {
  every?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  disabled?: boolean;
};

/** Translate edit flags into the server's PATCH body. Only cadence, timezone,
 *  and enabled are patchable — target, name, and args are immutable on the
 *  server (delete and re-add to change them). Pure; throws on any invalid or
 *  empty combination. */
export function resolveSchedulePatch(options: EditRemoteOptions): PatchScheduleInput {
  if (options.every !== undefined && options.cron !== undefined) {
    throw new Error("Pass at most one of --every <preset> or --cron <expression>.");
  }
  if (options.enabled && options.disabled) {
    throw new Error("--enabled conflicts with --disabled.");
  }
  const patch: PatchScheduleInput = {};
  if (options.every !== undefined || options.cron !== undefined) {
    patch.cronExpr = resolveCron({ every: options.every, cron: options.cron }).cron;
  }
  if (options.timezone !== undefined) {
    patch.timezone = options.timezone;
  }
  if (options.enabled) {
    patch.enabled = true;
  }
  if (options.disabled) {
    patch.enabled = false;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "Nothing to change — pass --every/--cron, --timezone, or --enabled/--disabled.",
    );
  }
  return patch;
}

export async function listRemote(
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveProjectTarget(context, options);
  const client = createSchedulesClient(target.origin, target.projectSlug, target.apiKey);
  let schedules: RemoteSchedule[];
  try {
    schedules = await client.list();
  } catch (error) {
    failScheduleRequest(error);
  }
  console.log(formatRemoteListTable(schedules));
}

export async function removeRemote(
  id: string,
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveProjectTarget(context, options);
  const client = createSchedulesClient(target.origin, target.projectSlug, target.apiKey);
  try {
    await client.delete(id);
  } catch (error) {
    failScheduleRequest(error, { notFoundId: notFoundGuidance(id) });
  }
  console.log(`${color.green("Removed")} schedule ${id}.`);
}

export async function editRemote(
  id: string,
  options: EditRemoteOptions,
  context: RemoteCommandContext,
): Promise<void> {
  let patch: PatchScheduleInput;
  try {
    patch = resolveSchedulePatch(options);
  } catch (error) {
    fail(errorMessage(error));
  }
  const target = resolveProjectTarget(context, options);
  const client = createSchedulesClient(target.origin, target.projectSlug, target.apiKey);
  try {
    await client.patch(id, patch);
  } catch (error) {
    failScheduleRequest(error, { notFoundId: notFoundGuidance(id) });
  }
  console.log(`${color.green("Updated")} schedule ${id}.`);
}

function notFoundGuidance(id: string): string {
  return `No schedule with id "${id}". Run 'agency schedule list --backend remote' to see schedules.`;
}

function formatRemoteListTable(schedules: RemoteSchedule[]): string {
  if (schedules.length === 0) {
    return "No remote schedules. Use 'agency schedule add <file> --backend remote' to create one.";
  }
  const rows = schedules.map((schedule) => ({
    id: schedule.id,
    name: schedule.name ?? "-",
    target: `${schedule.targetKind}:${schedule.targetName}`,
    file: schedule.fileName,
    cron: schedule.cronExpr,
    timezone: schedule.timezone,
    enabled: schedule.enabled ? "yes" : "no",
  }));
  const headers = {
    id: "ID",
    name: "Name",
    target: "Target",
    file: "Agent",
    cron: "Cron",
    timezone: "Timezone",
    enabled: "Enabled",
  };
  const columns = ["id", "name", "target", "file", "cron", "timezone", "enabled"] as const;
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
