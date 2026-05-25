# Policy Checking

## The Idea

Allow users (and agents) to define policies — declarative rules about what generated code is and isn't allowed to do — and enforce them at compile time before execution.

## Why It Matters

Handler coverage analysis answers "did you handle every dangerous operation?" Policy checking answers a broader question: "does this code conform to the rules I've set?" Policies can express constraints that type checking and handler coverage can't:

- "No shell access at all"
- "File operations only within /tmp/workspace"
- "Network requests only to api.example.com"
- "Maximum 3 LLM calls"
- "No fork (single-threaded execution only)"

The especially interesting angle: **an agent that writes a sub-agent could also define a policy for it**, and the user reviews the policy before execution. This adds a structured, reviewable security layer: instead of reviewing the full generated code, the user reviews a concise policy document.

## How It Would Work

### Policy Definition

Policies could be defined in Agency or as config:

```
// As Agency code (strawman syntax)
policy SubAgentPolicy {
  allow std::fs.read
  deny std::fs.write
  deny std::shell.*
  allow std::http.fetch(domain: "api.example.com")
  limit llm_calls: 10
  require handler_coverage
}
```

Or as JSON in agency.json:
```json
{
  "policy": {
    "allow": ["std::fs.read"],
    "deny": ["std::fs.write", "std::shell.*"],
    "limits": { "llm_calls": 10 }
  }
}
```

### Policy Enforcement

1. Agent generates code and a policy for it
2. User reviews the policy (much easier than reviewing the full code)
3. Compiler checks generated code against the policy
4. If code violates policy, compilation fails with clear error messages
5. If code passes policy, it executes with handler propagation for runtime safety

### Guaranteeing Policy Usage

Key question from brainstorming: how do we guarantee the policy actually gets used when the sub-agent executes?

Options:
- **Compile-time enforcement**: The `run()` function requires a policy parameter. Code is checked against the policy during compilation, before execution begins.
- **Runtime enforcement**: The subprocess runtime checks every operation against the policy at runtime, in addition to compile-time checks. Belt and suspenders.
- **Signed policies**: The compiled output includes a hash of the policy it was checked against. At runtime, the executor verifies the hash matches, preventing tampering.

## Key Questions

- **Policy language**: Agency syntax? JSON? A DSL? How expressive does it need to be?
- **Granularity**: Function-level allow/deny? Argument-level constraints (e.g., "allow fs.read only in /safe/dir")? Resource limits (max LLM calls, max subprocess time)?
- **Composability**: Can policies inherit from or extend other policies? Can a parent policy constrain what child policies are allowed to permit?
- **Agent-defined policies**: When an agent defines a policy for a sub-agent, what meta-policy constrains what the agent is allowed to allow? (Policies all the way down?)
- **Relationship to handlers**: Policies are compile-time; handlers are runtime. How do they interact? Is a policy violation at compile time strictly better than a handler rejection at runtime?
- **User review UX**: How does the user review a policy? Just printed to console? A structured diff against a baseline policy?
- **Standard library annotations**: Stdlib functions would need metadata about what capabilities they require (filesystem, network, shell, etc.)

## Complexity Considerations

- Policy checking with argument-level constraints (e.g., "only allow reads in /safe/dir") starts to look like dependent types or contract checking — potentially very complex
- Wildcard patterns (std::shell.*) need careful semantics
- The interaction between compile-time policies and runtime handlers needs clear mental model

## Dependencies

- Needs capability metadata for stdlib functions (which capabilities does each function use?)
- Benefits from handler coverage analysis (handler coverage is one policy rule)
- Benefits from language simplification (simpler language = easier to reason about allowed operations)

## Related Ideas

- Handler coverage analysis (one specific policy rule)
- Subprocess IPC (policies are most valuable for agent-generated sub-agents)
- Symbolic execution (could verify policy compliance across all execution paths)
- Language simplification (simpler language = more precise policy checking)
