import * as readline from "readline";
import fs from "fs";
import process from "process";
import util from "util";
import { exec } from "child_process";
import { highlight } from "cli-highlight";
const asyncExec = util.promisify(exec);

// return both stdout and stderr outputs
async function runCommand(
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await asyncExec(command);
    if (stderr) {
      // print to stderr
      console.error(stderr);
    }
    console.log(stdout);
    return { stdout, stderr };
  } catch (e) {
    console.error("An error occurred:", e);
    return { stdout: "", stderr: String(e) };
    // Handle error (e.g., exit code, signal)
    // throw e;
  }
}

function input(prompt: string): Promise<string> {
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

export const printLine = console.log;

export const printHighlighted = (
  code: string,
  _language: string = "ts",
): void => {
  const language = _language === "agency" ? "ts" : _language;
  const highlightedCode = highlight(code, { language });
  console.log(highlightedCode);
};

export const confirm = async (message: string): Promise<boolean> => {
  const response = await input(`${message} (y/N): `);
  return response.toLowerCase() === "y" || response.toLowerCase() === "yes";
};

export const writeFile = async (
  path: string,
  content: string,
  language?: string,
): Promise<void> => {
  printLine(`About to write to file: ${path}`);
  if (language) {
    printLine("Content:");
    printHighlighted(content, language);
  } else {
    printLine(`Content:\n${content}`);
  }
  const approve = await confirm(`Approve write to file: ${path}?`);
  if (!approve) {
    printLine("File write cancelled.");
    return;
  }
  fs.writeFileSync(path, content, "utf-8");
};

export const readFile = async (path: string): Promise<string> => {
  printLine(`About to read file: ${path}`);
  const approve = await confirm(`Approve read from file: ${path}?`);
  if (!approve) {
    printLine("File read cancelled.");
    return "";
  }
  const content = fs.readFileSync(path, "utf-8");
  return content;
};

export const exit = (code: number = 0): void => {
  printLine(`Exiting with code: ${code}`);
  printLine("Goodbye!");
  process.exit(code);
};

export const execCommand = async (
  command: string,
): Promise<{ stdout: string; stderr: string; canceled: boolean }> => {
  printLine(`About to execute command: ${command}`);
  const approve = await confirm(`Approve execution of command: ${command}?`);
  if (!approve) {
    printLine("Command execution cancelled.");
    return { stdout: "", stderr: "", canceled: true };
  }
  const result = await runCommand(command);
  return { ...result, canceled: false };
};
