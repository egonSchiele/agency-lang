import * as fs from "fs";
import * as path from "path";

import type { JudgeAggregationPolicy, SuiteVerdict } from "@/eval/judge/types.js";
import { copyProjectTree } from "@/utils/projectTree.js";

import type { OptimizeMutationDiagnostic, OptimizeMutationPreview } from "./sourceMutator.js";
import { sha256Text, type OptimizeTargetSet } from "./targets.js";
import type { OptimizeResult } from "./types.js";

export { sha256Text };

export type IterationAgentArtifact = {
  iter: number;
  iterDir: string;
  agentDir: string;
};

export type IterationWorkspaceArtifact = {
  iter: number;
  workspaceDir: string;
};

export type MutationArtifact = {
  iter: number;
  mutationJsonPath: string;
  mutationMarkdownPath: string;
  diffPath: string;
};

export type OptimizeArtifacts = {
  runDir: string;
  writeTargets(targetSet: OptimizeTargetSet): string;
  writeIterationAgent(iter: number, files: Record<string, string>): IterationAgentArtifact;
  writeIterationWorkspace(iter: number, files: Record<string, string>): IterationWorkspaceArtifact;
  writeMutationPreview(iter: number, preview: OptimizeMutationPreview, rationale?: string): MutationArtifact;
  writeValidationFailure(iter: number, details: { rationale?: string; diagnostics: OptimizeMutationDiagnostic[] }): string;
  writeRuntimeRejection(iter: number, error: unknown): string;
  writeVerdict(iter: number, verdict: SuiteVerdict): string;
  writeFinalChampion(files: Record<string, string>, championIter: number | "baseline"): string;
  writeSummary(result: OptimizeResult): string;
};

export function createOptimizeArtifacts(args: {
  runsDir: string;
  runId: string;
  workingDir: string;
  entryFile: string;
  node: string;
  inputsSource: string;
  iterations: number;
  judgePolicy: JudgeAggregationPolicy;
  mutatorModel?: string;
}): OptimizeArtifacts {
  const runDir = path.resolve(args.runsDir, args.runId);
  if (fs.existsSync(runDir)) {
    throw new Error(`Run directory already exists: ${runDir}. Pass a fresh --run-id or remove the directory.`);
  }
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, "config.json"), {
    runId: args.runId,
    entryFile: args.entryFile,
    node: args.node,
    workingDir: args.workingDir,
    inputsSource: args.inputsSource,
    iterations: args.iterations,
    judgePolicy: args.judgePolicy,
    mutatorModel: args.mutatorModel,
  });

  return {
    runDir,
    writeTargets(targetSet) {
      const targetsPath = path.join(runDir, "targets.json");
      writeJson(targetsPath, targetSet);
      return targetsPath;
    },
    writeIterationAgent(iter, files) {
      const iterDir = iterationDir(runDir, iter);
      const agentDir = path.join(iterDir, "agent");
      for (const [file, source] of Object.entries(files)) {
        writeFile(path.join(agentDir, file), source);
      }
      return { iter, iterDir, agentDir };
    },
    writeIterationWorkspace(iter, files) {
      const workspaceDir = path.join(iterationDir(runDir, iter), "workspace");
      prepareWorkspace(args.workingDir, workspaceDir);
      for (const [file, source] of Object.entries(files)) {
        writeFile(path.join(workspaceDir, file), source);
      }
      return { iter, workspaceDir };
    },
    writeMutationPreview(iter, preview, rationale) {
      const iterDir = iterationDir(runDir, iter);
      const mutationJsonPath = path.join(iterDir, "mutation.json");
      writeJson(mutationJsonPath, {
        ...(rationale !== undefined ? { rationale } : {}),
        changes: preview.changes,
      });
      const mutationMarkdownPath = path.join(iterDir, "mutation.md");
      writeFile(mutationMarkdownPath, mutationPreviewMarkdown(preview, rationale));
      const diffPath = path.join(iterDir, "diff.txt");
      writeFile(diffPath, preview.diff);
      return { iter, mutationJsonPath, mutationMarkdownPath, diffPath };
    },
    writeValidationFailure(iter, details) {
      const mutationPath = path.join(iterationDir(runDir, iter), "mutation.md");
      writeFile(mutationPath, validationFailureMarkdown(details));
      return mutationPath;
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
    writeFinalChampion(files, championIter) {
      const championAgentDir = path.join(runDir, "champion", "agent");
      for (const [file, source] of Object.entries(files)) {
        writeFile(path.join(championAgentDir, file), source);
      }
      writeFile(path.join(runDir, "champion", "championIter"), String(championIter));
      return championAgentDir;
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

function prepareWorkspace(workingDir: string, workspaceDir: string): void {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) {
    fs.mkdirSync(workspaceDir, { recursive: true });
    return;
  }
  // copyProjectTree handles excludes + self-skip when workspaceDir lives under workingDir.
  copyProjectTree(workingDir, workspaceDir);
}

function mutationPreviewMarkdown(preview: OptimizeMutationPreview, rationale?: string): string {
  return [
    "# Mutation",
    ...(rationale ? ["", rationale] : []),
    ...preview.changes.flatMap((change) => {
      const oldFence = codeFence(change.oldValue);
      const newFence = codeFence(change.newValue);
      return [
        "",
        `## ${change.target}`,
        ...(change.rationale ? ["", change.rationale] : []),
        "",
        "Old value:",
        oldFence,
        change.oldValue,
        oldFence,
        "",
        "New value:",
        newFence,
        change.newValue,
        newFence,
      ];
    }),
    "",
    "Full diff: see diff.txt",
  ].join("\n");
}

/** A fence longer than any backtick run in the value, so prompts that
 *  themselves contain ``` don't break the markdown. */
function codeFence(value: string): string {
  const longestRun = Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longestRun + 1);
}

function validationFailureMarkdown(details: { rationale?: string; diagnostics: OptimizeMutationDiagnostic[] }): string {
  return [
    "# Validation failed",
    "",
    "The proposed mutation operations were rejected by the source mutator:",
    ...details.diagnostics.map((diagnostic) => `- [${diagnostic.code}] ${diagnostic.message}`),
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
