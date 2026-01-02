import { generateTypeScript } from "@/backends/typescriptGenerator";
import { ADLProgram } from "@/types";

// Example JSON from user's request
const exampleProgram: ADLProgram = {
  type: "adlProgram",
  nodes: [
    {
      type: "typeHint",
      variableName: "bar",
      variableType: {
        type: "primitiveType",
        value: "number",
      },
    },
    {
      type: "assignment",
      variableName: "bar",
      value: {
        type: "prompt",
        segments: [
          {
            type: "text",
            value: "the number 1",
          },
        ],
      },
    },
  ],
};

// Generate TypeScript code
const generatedCode = generateTypeScript(exampleProgram);

// Output the generated code
console.log("Generated TypeScript code:");
console.log("=".repeat(80));
console.log(generatedCode);
console.log("=".repeat(80));
