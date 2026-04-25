import { z } from "zod";

// MessageThreadJSON
export const messageThreadJSONSchema = z.object({
  messages: z.array(z.any()),
});

// ThreadStoreJSON
export const threadStoreJSONSchema = z.object({
  threads: z.record(z.string(), messageThreadJSONSchema),
  counter: z.number(),
  activeStack: z.array(z.string()),
});

// BranchStateJSON (forward-declared due to mutual recursion with StateStackJSON)
export const branchStateJSONSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    stack: stateStackJSONSchema,
    interruptId: z.string().optional(),
    interruptData: z.any().optional(),
  }),
);

// StateJSON
export const stateJSONSchema = z.object({
  args: z.record(z.string(), z.any()),
  locals: z.record(z.string(), z.any()),
  threads: threadStoreJSONSchema.nullable(),
  step: z.number(),
  branches: z.record(z.string(), branchStateJSONSchema).optional(),
});

// StateStackJSON
export const stateStackJSONSchema = z.object({
  stack: z.array(stateJSONSchema),
  mode: z.enum(["serialize", "deserialize"]),
  other: z.record(z.string(), z.any()),
  deserializeStackLength: z.number(),
  nodesTraversed: z.array(z.string()),
});

// GlobalStoreJSON
export const globalStoreJSONSchema = z.object({
  store: z.record(z.string(), z.record(z.string(), z.any())),
  initializedModules: z.array(z.string()),
});

// Checkpoint
export const checkpointSchema = z.object({
  id: z.number(),
  stack: stateStackJSONSchema,
  globals: globalStoreJSONSchema,
  nodeId: z.string(),
  moduleId: z.string().optional().default(""),
  scopeName: z.string().optional().default(""),
  stepPath: z.string().optional().default(""),
  label: z.string().nullable().optional().default(null),
  pinned: z.boolean().optional().default(false),
});
