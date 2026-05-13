#!/usr/bin/env node
import {
  loadLockfile,
  resolveModelDir,
  resolveModelPath,
  isModelInstalled,
  ensureModel,
  sha256OfFile,
  ModelManagerError,
} from "./modelManager.js";
import type { ModelName } from "./types.js";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { findPackageRoot } from "./packageRoot.js";

async function cmdBuild() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = findPackageRoot(here);
  console.log(`Building native addon in ${pkgRoot} ...`);
  console.log(
    "This compiles vendored whisper.cpp + ggml from source. Expect 30-90 seconds.",
  );
  console.log(
    "Requires: cmake >= 3.18, a C++17 compiler. (ffmpeg is needed at runtime, not build time.)",
  );

  // We deliberately spawn the locally-installed cmake-js binary rather than
  // invoking node's require system, so the user sees real cmake output and
  // we don't accidentally execute vendored C++ via a hidden code path.
  const cmakeJs = path.join(pkgRoot, "node_modules", ".bin", "cmake-js");
  if (!existsSync(cmakeJs)) {
    console.error(`cmake-js not found at ${cmakeJs}.`);
    console.error(
      `Run \`npm install\` (or \`pnpm install\`) inside ${pkgRoot} first.`,
    );
    process.exit(5);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmakeJs, ["compile", "--runtime=node"], {
      cwd: pkgRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cmake-js exited with code ${code}`));
    });
  });

  const addonPath = path.join(pkgRoot, "build", "Release", "whisper_addon.node");
  if (!existsSync(addonPath)) {
    console.error(`Build reported success but addon not found at ${addonPath}.`);
    process.exit(6);
  }
  console.log(`Built: ${addonPath}`);
}

async function cmdPull(name: string) {
  await ensureModel(name as ModelName);
  console.log(`Installed: ${resolveModelPath(name as ModelName)}`);
}

async function cmdList() {
  const dir = resolveModelDir();
  const lock = await loadLockfile();
  console.log(`Models directory: ${dir}\n`);
  for (const [name, entry] of Object.entries(lock.models)) {
    const installed = await isModelInstalled(name as ModelName, dir);
    const sizeMb = Math.round(entry.sizeBytes / 1e6);
    const tag = installed ? "✓" : " ";
    console.log(
      `  ${tag}  ${name.padEnd(16)} ${String(sizeMb).padStart(5)} MB`,
    );
  }
}

async function cmdVerify(name: string) {
  const p = resolveModelPath(name as ModelName);
  const lock = await loadLockfile();
  const entry = lock.models[name as ModelName];
  if (!entry) throw new ModelManagerError(`unknown model "${name}"`);
  try {
    await fs.access(p);
  } catch {
    console.error(`Not installed: ${p}`);
    process.exit(2);
  }
  const actual = await sha256OfFile(p);
  if (actual === entry.sha256) {
    console.log(`OK: ${name} (${actual})`);
  } else {
    console.error(`MISMATCH: ${name}`);
    console.error(`  expected ${entry.sha256}`);
    console.error(`  actual   ${actual}`);
    process.exit(3);
  }
}

function usage() {
  console.error("Usage: agency-whisper <command> [args]");
  console.error(
    "  build            Compile the native addon (run once after install)",
  );
  console.error("  pull <model>     Download a model (e.g. base.en)");
  console.error("  list             List supported models and installation status");
  console.error(
    "  verify <model>   Re-hash an installed model and compare to lockfile",
  );
  process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
try {
  switch (cmd) {
    case "build":
      await cmdBuild();
      break;
    case "pull":
      if (!rest[0]) usage();
      await cmdPull(rest[0]);
      break;
    case "list":
      await cmdList();
      break;
    case "verify":
      if (!rest[0]) usage();
      await cmdVerify(rest[0]);
      break;
    default:
      usage();
  }
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(4);
}
