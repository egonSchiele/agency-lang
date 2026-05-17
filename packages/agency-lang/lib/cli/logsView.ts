import * as fs from "fs";
import * as tty from "tty";
import { runViewer } from "@/logsViewer/run.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import { TerminalOutput } from "@/tui/output/terminal.js";

export async function logsView(file: string): Promise<void> {
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const jsonl = Buffer.concat(chunks).toString("utf8");
    await runWith(jsonl, { stdinIsPipe: true });
    return;
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  const jsonl = fs.readFileSync(file, "utf8");
  await runWith(jsonl, { stdinIsPipe: false });
}

async function runWith(
  jsonl: string,
  opts: { stdinIsPipe: boolean },
): Promise<void> {
  // When stdin was used to feed the JSONL data we cannot also use it
  // for interactive keystrokes — it's been drained and isn't a TTY.
  // Re-open the controlling terminal directly so the viewer stays
  // usable for `cat run.jsonl | agency logs view -`.
  const restore = opts.stdinIsPipe ? swapStdinToTty() : null;
  const input = new TerminalInput();
  const output = new TerminalOutput();
  const viewport = {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
  try {
    await runViewer({ jsonl, input, output, viewport });
  } finally {
    input.destroy();
    if (output.destroy) output.destroy();
    if (restore) restore();
  }
}

// Open the controlling terminal at /dev/tty and graft it onto
// `process.stdin` so TerminalInput (which reads process.stdin) sees a
// real TTY. Returns a function that restores the previous stdin
// descriptor. Throws a friendly error on platforms without /dev/tty
// (e.g. Windows).
function swapStdinToTty(): () => void {
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r");
  } catch (err) {
    console.error(
      "agency logs view -: cannot read keystrokes from a non-TTY stdin on this platform.\n" +
        "Try `agency logs view <file>` instead.",
    );
    process.exit(1);
  }
  const ttyStream = new tty.ReadStream(fd);
  const original = process.stdin;
  // Reassign process.stdin so TerminalInput.init() picks up the TTY.
  Object.defineProperty(process, "stdin", {
    configurable: true,
    get: () => ttyStream,
  });
  return () => {
    Object.defineProperty(process, "stdin", {
      configurable: true,
      get: () => original,
    });
    try {
      ttyStream.destroy();
    } catch {
      // best-effort cleanup
    }
  };
}
