import * as readline from "readline";
import process from "process";
import { readFile, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { detectPlatform } from "./utils.js";
import { resolvePath } from "./fs.js";

const execFileAsync = promisify(execFile);

export function _print(...messages: any[]): void {
  console.log(...messages);
}

export function _printJSON(obj: any): void {
  console.log(JSON.stringify(obj, null, 2));
}

export function _input(prompt: string): Promise<string> {
  const override = (globalThis as any).__agencyInputOverride as
    | ((prompt: string) => Promise<string>)
    | undefined;
  if (override) {
    return override(prompt);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function _sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

export function _round(num: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(num * factor) / factor;
}

export { _fetch, _fetchJSON } from "./http.js";

export async function _read(dir: string, filename: string): Promise<string> {
  const filePath = await resolvePath(dir, filename);
  const data = await readFile(filePath);
  return data.toString("utf8");
}

export async function _write(dir: string, filename: string, content: string): Promise<boolean> {
  const filePath = await resolvePath(dir, filename);
  await writeFile(filePath, content, "utf8");
  return true;
}

export async function _readImage(dir: string, filename: string): Promise<string> {
  const filePath = await resolvePath(dir, filename);
  const data = await readFile(filePath);
  return data.toString("base64");
}

export async function _notify(title: string, message: string): Promise<boolean> {
  const platform = await detectPlatform();
  if (platform === "macos") {
    // Escape for AppleScript string literals (backslashes and double quotes).
    // We use execFileAsync with an args array to bypass the shell entirely,
    // which eliminates all shell injection concerns.
    const escapeAS = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `display notification "${escapeAS(message)}" with title "${escapeAS(title)}"`;
    await execFileAsync("osascript", ["-e", script]);
  } else if (platform === "linux") {
    await execFileAsync("notify-send", [title, message]);
  } else if (platform === "wsl") {
    console.error(
      `notify is not yet supported in WSL. ` +
      `WSL does not have reliable notification support.\n` +
      `Title: ${title}\nMessage: ${message}`
    );
  } else if (platform === "windows") {
    console.error(
      `notify is not yet supported on Windows. ` +
      `Supported platforms: macOS, Linux.\n` +
      `Title: ${title}\nMessage: ${message}`
    );
  } else {
    console.error(
      `notify is not supported on platform: ${platform}\n` +
      `Title: ${title}\nMessage: ${message}`
    );
  }
  return true;
}

export function _mostCommon(items: any[]): any {
  const counts: Record<string, { value: any; count: number }> = {};
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!counts[key]) counts[key] = { value: item, count: 0 };
    counts[key].count++;
  }
  let best: any = undefined;
  let bestCount = 0;
  for (const entry of Object.values(counts)) {
    if (entry.count > bestCount) {
      best = entry.value;
      bestCount = entry.count;
    }
  }
  return best;
}

export function _keys(obj: any): string[] {
  return Object.keys(obj);
}

export function _values(obj: any): any[] {
  return Object.values(obj);
}

export function _entries(obj: any): { key: string; value: any }[] {
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

export function _range(startOrN: number, end?: number): number[] {
  if (end === undefined) {
    return Array.from({ length: startOrN }, (_, i) => i);
  }
  return Array.from({ length: end - startOrN }, (_, i) => i + startOrN);
}
