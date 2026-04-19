import { compile, resetCompilationCache } from "@/cli/commands.js";
import { AgencyConfig } from "@/config.js";
import { color } from "@/utils/termcolors.js";
import chokidar from "chokidar";
import { execSync } from "child_process";
import * as fs from "fs";

function getGitIgnorePatterns(): string[] {
  try {
    // Use git to resolve all ignore rules (including nested .gitignore files)
    // This works from any subdirectory within the repo
    const output = execSync(
      "git ls-files --others --ignored --exclude-standard --directory",
      { encoding: "utf-8" },
    );
    return output
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/\/$/, "")); // strip trailing slashes from directories
  } catch {
    return [];
  }
}

export async function watchAndCompile(
  config: AgencyConfig,
  inputs: string[],
  options: { ts?: boolean },
): Promise<() => Promise<void>> {
  // Set up watcher
  const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const DEBOUNCE_MS = 100;

  const gitIgnored = new Set(getGitIgnorePatterns());

  const watcher = chokidar.watch(inputs, {
    ignored: (filePath: string, stats?: fs.Stats) => {
      const basename = filePath.split("/").pop() ?? filePath;
      // Always skip .git directory
      if (basename === ".git") return true;
      // Skip git-ignored paths
      if (gitIgnored.has(filePath) || gitIgnored.has(basename)) return true;
      // For files, only watch .agency files
      if (stats?.isFile()) {
        return !filePath.endsWith(".agency");
      }
      return false;
    },
    ignoreInitial: true,
  });

  watcher.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(color.red(`Watcher error: ${msg}`));
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
