import { AgencyProgram } from "../types.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit, type CompilationUnit } from "@/compilationUnit.js";
import { AgencyConfig } from "@/config.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { printTs } from "../ir/prettyPrint.js";

export function generateTypeScript(
  program: AgencyProgram,
  config?: AgencyConfig,
  info?: CompilationUnit,
  moduleId?: string,
  outputFile?: string,
): string {
  if (!moduleId) {
    throw new Error("moduleId is required for generateTypeScript");
  }
  const programInfo = info ?? buildCompilationUnit(program);
  const preprocessor = new TypescriptPreprocessor(program, config, programInfo);
  const preprocessedProgram = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(config, programInfo, moduleId, outputFile);
  const ir = builder.build(preprocessedProgram);
  return printTs(ir);
}
