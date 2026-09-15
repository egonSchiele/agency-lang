#!/usr/bin/env node
import * as path from "node:path";
import { fileSha256 } from "agency-lang/stdlib-lib/modelVerify.js";
import { MODEL_NAMES, isModelName, snapshotFor, type ModelName } from "./lockfile.js";
import { downloadModel, modelRepoDir } from "./modelStore.js";

type Command = {
  usage: string;
  run: (model: ModelName) => Promise<boolean>;
};

const COMMANDS: Record<string, Command> = {
  pull: { usage: "pull <model>     Download a model and check its hashes", run: pull },
  verify: { usage: "verify <model>   Hash an installed model against the lockfile", run: verify },
};

async function pull(model: ModelName): Promise<boolean> {
  console.log(`Downloading the ${model} model into ${modelRepoDir(model)}`);
  await downloadModel(model, (event) => {
    if (event.kind === "verify") {
      console.log(`${event.ok ? "OK" : "BAD"}  ${event.path}`);
    }
  });
  return true;
}

async function verify(model: ModelName): Promise<boolean> {
  const results = await Promise.all(
    snapshotFor(model).files.map((file) => verifyFile(model, file.path, file.sha256)),
  );
  return results.every((ok) => ok);
}

async function verifyFile(
  model: ModelName,
  filePath: string,
  expected: string | undefined,
): Promise<boolean> {
  const actual = await fileSha256(path.join(modelRepoDir(model), filePath)).catch(
    (err: Error) => `unreadable: ${err.message}`,
  );
  const ok = actual === expected;
  if (ok) {
    console.log(`OK   ${filePath}`);
  } else {
    console.log(`BAD  ${filePath} (expected ${expected}, got ${actual})`);
  }
  return ok;
}

function printUsage(): void {
  console.error("Usage: agency-kokoro <command> <model>");
  Object.values(COMMANDS).forEach((command) => console.error(`  ${command.usage}`));
  console.error(`Models: ${MODEL_NAMES.join(", ")}`);
}

const [commandName, model] = process.argv.slice(2);
const command = Object.hasOwn(COMMANDS, commandName ?? "") ? COMMANDS[commandName] : undefined;
if (command === undefined || model === undefined || !isModelName(model)) {
  printUsage();
  process.exit(1);
}
try {
  process.exit((await command.run(model)) ? 0 : 1);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
