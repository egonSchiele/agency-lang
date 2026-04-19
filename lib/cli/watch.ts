import { compile } from "@/cli/commands.js";
import { AgencyConfig } from "@/config.js";
import { color } from "@/utils/termcolors.js";
import chokidar from "chokidar";
import * as fs from "fs";

export async function watchAndCompile(
  config: AgencyConfig,
  inputs: string[],
  options: { ts?: boolean },
): Promise<() => Promise<void>> {
  // Initial compile — catch errors so the watcher still starts
  for (const input of inputs) {
    try {
      compile(config, input, undefined, { ts: options.ts });
    } catch (err) {
      console.error(color.red(`Error compiling ${input}:`));
      console.error(err instanceof Error ? err.message : err);
    }
  }

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

  const recompile = (filePath: string) => {
    // Debounce per file
    if (debounceTimers[filePath]) {
      clearTimeout(debounceTimers[filePath]);
    }
    debounceTimers[filePath] = setTimeout(() => {
      try {
        compile(config, filePath, undefined, { ts: options.ts });
        console.log(color.green(`Recompiled ${filePath}`));
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
