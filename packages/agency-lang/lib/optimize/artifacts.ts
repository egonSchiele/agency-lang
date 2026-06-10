import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { OptimizeResult, OptimizeVerdict } from "./types.js";

const WORKSPACE_COPY_EXCLUDED_DIRS = [
  ".git",
  ".worktrees",
  "node_modules",
  "runs",
  ".agency-tmp",
  ".js-tmp",
  ".agency-memory",
];

export type IterationArtifact = {
  iter: number;
  iterDir: string;
  agentPath: string;
  workspaceDir: string;
  workspaceAgentPath: string;
  mutationPath?: string;
};

export type OptimizeArtifacts = {
  runDir: string;
  writeBaseline(source: string): IterationArtifact;
  writeCandidate(iter: number, source: string, mutation: { rationale: string; diff?: string }): IterationArtifact;
  writeValidationFailure(iter: number, details: { attemptedPrompt: string; rationale?: string; error: string }): IterationArtifact;
  writeRuntimeRejection(iter: number, error: unknown): string;
  writeVerdict(iter: number, verdict: OptimizeVerdict): string;
  writeFinalChampion(source: string, championIter: number | "baseline"): string;
  writeSummary(result: OptimizeResult): string;
};

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function createOptimizeArtifacts(args: {
  runsDir: string;
  runId: string;
  agentFilename: string;
  workingDir: string;
  goal: string;
  iterations: number;
  judgeSamples: number;
  acceptThreshold: number;
  sourceSha256: string;
  mutatorModel?: string;
}): OptimizeArtifacts {
  const runDir = path.resolve(args.runsDir, args.runId);
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, "config.json"), {
    runId: args.runId,
    goal: args.goal,
    iterations: args.iterations,
    judgeSamples: args.judgeSamples,
    acceptThreshold: args.acceptThreshold,
    mutatorModel: args.mutatorModel,
    agentFilename: args.agentFilename,
    workingDir: args.workingDir,
    sourceSha256: args.sourceSha256,
  });

  const writeSourceIteration = (iter: number, source: string): IterationArtifact => {
    const iterDir = iterationDir(runDir, iter);
    const agentPath = path.join(iterDir, "agent", args.agentFilename);
    writeFile(agentPath, source);
    const workspaceDir = path.join(iterDir, "workspace");
    prepareWorkspace(args.workingDir, workspaceDir, runDir);
    const workspaceAgentPath = path.join(workspaceDir, args.agentFilename);
    writeFile(workspaceAgentPath, source);
    return { iter, iterDir, agentPath, workspaceDir, workspaceAgentPath };
  };

  return {
    runDir,
    writeBaseline(source) {
      return writeSourceIteration(0, source);
    },
    writeCandidate(iter, source, mutation) {
      const artifact = writeSourceIteration(iter, source);
      const mutationPath = path.join(artifact.iterDir, "mutation.md");
      writeFile(mutationPath, mutationMarkdown(mutation.rationale, mutation.diff));
      return { ...artifact, mutationPath };
    },
    writeValidationFailure(iter, details) {
      const iterDir = iterationDir(runDir, iter);
      fs.mkdirSync(iterDir, { recursive: true });
      const mutationPath = path.join(iterDir, "mutation.md");
      writeFile(mutationPath, validationFailureMarkdown(details));
      return {
        iter,
        iterDir,
        agentPath: "",
        workspaceDir: "",
        workspaceAgentPath: "",
        mutationPath,
      };
    },
    writeRuntimeRejection(iter, error) {
      const errorPath = path.join(iterationDir(runDir, iter), "error.txt");
      writeFile(errorPath, errorText(error));
      return errorPath;
    },
    writeVerdict(iter, verdict) {
      const verdictPath = path.join(iterationDir(runDir, iter), "verdict.json");
      writeJson(verdictPath, verdict);
      return verdictPath;
    },
    writeFinalChampion(source, championIter) {
      const championPath = path.join(runDir, "champion", "agent", args.agentFilename);
      writeFile(championPath, source);
      writeFile(path.join(runDir, "champion", "championIter"), String(championIter));
      return championPath;
    },
    writeSummary(result) {
      const summaryPath = path.join(runDir, "summary.json");
      writeJson(summaryPath, result);
      return summaryPath;
    },
  };
}

function iterationDir(runDir: string, iter: number): string {
  return path.join(runDir, `iter-${iter}`);
}

function prepareWorkspace(workingDir: string, workspaceDir: string, runDir: string): void {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (fs.existsSync(workingDir) && fs.statSync(workingDir).isDirectory()) {
    copyDirectory(workingDir, workspaceDir, path.resolve(runDir));
  }
}

function copyDirectory(sourceDir: string, destDir: string, excludedDir: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    if (isInsideOrSame(sourcePath, excludedDir)) continue;
    if (entry.isDirectory() && WORKSPACE_COPY_EXCLUDED_DIRS.includes(entry.name)) continue;
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirectory(sourcePath, destPath, excludedDir);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

function isInsideOrSame(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mutationMarkdown(rationale: string, diff?: string): string {
  return [`# Mutation`, "", rationale, ...(diff ? ["", "```diff", diff, "```"] : [])].join("\n");
}

function validationFailureMarkdown(details: { attemptedPrompt: string; rationale?: string; error: string }): string {
  return [
    "# Validation failed",
    "",
    `Error: ${details.error}`,
    "",
    "Attempted prompt:",
    "```",
    details.attemptedPrompt,
    "```",
    ...(details.rationale ? ["", "Rationale:", details.rationale] : []),
  ].join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath: string, value: unknown): void {
  writeFile(filePath, JSON.stringify(value, null, 2));
}
