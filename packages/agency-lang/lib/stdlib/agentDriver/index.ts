// The session driver: what a front-end of the agent uses to start a
// session run, resume it, answer its approvals, and save and load it.
// Reached as `agency-lang/stdlib-lib/agentDriver/index.js`. See
// docs/dev/agents/session-driver.md.
export {
  SESSION_INPUT_EFFECT,
  messageAnswer,
  pauseData,
  type Answer,
  type CapabilityChange,
  type LimitFlags,
  type MessageAnswer,
  type ModelFlags,
  type PauseData,
  type ProgramStart,
  type ResolvedModel,
  type SessionStart,
  type SettingsAnswer,
  type TraceSettings,
  type TurnBudget,
} from "./interface.js";
export { sessionRunPolicy, withPauseLeftAlone } from "./policy.js";
export {
  copyCarriedPolicy,
  POLICY_UNREADABLE,
  SESSION_POLICIES_DIR,
  readCarriedPolicy,
  removeCarriedPolicy,
  saveCarriedPolicy,
} from "./sessionPolicy.js";
export {
  PAUSE_WITH_OTHER_INTERRUPTS_ERROR,
  RUN_ENDED_ERROR,
  cancelNote,
  resumeRun,
  startRun,
  toStep,
  type AgentModule,
  type AgentStep,
  type LegOutcome,
  type RespondToInterrupts,
  type ResumeInvocation,
  type ResumeMetadata,
  type ResumeOptions,
  type StartOptions,
} from "./run.js";
export {
  currentApproval,
  declineUndecided,
  respondWith,
  startQueue,
  type ApprovalQueue,
  type QueueStep,
  type Settle,
  type Settled,
  type SettledBy,
} from "./approvals.js";
export {
  initialPhase,
  reduceDriver,
  type DriverAction,
  type DriverPhase,
  type DriverStep,
  type DroppedTexts,
  type Happened,
  type Leg,
} from "./machine.js";
// Reading and stopping the jobs is in jobControl.ts, which is Node-only.
export { heldJobsOf, jobsStartedBetween } from "./jobs.js";
export {
  CANNOT_CONTINUE,
  PROGRAM_NOT_LOADED,
  restoredPhase,
  saveRun,
  savedRun,
  stillHeld,
  takeHold,
  thisProcessId,
  type Holder,
} from "./savedRun.js";
export {
  canResume,
  checkpointIn,
  isSavedRun,
  readSavedRun,
  type SavedRun,
  type SavedTurn,
  type SessionHolder,
} from "../agentSessions.js";
