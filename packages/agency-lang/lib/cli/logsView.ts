import * as fs from "fs";
import { runViewer } from "@/logsViewer/run.js";
import { TerminalInput } from "@/tui/input/terminal.js";
import { TerminalOutput } from "@/tui/output/terminal.js";

export async function logsView(file: string): Promise<void> {
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const jsonl = Buffer.concat(chunks).toString("utf8");
    await runWith(jsonl);
    return;
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  const jsonl = fs.readFileSync(file, "utf8");
  await runWith(jsonl);
}

async function runWith(jsonl: string): Promise<void> {
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
  }
}
