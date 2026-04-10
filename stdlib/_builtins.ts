import * as readline from "readline";
import process from "process";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { detectPlatform } from "./lib/utils.js";

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

export async function _fetch(url: string): Promise<string> {
  const result = await fetch(url);
  try {
    const text = await result.text();
    return text;
  } catch (e) {
    throw new Error(`Failed to get text from ${url}: ${e}`);
  }
}

export async function _fetchJSON(url: string): Promise<any> {
  const result = await fetch(url);
  try {
    const json = await result.json();
    return json;
  } catch (e) {
    throw new Error(`Failed to parse JSON from ${url}: ${e}`);
  }
}

export function _read(filename: string): string {
  const filePath = path.resolve(process.cwd(), filename);
  const data = fs.readFileSync(filePath);
  return data.toString("utf8");
}

export function _write(filename: string, content: string): boolean {
  const filePath = path.resolve(process.cwd(), filename);
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

export function _readImage(filename: string): string {
  const filePath = path.resolve(process.cwd(), filename);
  const data = fs.readFileSync(filePath);
  return data.toString("base64");
}

export function _notify(title: string, message: string): boolean {
  const platform = detectPlatform();
  if (platform === "macos") {
    // Escape for AppleScript string literals (backslashes and double quotes).
    // We use execFileSync with an args array to bypass the shell entirely,
    // which eliminates all shell injection concerns.
    const escapeAS = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `display notification "${escapeAS(message)}" with title "${escapeAS(title)}"`;
    execFileSync("osascript", ["-e", script]);
  } else if (platform === "linux") {
    execFileSync("notify-send", [title, message]);
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

export function _range(startOrN: number, end?: number): number[] {
  if (end === undefined) {
    return Array.from({ length: startOrN }, (_, i) => i);
  }
  return Array.from({ length: end - startOrN }, (_, i) => i + startOrN);
}
