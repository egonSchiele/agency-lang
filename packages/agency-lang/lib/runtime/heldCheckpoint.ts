// The checkpoint of a held batch of questions, saved to disk so that a
// process which dies while holding can be resumed with `agency resume`.
// Written only when `spawn.interrupts.preemptivelyCreateCheckpoint` is on: a
// checkpoint holds the program's whole state (docs/dev/runtime/spawn.md).

import path from "#path";
import { AGENCY_MAX_COST, AGENCY_MAX_TIME, AGENCY_RUN_POLICY } from "../constants.js";
import type { Host, HostSettings } from "../host/host.js";
import { agencyHomeDir } from "./agencyHome.js";
import type { Interrupt } from "./interrupts.js";
import { nativeTypeReplacer } from "./revivers/index.js";

/** The folder under Agency's home that holds the files. */
const HELD_DIR = "held";
/** Only the user reads a checkpoint or a policy. */
const HELD_FILE_MODE = 0o600;

/** What a held batch has on disk. */
export type HeldFiles = {
  checkpoint: string;
  /** The run's policy, or null when it has no rules. */
  policy: string | null;
};

/** The run's policy as JSON text, or null when it has no rules. */
function policyWithRules(settings: HostSettings): string | null {
  const raw = settings.read(AGENCY_RUN_POLICY);
  if (raw === null || Object.keys(JSON.parse(raw)).length === 0) {
    return null;
  }
  return raw;
}

/** Write the checkpoint the held interrupts carry to a file under
 *  `~/.agency/held/`, and the run's policy beside it. Every interrupt in a
 *  batch carries the same checkpoint, so the first one's is the batch's.
 *
 *  The policy is saved because a checkpoint does not hold it, and the
 *  person who resumes may not have it: `spawn` deletes the policy file it
 *  launched with. */
export async function saveHeldCheckpoint(interrupts: Interrupt[], host: Host): Promise<HeldFiles> {
  const checkpoint = interrupts[0]?.checkpoint;
  if (checkpoint === undefined) {
    throw new Error("the held interrupts carry no checkpoint");
  }
  const home = await host.files.root(agencyHomeDir(host));
  await host.files.mkdir(home, "");
  await host.files.privateDir(home, HELD_DIR);
  const dir = await host.files.root(path.join(agencyHomeDir(host), HELD_DIR));
  const run = `${checkpoint.traceId ?? host.random.id()}-${host.system.processId()}`;
  const write = async (name: string, text: string): Promise<string> => {
    await host.files.writeText(dir, name, text, { mode: "create-only", fileMode: HELD_FILE_MODE });
    return host.files.resolvePath(dir, name);
  };
  // A surfaced checkpoint holds live values (a Date, a Set), which plain
  // JSON would flatten. The replacer writes them in the form a resume
  // revives.
  const file = await write(`${run}.json`, JSON.stringify(checkpoint, nativeTypeReplacer));
  const policy = policyWithRules(host.settings);
  return {
    checkpoint: file,
    policy: policy === null ? null : await write(`${run}.policy.json`, policy),
  };
}

/** The command that resumes from `files` under the policy and the limits
 *  this run has. A checkpoint holds neither, so a resume without the flags
 *  would run with no rules and no limits. */
export function resumeCommand(files: HeldFiles, settings: HostSettings): string {
  const maxCost = settings.read(AGENCY_MAX_COST);
  const maxTime = settings.read(AGENCY_MAX_TIME);
  // A negative cost, and a time of zero or less, mean no limit.
  const flags = [
    "--wait-for-response",
    ...(files.policy !== null ? ["--policy", files.policy] : []),
    ...(maxCost !== null && Number(maxCost) >= 0 ? ["--max-cost", maxCost] : []),
    ...(maxTime !== null && Number(maxTime) > 0 ? ["--max-time", `${maxTime}ms`] : []),
  ];
  return `agency resume ${files.checkpoint} <program> ${flags.join(" ")}`;
}

/** Remove the files `saveHeldCheckpoint` wrote. Refuses a path outside
 *  `~/.agency/held/`. */
export async function removeHeldCheckpoint(files: HeldFiles, host: Host): Promise<void> {
  const dir = await host.files.root(path.join(agencyHomeDir(host), HELD_DIR));
  const held = await host.files.resolvePath(dir, "");
  const saved = [files.checkpoint, ...(files.policy !== null ? [files.policy] : [])];
  const outside = saved.find((file) => path.dirname(file) !== held);
  if (outside !== undefined) {
    throw new Error(`'${outside}' is not a file in '${held}'`);
  }
  for (const file of saved) {
    await host.files.remove(dir, path.basename(file));
  }
}
