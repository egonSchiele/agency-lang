// When a process started, as `ps` reports it. `agency attach` and the
// subprocess part's `processStartedAt` use it to tell a process from a
// stranger that was given the same pid later. Node-only.
import { execFileSync } from "child_process";

export type StartTime = { started: number } | { failed: string };

/** The start time `ps` reports for `pid`, as a timestamp, or why it could
 *  not be read: `ps` missing (a slim container), a `ps` that does not take
 *  `-o lstart` (BusyBox), or a date the parser cannot read. `ps` is run
 *  in the C locale, since `lstart` is otherwise printed in the user's
 *  language (`Di. 20 Okt. 15:47:40 2026` under German) and `Date.parse`
 *  reads only English, and in UTC, since a local wall time has no zone:
 *  on the night the clocks go back the hour from 1:00 to 2:00 happens
 *  twice, and a program started in the second pass would read as an hour
 *  older than its record. `ps` writes its own complaints to stderr, which
 *  is not shown. */
export function liveStartTime(pid: number): StartTime {
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    return { failed: `could not run ps: ${(error as Error).message}` };
  }
  const started = parseStartTime(output);
  if (started === null) {
    return { failed: `could not read a date in what ps printed: "${output.trim()}"` };
  }
  return { started };
}

/** `lstart` as `ps` prints it in the C locale and UTC, `Tue Oct 20
 *  13:32:26 2026`, read as UTC. */
export function parseStartTime(output: string): number | null {
  const text = output.trim();
  if (text === "") {
    return null;
  }
  const time = Date.parse(`${text} GMT`);
  return Number.isNaN(time) ? null : time;
}
