/** One SIGINT listener for every live eval child, instead of one per child.
 *
 *  A terminal Ctrl-C reaches the whole process group, but a programmatic
 *  SIGINT (a supervisor, process.kill) hits only this process, so it is
 *  forwarded to each child that is still running. The optimizer runs a whole
 *  candidate's inputs at once; with a listener per child, Node warned about a
 *  leak past ten. The listener exists only while at least one child is live,
 *  so a process with no children keeps default SIGINT handling. */

type Killable = { kill(signal: NodeJS.Signals): unknown };

const live: Killable[] = [];

function forwardToAll(): void {
  for (const child of live) child.kill("SIGINT");
}

/** Forward SIGINT to `child` until the returned function is called. */
export function forwardSigintTo(child: Killable): () => void {
  if (live.length === 0) process.on("SIGINT", forwardToAll);
  live.push(child);
  return () => {
    const at = live.indexOf(child);
    if (at === -1) return;
    live.splice(at, 1);
    if (live.length === 0) process.removeListener("SIGINT", forwardToAll);
  };
}
