import { z } from "zod";

// MessageThreadJSON
// Every field MessageThread.toJSON writes. zod strips keys a schema does
// not name, so a field missing here is dropped when a checkpoint is read
// back from JSON.
export const messageThreadJSONSchema = z.object({
  messages: z.array(z.any()),
  messageLabels: z.array(z.string().nullable()).optional(),
  parentId: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
  label: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  queuedMessages: z.array(z.any()).optional(),
  repairs: z.number().int().nonnegative().optional(),
});

// ThreadStoreJSON
export const threadStoreJSONSchema = z.object({
  threads: z.record(z.string(), messageThreadJSONSchema),
  counter: z.number(),
  activeStack: z.array(z.string()),
  sessions: z.record(z.string(), z.string()).optional(),
});

// GuardJSON — every field CostGuard.toJSON / TimeGuard.toJSON write.
// Discriminated on `kind`; the base fields are shared by both kinds.
const guardJSONBase = {
  guardId: z.string().optional(),
  label: z.string().optional(),
  scopeIds: z.array(z.string()).optional(),
  disarmed: z.boolean().optional(),
  isRootBudget: z.boolean().optional(),
};
export const guardJSONSchema = z.discriminatedUnion("kind", [
  z.object({ ...guardJSONBase, kind: z.literal("cost"), costLimit: z.number(), spent: z.number() }),
  z.object({
    ...guardJSONBase,
    kind: z.literal("time"),
    timeLimit: z.number(),
    elapsedMs: z.number(),
    grantedMs: z.number().optional(),
  }),
]);

// BranchStateJSON (forward-declared due to mutual recursion with StateStackJSON)
export const branchStateJSONSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    stack: stateStackJSONSchema,
    interruptId: z.string().optional(),
    interruptData: z.any().optional(),
    result: z.object({ result: z.any() }).optional(),
    globalsJSON: globalStoreJSONSchema.optional(),
    activeStack: z.array(z.string()).optional(),
  }),
);

// StateJSON
export const stateJSONSchema = z.object({
  args: z.record(z.string(), z.any()),
  locals: z.record(z.string(), z.any()),
  threads: threadStoreJSONSchema.nullable(),
  step: z.number(),
  // Accepts absent (external payloads validated pre-tripwire) and
  // normalizes to null so the parsed shape satisfies StateJSON.
  scopeName: z.string().nullable().optional().default(null),
  // No .default(): injecting moduleId into a frame that did not carry it
  // would change the canonical bytes of checkpoints signed before this field
  // existed, making them verify false. Absent stays absent.
  moduleId: z.string().nullable().optional(),
  branches: z.record(z.string(), branchStateJSONSchema).optional(),
  scopedCallbacks: z.array(z.object({ name: z.string(), fn: z.any() })).optional(),
  savedDraft: z.object({ value: z.any() }).optional(),
});

// StateStackJSON
export const stateStackJSONSchema = z.object({
  stack: z.array(stateJSONSchema),
  mode: z.enum(["serialize", "deserialize"]),
  other: z.record(z.string(), z.any()),
  deserializeStackLength: z.number(),
  nodesTraversed: z.array(z.string()),
  localCost: z.number().optional(),
  localTokens: z.number().optional(),
  seedCost: z.number().optional(),
  seedTokens: z.number().optional(),
  guards: z.array(guardJSONSchema).optional(),
  inheritedGuardCount: z.number().optional(),
  inheritedTimeGuards: z.array(guardJSONSchema).optional(),
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
  moduleFingerprints: z
    .record(z.string(), z.object({ hash: z.string(), compiledAt: z.string() }))
    .optional(),
  signature: z.string().optional(),
});
