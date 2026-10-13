import {
  interruptForm,
  raiseForm,
  afterResume,
  pausedInside,
  taggedNode,
  hasInterrupts,
  approve,
  respondToInterrupts,
} from "./agent.js";
import { memoryHost } from "agency-lang/host-lib/memoryHost.js";
import { writeFileSync } from "fs";

const noSubprocess = () => memoryHost({ capabilities: ["env", "terminal", "llm"] });

// Both forms, interrupt and raise: the tagged function is refused when it
// is entered, with the capability named, and the handler never runs (it
// would have printed).
const hostA = noSubprocess();
const interruptResult = (await interruptForm({ host: hostA })).data;
const hostB = noSubprocess();
const raiseResult = (await raiseForm({ host: hostB })).data;

// The same node on a host that has everything: the handler runs and
// approves, so the refusal above was the host's and nothing else's.
const hostFull = memoryHost();
const fullResult = (await interruptForm({ host: hostFull })).data;

// A tagged node is refused when it starts, and its body never prints.
const hostD = noSubprocess();
const nodeResult = (await taggedNode({ host: hostD })).data;

// The checkpoint is taken on a host that has everything; the resume runs
// on one that lacks subprocess. The resume replays the node and enters the
// tagged function again, so it is refused there.
const full = memoryHost();
const paused = await afterResume({ host: full });
let resumed = { data: "no interrupt surfaced" };
if (hasInterrupts(paused.data)) {
  const hostC = noSubprocess();
  resumed = await respondToInterrupts(
    paused.data,
    paused.data.map(() => approve()),
    { invocation: { host: hostC } },
  );
  resumed.handlerOutput = hostC.state.output;
}

// The pause is inside the tagged function, after a person approved its
// interrupt on a full host. The resume on a smaller host replays the node,
// enters runIt again, and is refused there, so "ran ls" never appears.
const fullE = memoryHost();
const pausedInsideRun = await pausedInside({ host: fullE });
let resumedInside = { data: "no interrupt surfaced" };
if (hasInterrupts(pausedInsideRun.data)) {
  const hostE = noSubprocess();
  resumedInside = await respondToInterrupts(
    pausedInsideRun.data,
    pausedInsideRun.data.map(() => approve()),
    { invocation: { host: hostE } },
  );
  resumedInside.output = hostE.state.output;
}

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      interruptForm: interruptResult,
      interruptFormOutput: hostA.state.output,
      onFullHost: fullResult,
      onFullHostOutput: hostFull.state.output,
      raiseForm: raiseResult,
      raiseFormOutput: hostB.state.output,
      afterResume: resumed.data,
      afterResumeOutput: resumed.handlerOutput ?? [],
      taggedNode: nodeResult.success === false ? "failed: " + nodeResult.error : nodeResult,
      taggedNodeOutput: hostD.state.output,
      pausedInside: resumedInside.data,
      pausedInsideOutput: resumedInside.output ?? [],
    },
    null,
    2,
  ),
);
