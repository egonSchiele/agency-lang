import { whereAmI, whereIsMyChild, whereDoCommandsRun, readNotes, readNotesIn, hasInterrupts } from "./agent.js";
import { nodeHost } from "agency-lang/runtime";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Two folders, neither of them the folder this process runs in.
const folder = (content) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "node-host-cwd-")));
  writeFileSync(join(dir, "notes.txt"), content);
  return dir;
};
const dirA = folder("notes of A");
const dirB = folder("notes of B");
const hostA = nodeHost({ cwd: dirA });
const hostB = nodeHost({ cwd: dirB });

// What `recommended` says about reads: the launch folder needs no approval.
const policy = { "std::read": [{ match: { dir: "{.,./**}" }, action: "approve" }] };

// A read the policy does not approve reaches this program as an interrupt.
const outcome = (result) => (hasInterrupts(result.data) ? "asked for approval" : result.data);

let result;
try {
  // Both runs are started before either is awaited, so they overlap.
  const [cwdA, cwdB, notesA, notesB, aReadsB, bReadsA, noHost] = await Promise.all([
    whereAmI({ host: hostA }),
    whereAmI({ host: hostB }),
    readNotes({ host: hostA, policy }),
    readNotes({ host: hostB, policy }),
    readNotesIn(dirB, { host: hostA, policy }),
    readNotesIn(dirA, { host: hostB, policy }),
    whereAmI(),
  ]);
  const childOfA = await whereIsMyChild({ host: hostA });
  const commandOfB = await whereDoCommandsRun({ host: hostB });
  result = {
    aCommandOfBRunsInBsFolder:
      commandOfB.data === dirB ? true : `expected ${dirB}, got ${JSON.stringify(commandOfB.data)}`,
    aChildProcessOfASeesAsFolder:
      childOfA.data === dirA ? true : `expected ${dirA}, got ${JSON.stringify(childOfA.data)}`,
    aSeesItsOwnFolder: cwdA.data === dirA,
    bSeesItsOwnFolder: cwdB.data === dirB,
    aReadsARelativePath: outcome(notesA),
    bReadsARelativePath: outcome(notesB),
    aReadsInBsFolder: outcome(aReadsB),
    bReadsInAsFolder: outcome(bReadsA),
    withNoHostItIsTheProcessFolder: noHost.data === process.cwd(),
  };
} finally {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
}

writeFileSync("__result.json", JSON.stringify(result, null, 2));
