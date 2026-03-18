import { AgencyProgram } from "../types.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo, type ProgramInfo } from "@/programInfo.js";
import { AgencyConfig } from "@/config.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { printTs } from "../ir/prettyPrint.js";

export function generateTypeScript(
  program: AgencyProgram,
  config?: AgencyConfig,
  info?: ProgramInfo,
  moduleId?: string,
): string {
  if (!moduleId) {
    throw new Error("moduleId is required for generateTypeScript");
  }
  const programInfo = info ?? collectProgramInfo(program);
  const preprocessor = new TypescriptPreprocessor(program, config, programInfo);
  const preprocessedProgram = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(config, programInfo, moduleId);
  const ir = builder.build(preprocessedProgram);
  return printTs(ir);
}
