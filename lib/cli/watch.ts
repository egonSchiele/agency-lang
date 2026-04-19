import { compile, resetCompilationCache } from "@/cli/commands.js";
import { AgencyConfig } from "@/config.js";
import { color } from "@/utils/termcolors.js";
import chokidar from "chokidar";
import * as fs from "fs";

export async function watchAndCompile(
  config: AgencyConfig,
  inputs: string[],
  options: { ts?: boolean },
): Promise<() => Promise<void>> {
  // Set up watcher
  const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const DEBOUNCE_MS = 100;

  const watcher = chokidar.watch(inputs, {
    ignored: (filePath: string, stats?: fs.Stats) => {
      // Don't ignore directories — we need to recurse into them
      if (!stats?.isFile()) return false;
      return !filePath.endsWith(".agency");
    },
    ignoreInitial: true,
  });

  const safeCompile = (target: string) => {
    // Intercept process.exit so compilation errors don't kill the watcher
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = ((code?: number) => {
      exitCalled = true;
      throw new Error(`Compilation failed (exit code ${code ?? 1})`);
    }) as never;
    try {
      compile(config, target, undefined, { ts: options.ts });
    } finally {
      process.exit = originalExit;
    }
    if (exitCalled) return false;
    return true;
  };

  // Initial compile — errors are caught so the watcher still starts
  for (const input of inputs) {
    try {
      safeCompile(input);
    } catch (err) {
      console.error(color.red(`Error compiling ${input}:`));
      console.error(err instanceof Error ? err.message : err);
    }
  }

  const recompile = (filePath: string) => {
    // Debounce per file
    if (debounceTimers[filePath]) {
      clearTimeout(debounceTimers[filePath]);
    }
    debounceTimers[filePath] = setTimeout(() => {
      try {
        resetCompilationCache();
        if (safeCompile(filePath)) {
          console.log(color.green(`Recompiled ${filePath}`));
        }
      } catch (err) {
        console.error(color.red(`Error compiling ${filePath}:`));
        console.error(err instanceof Error ? err.message : err);
      }
      delete debounceTimers[filePath];
    }, DEBOUNCE_MS);
  };

  watcher.on("change", recompile);
  watcher.on("add", recompile);

  console.log(color.cyan("Watching for changes..."));

  return async () => {
    for (const timer of Object.values(debounceTimers)) {
      clearTimeout(timer);
    }
    await watcher.close();
  };
}
