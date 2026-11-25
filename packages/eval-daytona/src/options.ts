import * as fs from "fs";
import * as path from "path";

import { z } from "zod";

/** The wrapper's options file, in the project directory. It is not part of
 *  agency.json, which agency-lang validates and which should not have to
 *  know that this package exists. */
export const OPTIONS_FILE = "eval-daytona.json";

/** A name a shell can export. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const OptionsSchema = z
  .object({
    /** The container image. */
    image: z.string().min(1).default("node:22-bookworm"),
    cpu: z.number().int().positive().default(4),
    /** In GB. */
    memory: z.number().int().positive().default(8),
    /** In GB. */
    disk: z.number().int().positive().default(10),
    /** Names of host environment variables to pass into the containers. */
    env: z
      .array(z.string().regex(ENV_NAME, "must be a variable name: letters, digits and _"))
      .default([]),
    /** Fixed values to set in the containers, such as `CI`. Never read from
     *  the host, so every run of the project gets the same ones. */
    set: z
      .record(z.string().regex(ENV_NAME, "must be a variable name: letters, digits and _"), z.string())
      .default({}),
    /** Which agency to install inside: the one installed in the project, or
     *  a tarball. */
    agency: z
      .union([z.literal("same"), z.object({ tarball: z.string().min(1) }).strict()])
      .default("same"),
    /** Seconds allowed for grading, on top of the test's own time limit and
     *  the setup limit. Fixed, because the wrapper cannot know the time
     *  limits of graders written in a graders.ts. */
    graceSec: z.number().positive().default(7200),
  })
  .strict();

export type WrapperOptions = z.infer<typeof OptionsSchema>;

/** The project's options, with defaults for what the file leaves out and
 *  for a project with no file. A bad file is an error that names it. */
export function readOptions(projectDir: string): WrapperOptions {
  const file = path.join(projectDir, OPTIONS_FILE);
  if (!fs.existsSync(file)) {
    return OptionsSchema.parse({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${OPTIONS_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = OptionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${OPTIONS_FILE}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The environment for the containers: the named host variables that are
 *  set, then the options file's fixed values, then the `--env NAME=VALUE`
 *  pairs on top. Neither a fixed value's name nor a pair's is looked up on
 *  the host. Pairs are for switches that must not leak in from a shell and
 *  belong to one invocation, such as a suite's "start from the solution"
 *  mode. */
export function containerEnv(args: {
  names: string[];
  fixed: Record<string, string>;
  pairs: string[];
  hostEnv: Record<string, string | undefined>;
}): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of args.names) {
    const value = args.hostEnv[name];
    if (value === undefined) {
      missing.push(name);
    } else {
      values[name] = value;
    }
  }
  Object.assign(values, args.fixed);
  for (const pair of args.pairs) {
    const at = pair.indexOf("=");
    const name = at < 0 ? "" : pair.slice(0, at);
    if (!ENV_NAME.test(name)) {
      throw new Error(`--env ${pair}: expected NAME=VALUE, with a name made of letters, digits and _`);
    }
    values[name] = pair.slice(at + 1);
  }
  return { values, missing: missing.filter((name) => values[name] === undefined) };
}

const DEFAULT_RUNS_DIR = "runs";

export type EvalSettings = { runsDir: string; maxBatchCostUsd?: number; wallClockSec?: number };

/** What the wrapper needs from the project's agency config. `config` is what
 *  `agency config show` prints: agency.json merged with agency.local.json,
 *  which is what `agency eval run` uses inside the container. Reading
 *  agency.json alone would give the host a different time limit and cost
 *  cap from the ones the container enforces. */
export function evalSettings(config: unknown): EvalSettings {
  const evalConfig = (config as { eval?: { runsDir?: string; limits?: Record<string, number> } })
    .eval;
  const settings: EvalSettings = { runsDir: evalConfig?.runsDir ?? DEFAULT_RUNS_DIR };
  if (evalConfig?.limits?.maxBatchCostUsd !== undefined) {
    settings.maxBatchCostUsd = evalConfig.limits.maxBatchCostUsd;
  }
  if (evalConfig?.limits?.wallClockSec !== undefined) {
    settings.wallClockSec = evalConfig.limits.wallClockSec;
  }
  return settings;
}
