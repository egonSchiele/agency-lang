import { citationsResolve, readsInContext } from "../lib/researchGraders.js";

export default [
  readsInContext({
    truth:
      "In the setting the conversation fixed (each request in a separate process, nothing in memory surviving), the user's statement is right for their purpose: a node cannot pause at a line and resume from that line in a later request. Python generators and coroutines (yield, await) do suspend a function and resume it at the same line, but only within one live process; a suspended generator cannot be pickled or otherwise moved to another process. LangGraph's interrupt() does not resume mid-line either: on resume it re-runs the interrupted node from its start, with the interrupt call returning the supplied value, and only graph state saved by the checkpointer carries over. A good answer says the user's claim holds in their setting, explains why (the process boundary), and may note that within one process yield could do it. An answer that corrects the user with yield or generators as if that solved their problem is wrong for this conversation.",
  }),
  citationsResolve(),
];
