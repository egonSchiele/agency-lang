# Message thread test cases

There are a lot of cases to test with message threads, so this doc keeps a list of all the cases and where the tests for those cases are.

- Create a message thread with two messages: tests/agency/threads/simple.agency
- Assign a variable to a message thread: tests/agency/threads/messages.agency
- Message thread with sub-threads: tests/agency/threads/subthreads.agency
- message thread with nested threads: tests/agency/threads/nested-threads.agency
- message thread with mixed nested threads and subthreads: tests/agency/threads/nested-threads-and-subthreads.agency
- Message threads nested more than two levels deep: tests/agency/threads/thread-three-levels-deep.agency
- Pass a thread's messages into a later LLM call and check recall: tests/agency/threads/pass-messages.agency
- Two LLM calls in one node share history with no explicit thread: tests/agency/threads/default-shared-thread.agency
- The same, across two nodes: tests/agency/threads/default-shared-cross-node.agency

- message thread with nested function calls: tests/agency/threads/nested-function-calls/nested-three-levels-deep.agency
- the same function being called inside and outside a message thread: tests/agency/threads/nested-function-calls/inside-and-outside.agency
- subthreads inside functions: tests/agency/threads/subthread-inside-function.agency
- threads inside functions: tests/agency/threads/thread-inside-function.agency
- subthread with no parent thread: tests/agency/threads/subthread-no-parent-thread.agency

- Not in a thread, but one LLM call depends on the result of another LLM call.: tests/agency/threads/no-thread-dependent-call.agency
- In a parallel thread, but one LLM call depends on the result of another LLM call. (test not yet written)

- A function called as a tool gets a fresh thread store; a `handoff def` called as a tool continues the caller's thread. Cases, all in tests/agency-js/handoff:
  - the body's messages land on the caller's thread, with the marker in place of the tool call and a resume message at the end (`basic`)
  - system messages the body pushes are removed when it returns (`persona`)
  - a handoff beside another call is refused (`notAlone`)
  - `thread {}` inside the body still isolates (`threadInside`)
  - `subthread {}` inside the body inherits the caller's history and does not flow back (`subthreadInside`)
  - an interrupt inside the body resumes without a second marker (`pauseInside`), and a rejection inside the body reaches the body's own model (`rejectInside`)
  - a failure return hands back with the error (`failureInside`), and a rejected handoff call hands back with the rejection (`rejectHandoff`)
  - a handoff inside a handoff (`nested`)
- A handoff function called from code runs on the caller's thread: tests/agency/agents/oracleExplorer.agency (`twoOracleCallsShareTheCallerThread`, `explorerFromCodeLandsOnTheCallerThread`)
- If I do want to transfer message history to another node, how would I do that?

- We also need to test messages being returned from an agent to JavaScript
- messages being returned from a function to a node
- A JavaScript file calling an agent with message history
- making an LLM call with message history
- making an LLM call inside a subthread with message history
- Making an LLM call inside a thread with message history
- Making an LLM call inside a thread with message history with the LLM call not being the first call.

- func calls assigned to a var
- built-in function calls
- built-in function calls assigned to a var

- no thread -- just making sure that if there is no thread, things run async as normal: tests/agency/threads/no-thread.agency

- do funcs specifically marked sync/async create threads? What about func calls that are awaited?