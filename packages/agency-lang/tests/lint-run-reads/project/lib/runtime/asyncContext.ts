// Stand-ins for the real reader functions. The check finds them by this
// file's path and their names.
export type Run = { name: string };

export function currentRun(): Run {
  return { name: "run" };
}

export function currentRunOrNone(): Run | undefined {
  return undefined;
}
