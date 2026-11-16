// The checkpoint of a held batch of questions, saved to disk so that a
// process which dies while holding can be resumed with `agency resume`.
// Written only when `spawn.interrupts.preemptivelyCreateCheckpoint` is on: a
// checkpoint holds the program's whole state (docs/dev/runtime/spawn.md).

import path from "#path";
import type { Host } from "../host/host.js";
import { agencyHomeDir } from "./agencyHome.js";
import type { Interrupt } from "./interrupts.js";

/** The folder under Agency's home that holds the files. */
const HELD_DIR = "held";
/** Only the user reads a checkpoint. */
const HELD_FILE_MODE = 0o600;

/** Write the checkpoint the held interrupts carry to a file under
 *  `~/.agency/held/`, and return its path. Every interrupt in a batch
 *  carries the same checkpoint, so the first one's is the batch's. */
export async function saveHeldCheckpoint(interrupts: Interrupt[], host: Host): Promise<string> {
  const checkpoint = interrupts[0]?.checkpoint;
  if (checkpoint === undefined) {
    throw new Error("the held interrupts carry no checkpoint");
  }
  const home = await host.files.root(agencyHomeDir(host));
  await host.files.mkdir(home, "");
  await host.files.privateDir(home, HELD_DIR);
  const dir = await host.files.root(path.join(agencyHomeDir(host), HELD_DIR));
  const run = checkpoint.traceId ?? host.random.id();
  const name = `${run}-${host.system.processId()}.json`;
  // A surfaced interrupt's checkpoint is already data: the result of a
  // node run is copied through JSON. `stringify` covers an instance too.
  await host.files.writeText(dir, name, JSON.stringify(checkpoint), {
    mode: "create-only",
    fileMode: HELD_FILE_MODE,
  });
  return host.files.resolvePath(dir, name);
}

/** Remove a file `saveHeldCheckpoint` wrote. Refuses a path outside
 *  `~/.agency/held/`. */
export async function removeHeldCheckpoint(file: string, host: Host): Promise<void> {
  const dir = await host.files.root(path.join(agencyHomeDir(host), HELD_DIR));
  const held = await host.files.resolvePath(dir, "");
  if (path.dirname(file) !== held) {
    throw new Error(`'${file}' is not a file in '${held}'`);
  }
  await host.files.remove(dir, path.basename(file));
}
