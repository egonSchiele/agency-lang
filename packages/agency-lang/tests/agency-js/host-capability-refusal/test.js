import {
  interruptForm,
  raiseForm,
  afterResume,
  hasInterrupts,
  approve,
  respondToInterrupts,
} from "./agent.js";
import { memoryHost } from "agency-lang/host-lib/memoryHost.js";
import { writeFileSync } from "fs";

const noSubprocess = () => memoryHost({ capabilities: ["env", "terminal", "llm"] });

// Both forms, interrupt and raise: rejected at the raise with the
// capability named, and the handler never runs (it would have printed).
const hostA = noSubprocess();
const interruptResult = (await interruptForm({ host: hostA })).data;
const hostB = noSubprocess();
const raiseResult = (await raiseForm({ host: hostB })).data;

// The same node on a host that has everything: the handler runs and
// approves, so the refusal above was the host's and nothing else's.
const hostFull = memoryHost();
const fullResult = (await interruptForm({ host: hostFull })).data;

// The checkpoint is taken on a host that has everything; the resume runs
// on one that lacks subprocess, and the tagged raise after the resume is
// still refused.
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
    },
    null,
    2,
  ),
);
