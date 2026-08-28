import { citationsResolve, readsInContext } from "../lib/researchGraders.js";

export default [
  readsInContext({
    truth: `In this conversation, a user is requesting help with LangGraph, which is a framework for building agents. They're specifically requesting help with its human-in-the-loop feature, which is a feature that allows agents to pause and ask for human approval before taking an action. After the human responds, the agent resumes from where it left off. Unfortunately, it cannot resume from the exact line where it left off,  and has to resume from the start of the function where the interrupt was raised.

The user asks why this is the case, and asks if this is a language level limitation – if it's because Python cannot resume code from an exact line where it left off. Now, as it happens, Python can resume from an exact line, using Python generators and coroutines (yield and await). However, it can only do so within a live process, it cannot do so across processes. The user has already established earlier in the conversation that they are using this agent as part of a web app. The unspoken context is that they require the agent to be able to pause and resume across processes.

Please grade the agent's response based on whether they understand this unspoken context. Their answer should indicate that yes, this is a language level limitation because Python cannot resume code from an exact line across processes. If the agent response contains this information, they should get full marks. If their response says that it's not a language level limitation because Python can resume code using Python generators and coroutines, that is a bad response because it indicates that the agent is only responding to the user's exact question, and not taking the context of the web app provided earlier in the conversation into account. In that case, the response should receive zero marks.

Note that it is perfectly fine for the agent's response to mention generators and co-routines as a way to resume from a line within a single process, but it should make it clear that for the user's specific use case, yes, this is a language level limitation. `,
  }),
  citationsResolve(),
];
