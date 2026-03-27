import * as readline from "readline";
import process from "process";

export function _print(message: string): void {
  console.log(message);
}

export function _printJSON(obj: any): void {
  console.log(JSON.stringify(obj, null, 2));
}

export function _input(prompt: string): Promise<string> {
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
