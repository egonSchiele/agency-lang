import { migrateStore, type MigrateResult } from "@/eval/label/migrate/migrate.js";
import { color } from "@/utils/termcolors.js";

export type EvalLabelMigrateOptions = {
  sourceDir: string;
  destDir: string;
};

/** @internal Injected so the command's reporting is testable without a disk. */
export type EvalLabelMigrateDependencies = {
  migrateStore: typeof migrateStore;
  report(message: string): void;
};

const defaultDependencies: EvalLabelMigrateDependencies = {
  migrateStore,
  report: (message) => console.log(message),
};

export function describeMigration(result: MigrateResult): string[] {
  const lines = [
    `Migrated ${result.sourceDir}`,
    `      to ${result.destDir}`,
    `  ${result.oldRecords} old record${result.oldRecords === 1 ? "" : "s"} became ` +
    `${result.newRecords}`,
    `  ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} recorded`,
    `  ${result.annotations} label${result.annotations === 1 ? "" : "s"} carried across`,
  ];
  if (result.mergedGroups > 0) {
    lines.push(
      color.dim(
        `  ${result.mergedGroups} group${result.mergedGroups === 1 ? "" : "s"} merged: records ` +
        "are now identified by their content, so outputs holding identical text are one record.",
      ),
    );
  }
  lines.push(color.dim("  The original store was not modified."));
  return lines;
}

export async function evalLabelMigrate(
  options: EvalLabelMigrateOptions,
  dependencies: EvalLabelMigrateDependencies = defaultDependencies,
): Promise<void> {
  const result = dependencies.migrateStore({
    sourceDir: options.sourceDir,
    destDir: options.destDir,
    reportWarning: (message) => console.warn(message),
  });
  for (const message of describeMigration(result)) {
    dependencies.report(message);
  }
}
