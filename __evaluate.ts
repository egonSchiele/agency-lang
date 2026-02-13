import { foo } from "./foo.ts";
import { writeFileSync } from "fs";

export async function runEvaluation() {
  
  
  const result = await foo();
  
  console.log("Evaluation result:", result.data);
  writeFileSync("__evaluate.json", JSON.stringify(result, null, 2));
  return result;
}

runEvaluation();