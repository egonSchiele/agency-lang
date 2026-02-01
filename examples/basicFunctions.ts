import * as readline from 'readline';
import fs from 'fs';
import process from 'process';
import util from 'util';
import { exec } from 'child_process';
const asyncExec = util.promisify(exec);

async function runCommand(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await asyncExec(command);
    if (stderr) {
      // print to stderr
      console.error(stderr);
    }
    console.log(stdout);
    return stdout;
  } catch (e) {
    console.error('An error occurred:', e);
    // Handle error (e.g., exit code, signal)
    throw e;
  }
}

function input(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

export const printLine = console.log;

export const confirm = async (message: string): Promise<boolean> => {
  const response = await input(`${message} (y/N): `);
  return response.toLowerCase() === "y" || response.toLowerCase() === "yes";
}

export const writeFile = async (path: string, content: string): Promise<void> => {
  printLine(`About to write to file: ${path}`);
  printLine(`Content:\n${content}`);
  const approve = await confirm(`Approve write to file: ${path}?`);
  if (!approve) {
    printLine("File write cancelled.");
    return;
  }
  fs.writeFileSync(path, content, 'utf-8');
}

export const readFile = async (path: string): Promise<string> => {
  printLine(`About to read file: ${path}`);
  const approve = await confirm(`Approve read from file: ${path}?`);
  if (!approve) {
    printLine("File read cancelled.");
    return "";
  }
  const content = fs.readFileSync(path, 'utf-8');
  return content;
}

export const exit = (code: number = 0): void => {
  printLine(`Exiting with code: ${code}`);
  printLine("Goodbye!");
  process.exit(code);
}

export const execCommand = async (command: string): Promise<void> => {
  printLine(`About to execute command: ${command}`);
  const approve = await confirm(`Approve execution of command: ${command}?`);
  if (!approve) {
    printLine("Command execution cancelled.");
    return;
  }
  await runCommand(command);
}