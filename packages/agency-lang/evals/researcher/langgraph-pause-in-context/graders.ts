import { citationsResolve, readsInContext } from "../lib/researchGraders.js";

export default [
  readsInContext({
    truth:
      "The conversation established a setting. Each request runs in a separate process, and nothing in memory survives between requests. In that setting the user's statement is right for their purpose. A node cannot pause at a line and resume from that line in a later request. Python generators and coroutines (yield, await) do suspend a function and resume it at the same line, but only within one live process. A suspended generator cannot be pickled or otherwise moved to another process. LangGraph's interrupt() does not resume mid-line either. On resume it re-runs the interrupted node from its start. The interrupt call then returns the supplied value. Only graph state saved by the checkpointer carries over. A good answer says the user's claim holds in their setting, explains why (the process boundary), and may note that within one process yield could do it. An answer that corrects the user with yield or generators as if that solved their problem is wrong for this conversation.",
  }),
  citationsResolve(),
];
