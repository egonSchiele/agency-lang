import type { Sandbox } from "./types.js";

type Entry = { sandbox: Sandbox; keep: boolean; log: (line: string) => void };

// One process holds several sandboxes at once, one per running job. Both
// lists exist so that whoever handles a signal can delete every one of
// them, including one whose creation has not returned yet.
let live: Entry[] = [];
let creating: Promise<unknown>[] = [];

/** `evenIfKept` deletes a sandbox that was started with `keep`. */
async function remove(entry: Entry, evenIfKept = false): Promise<void> {
  if (!live.includes(entry)) {
    return;
  }
  live = live.filter((other) => other !== entry);
  if (entry.keep && !evenIfKept) {
    entry.log(`keeping sandbox ${entry.sandbox.id}`);
    return;
  }
  try {
    await entry.sandbox.delete();
  } catch (error) {
    // A failed delete must not hide the error that got us here.
    entry.log(
      `could not delete sandbox ${entry.sandbox.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Deletes every sandbox that is live or still being created. For the
 *  command's signal handler: this file installs none of its own, because
 *  what a signal should do (save runs first, or quit at once) is the
 *  command's decision. A sandbox started with `keep` is deleted too: `keep`
 *  is for looking inside after a normal end, not for surviving a force quit. */
export async function deleteAllSandboxes(log: (line: string) => void): Promise<void> {
  const waiting = live.length + creating.length;
  log(`deleting ${waiting} sandbox${waiting === 1 ? "" : "es"}`);
  // A sandbox still being created would be orphaned; wait for it.
  await Promise.allSettled(creating);
  await Promise.allSettled(live.map((entry) => remove(entry, true)));
}

/** For tests that leave a `use` hanging on purpose. */
export function resetForTests(): void {
  live = [];
  creating = [];
}

/** Runs `use` with a new sandbox and deletes the sandbox on the way out,
 *  after a return and after a throw. `keep` leaves it running, for looking
 *  inside afterwards, and logs its id. */
export async function withSandbox<T>(
  create: () => Promise<Sandbox>,
  use: (sandbox: Sandbox) => Promise<T>,
  options: { keep?: boolean; log?: (line: string) => void } = {},
): Promise<T> {
  const creation = create();
  creating = [...creating, creation];
  let entry: Entry;
  try {
    entry = { sandbox: await creation, keep: options.keep === true, log: options.log ?? (() => {}) };
    live = [...live, entry];
  } finally {
    creating = creating.filter((other) => other !== creation);
  }
  try {
    return await use(entry.sandbox);
  } finally {
    await remove(entry);
  }
}
