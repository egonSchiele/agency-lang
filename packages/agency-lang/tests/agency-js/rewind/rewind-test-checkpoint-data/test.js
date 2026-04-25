import { main } from "./agent.js";
import { writeFileSync } from "fs";
import { z } from "zod";

const RewindCheckpointSchema = z.object({
  checkpoint: z.object({
    stack: z.object({ stack: z.array(z.any()) }),
    globals: z.any(),
    nodeId: z.string(),
  }),
  llmCall: z.object({
    step: z.number(),
    targetVariable: z.string(),
    prompt: z.string(),
    response: z.unknown(),
    model: z.string(),
  }),
});

const checkpoints = [];

const result = await main("I feel great!", {
  callbacks: {
    onCheckpoint(cp) {
      checkpoints.push(cp);
    },
  },
});

// Validate each checkpoint against the schema
const validations = checkpoints.map((cp) => RewindCheckpointSchema.safeParse(cp));
const allValid = validations.every((v) => v.success);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      checkpointCount: checkpoints.length,
      allCheckpointsValid: allValid,
      targetVariables: checkpoints.map((cp) => cp.llmCall.targetVariable),
      resultHasData: result.data !== undefined,
    },
    null,
    2,
  ),
);
