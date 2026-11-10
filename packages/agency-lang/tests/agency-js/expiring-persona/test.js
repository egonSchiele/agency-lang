import {
  fromCode,
  asTool,
  asToolLegacy,
  pauseFromCode,
  failureFromCode,
  twiceFromCode,
  respondToInterrupts,
  approve,
} from "./agent.js";
import { writeFileSync } from "fs";

// Record every request the model sees, in order.
const makeCapture = () => {
  const state = { requests: [] };
  const callbacks = {
    onLLMCallStart: ({ messages }) => {
      state.requests.push(messages);
    },
  };
  return { state, callbacks };
};

const text = (message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);
const roles = (messages) => messages.map((message) => message.role);
const count = (messages, needle) =>
  messages.filter((message) => text(message).includes(needle)).length;
const counts = (state, needle) => state.requests.map((messages) => count(messages, needle));
const last = (state) => state.requests[state.requests.length - 1];

const results = {};

// Cases 1 and 2. During the agent's call the request holds the caller's
// system message and the persona. The caller's next call reads a thread
// with the caller's system message, the agent's prompt, and its reply,
// and no persona.
{
  const { state, callbacks } = makeCapture();
  const result = await fromCode({ callbacks });
  results.fromCode = {
    result: result.data,
    personaPerRequest: counts(state, "persona: be terse"),
    agentRequestRoles: roles(state.requests[0]),
    callerRequestRoles: roles(last(state)),
    callerRequestTexts: last(state).map(text),
  };
}

// Case 3. A model calls the agent as a tool. The final thread has the
// same roles and text as legacyAgent's, whose persona the hand-back
// removes.
{
  const now = makeCapture();
  await asTool({ callbacks: now.callbacks });
  const before = makeCapture();
  await asToolLegacy({ callbacks: before.callbacks });
  const final = last(now.state);
  const legacyFinal = last(before.state).map((message) => ({
    role: message.role,
    text: text(message).replaceAll("legacyAgent", "personaAgent"),
  }));
  results.asTool = {
    personaPerRequest: counts(now.state, "persona: be terse"),
    finalRoles: roles(final),
    sameAsLegacy:
      JSON.stringify(final.map((message) => ({ role: message.role, text: text(message) }))) ===
      JSON.stringify(legacyFinal),
  };
}

// Case 4. The agent's call pauses on an interrupt nobody handles. The
// checkpoint still holds the persona, and the call's request after the
// resume holds it once: that request is the one that would miss it if
// the pause had removed it. The caller's next call has none.
{
  const { state, callbacks } = makeCapture();
  const paused = await pauseFromCode({ callbacks });
  const checkpointHoldsPersona = JSON.stringify(paused.data).includes("persona: be patient");
  const resumed = await respondToInterrupts(paused.data, [approve()], {
    metadata: { callbacks },
  });
  results.pauseFromCode = {
    result: resumed.data,
    checkpointHoldsPersona,
    personaPerRequest: counts(state, "persona: be patient"),
  };
}

// Case 5. The agent's call fails. The persona leaves with it.
{
  const { state, callbacks } = makeCapture();
  const result = await failureFromCode({ callbacks });
  results.failureFromCode = {
    result: result.data,
    personaPerRequest: counts(state, "persona: be numeric"),
  };
}

// Case 6. Two calls on one thread. Each pushes the persona and each
// removes it.
{
  const { state, callbacks } = makeCapture();
  const result = await twiceFromCode({ callbacks });
  results.twiceFromCode = {
    result: result.data,
    personaPerRequest: counts(state, "persona: be terse"),
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
