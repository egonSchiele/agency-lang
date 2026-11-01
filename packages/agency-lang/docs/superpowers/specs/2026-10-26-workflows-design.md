# Workflows: step lists that compile to Agency programs

Status: part 1 (the generator, `compileWorkflow`, `checkWorkflow`) shipped in #1292. Revised 2026-10-28 with the owner's answers for the rest; decisions 16 to 25 and "The parts" record them. Created 2026-10-26.

## The problem

When you want an agent to do the same task the same way every time, you have two choices today:

- **A skill.** A Markdown file the agent reads before it starts. Easy to write and easy to show a person. But the agent reads the skill and then decides what to do, so the next run may take a different route. A skill is a suggestion.
- **Code.** An Agency program. The route is fixed. But a program is a bad thing to show someone on an iPad who only wants to know "what will this do?", and most people will not write one.

A **workflow** sits between the two. It is a list of steps, as JSON, where each step calls a tool or asks a model, and a later step's arguments can point at an earlier step's result. It is as fixed as code, because the steps and their arguments are written down. It is as easy to show as a skill, because a list of named steps is something a person can read or draw.

The example that drives this design. BMO, a household assistant built on Agency, was asked:

> In my Apple notes, you'll find a note labeled "Groceries 2026". At the bottom of this note, you'll find the meal plan for the week. Please update the weekly meal plan list with the contents of the meal plan from this note.

The owner wants to write that down as a workflow once, and have next week's run take the same route, with the same approvals, without a model choosing the route again.

## The two rules

**1. A workflow is a thin layer over Agency.** A workflow gives people a visual way to write a basic Agency program. That is all it is. Anything that needs run-time behavior is an Agency function the workflow calls. The format never grows a feature Agency already has. When a new proposal comes up, the question is "is this a step kind, or is this a function?", and the answer is "a function" unless proven otherwise.

**2. A workflow is not a second language.** Every system that stored steps as JSON went on to add string formatting, then conditionals, then an expression language, and ended up as a worse programming language with no typechecker. AWS Step Functions is the clearest case: it shipped with path references, added a dozen intrinsic functions (`States.Format`, `States.StringSplit`, `States.MathAdd`) because every transformation otherwise needed a Lambda deployment, and eight years later adopted JSONata, a real expression language, to replace them. The pressure was real because a Lambda was expensive. In Agency a function is one `def`, so the pressure has somewhere cheap to go: every transformation is a function the workflow calls. The format has tool steps, LLM steps, and references, and nothing else in this version. Conditionals and loops may come later as new step kinds. String formatting, if it is ever needed, is a function, not a step kind.

## How it works

A workflow is JSON. To run it, Agency **generates an Agency program from it** and runs that program the way it runs any other. No new runtime code exists for workflows. Every Agency feature applies: the typechecker checks the generated code, every tool step raises the interrupts the tool raises, the user's policy answers them, a paused workflow checkpoints and resumes at its exact line, and guards cap its cost and time. Any future change to Agency applies to workflows without a change here.

This also answers "why is this not a `def`?": it is one. The JSON is the form a person reads and a GUI draws. The program is the form that runs.

### Where the model is and is not

Running a workflow is deterministic except inside LLM steps. A tool step always calls the same tool with arguments built the same way. An LLM step calls a model, so its content varies, but its output type is fixed, so later steps always get a value of the type they expect. No model chooses which tool to call or in what order.

### Why interrupts make this safe

A person approves the JSON, and code runs. If the generator ever did something the JSON did not say, the dangerous action would still be gated by its own interrupt at the moment of action, with its real arguments shown. That gate is at the action, not at the approval of a description of the action, which is what makes this safer than the systems it borrows from. The generator is also deterministic: the same JSON produces the same source, byte for byte, so what a person saw is what runs.

## Decisions, and why

These came out of the design conversation and are settled. Each one records the reason, because the reasons are what should stop the design drifting later.

**1. A workflow is a thin layer over Agency, and that is all it is.** The value of a workflow is that it gives a person a visual way to write a basic Agency program. Any real functionality comes from Agency itself. The layer stays as thin as it can be. *Why:* every workflow system that let its data format carry behavior ended up maintaining a second, worse language. Agency already has the language, the typechecker, the interrupts, and the resume story. Putting any of that in the JSON would duplicate it, and the duplicate is where the bugs would live.

**2. Workflows are JSON, and the JSON is compiled to Agency source and run as an ordinary program.** *Why:* data is what a person reads and a GUI draws, so the JSON has to exist. But running it through an interpreter of its own would mean new runtime code that has to get interrupts, checkpoints, resume, guards, and isolation right all over again. Generating Agency code means none of that is new: the typechecker checks the generated code, every tool step raises its own interrupts, a paused workflow resumes at its line, and every future change to Agency applies to workflows for free.

**3. The format never grows a feature Agency already has.** It has tool steps, LLM steps, and references. Conditionals and loops may be added later as step kinds. Nothing else will be. *Why:* the prior art. AWS Step Functions started with path references, added intrinsic functions one at a time (string formatting, splitting, arithmetic, array operations) because every transformation otherwise needed a Lambda deployment, and ended by adopting a full expression language. Argo and Windmill went the same way faster. The pressure is real, and the way to hold the line is to make the escape hatch cheap: in Agency it is one `def`.

**4. Every transformation is a function call.** No intrinsic functions, no `format` step, no string interpolation. *Why:* a function is cheap to write and cheap to call, which is exactly what Step Functions lacked. Since the workflow is lowered to Agency, every such call is typechecked. If users turn out to need string building, it becomes one function in `std::workflow`, never a step kind. Utilities in `std::workflow` stay minimal until users show what they need. Template Agency closes the security hole that interpolation opened in GitHub Actions and n8n: a value a user types into a workflow is filled into an expression hole and is never parsed as code.

**5. A tool's `Result` is unwrapped automatically, and a failure stops the workflow.** The unwrapped success is what later steps reference. *Why:* this is how Agency's own error handling works. A failure is self-propagating; passing one to a typed parameter skips the function and returns the failure. The generated code only adds the step's name to the message. When users need to say what to do on failure, that is its own step kind, lowered to a `match` on `success` and `failure`, and for that step the automatic unwrap is skipped. It is not built now.

**6. The host decides which tools a workflow may call, and which modules it may import, with one list of function values.** *Why:* a function value already carries its module and name, so the generator can derive the imports and `checkWorkflow` can refuse any step that names something not in the list. The host never writes module strings, and the format's `module` field is verified against real functions rather than trusted. This adds safety in both directions: the workflow cannot reach a tool the host did not pass, and it cannot import a module the host did not pass.

**7. A user file is named by a path relative to the directory the host passes at run time.** Path aliases, like TypeScript's `paths`, were considered and set aside. *Why:* `runCode` already confines local imports to `dir`. Aliases would let a saved workflow survive a file move, but they are a compiler feature with a config surface, and `std::` and `pkg::` are already two naming schemes. A third waits for a second user.

**8. A workflow runs in a subprocess through `runCode`.** Letting a subprocess import a host-approved list of TypeScript files is a separate change to `run`, in its own PR, and is not part of this work. *Why:* code an agent writes and runs must be Agency only, because Agency is the only language that gives the security guarantees we want. BMO's tools import TypeScript helpers, so there is a real case for a host-approved allow list, but it has to be designed so a nested subprocess can narrow the list and never widen it, which is the shape `maxDepth` already has. That is enough work to be its own PR with its own dev doc.

**9. For this version, workflows are written by hand or by a GUI.** Writing one from the log of a past run, and an agent that drafts one from a transcript, come later. *Why:* the point of the first version is to find out whether the idea works. The transcript reader and the designer agent are each a project, and neither is needed to test the format, the generator, or the run path.

**10. Executing a workflow means running its `main` node.** Offering it to a model as a tool is one function value that runs the workflow, built as a partial of `runWorkflow` with the inputs schema attached. *Why:* a workflow is a program that runs step by step, not a bunch of tools for an agent to pick from. `learn` extracts functions from a module and was the wrong tool for this. The toolbox's `requestSchema` node is the precedent for how the tool learns its parameter schema.

**11. The generated source is not saved beside the JSON in this version.** `compileWorkflow` returns it so a user can save it themselves. *Why:* it is not needed to prove the idea. The interrupts, not a saved file, are the safety argument: if the generated code ever did something the JSON did not say, the dangerous action would still be gated at the moment of action with its real arguments shown.

**12. The generator is deterministic.** The same JSON produces the same source, byte for byte. *Why:* what a person approved is what runs, and a test can hold the generator to it.

**13. The generator emits Agency source text, not an Agency AST.** *Why:* the AST is the compiler's own representation, and it moves. Its type definitions run to about 2,600 lines, and in the 60 days before this spec was revised, 21 commits changed the AST or the parser (decorators, parameter aliases, type casts, the capabilities tag). Its shapes are not what source suggests: `x is failure` parses to a call of `isFailure`, a string is a list of text and interpolation segments, every node carries a location. Building that by hand would re-derive what the parser knows and would break silently with each language change. Emitting source means the parser does the lowering, the typechecker checks the result, and every future language change reaches workflows with no change here. A workflow-specific intermediate representation between the JSON and the source was considered and set aside for the same reason: it would be a smaller copy of the AST with its own printer.

**14. The generator is built as stages over data, in the shape of the compiler.** Parse, resolve, lower, print. Each stage is a pure function from one data shape to the next, and the problems it can find are reported there. *Why:* this is the shape the Agency compiler has (parser, preprocessor passes, builder, printer), and it is what keeps a future step kind a local change: a conditional touches the parse shape, one resolve rule, and one lowering function, and nothing else. The stages are described under "How the generator is built".

**15. Hand-written helpers follow the anti-pattern catalog, and in particular the rule that imperative code sits behind a declarative interface.** The specific choices: validation is a list of rule functions concatenated, not one loop; a step's generated lines are a list of pieces that each know their owner, and the line map is derived from that list, never from a running counter; the field a type error belongs to comes from the diagnostic's structured payload, never from its message text; duplicate tool names are caught by the tool loop's own `assertUniqueToolNames`; an identifier is whatever the parser's `identifierParser` accepts; and a tool's return type comes from a `returnType` field that `describe` prints from the AST, so no caller re-parses a signature string. *Why:* these are the places a first draft of the plan put imperative or duplicated code, and each has an existing declarative home.

**16. A run asks two questions: `std::workflow::run`, then `std::run`.** *Why:* `std::run`'s payload names a generated module, which a policy cannot tie to a workflow. `std::workflow::run` carries the workflow's name and directory, so it is the prompt a person reads and the rule a policy pins. The toolbox asks its two the same way.

**17. A workflow's inputs are checked with `!`.** The generated program declares `main(inputs: Inputs!)`, so a value that does not fit the `inputs` type fails before the first step, with a message naming the field. *Why:* it is the language's own way to check a parameter, and the check runs where the value is used. It needs nodes to honour `!`, which they did not; #1297 fixes that.

**18. A context value that is a string reaches the model as its text. Any other value reaches it as JSON.** *Why:* a note body sent as JSON is one line with every line break written as `\n`, which is harder for a model to read. The generated code decides per value with `if v is string then v else JSON.stringify(v)`, because the generator does not know a reference's type.

**19. Partials and renamed functions stay refused.** The host passes the original defs. *Why:* the owner decided against writing a partial's bound values into the generated call.

**20. Limits apply to the whole workflow and to each step.** A step's `limits` has the same shape as the workflow's and lowers to a `guard` around that step's call in the generated code. *Why:* the tool is defined elsewhere (BMO's tools already exist), but the call is in the generated program, so the generator can put the guard around it. A method that attaches limits to a function value, `tool.guard(maxTime: 1m)`, would help a host that hands tools to `llm()`; it is a separate language feature and workflows do not need it. A guard around a call that returns a `Result` passes that `Result` through at run time, but the type checker types it `Result<Result<T>>`; the type checker is fixed to match, as `try` already does, before step limits are built.

**21. A limit must be a positive number, and `maxTime` at most one hour less 30 seconds.** *Why:* `guard` turns a negative limit into "no limit", so `maxCost: -1` would silently remove the cap. The subprocess gets the workflow's `maxTime` plus 30 seconds of wall clock (the toolbox's headroom), so the guard trips and reports before the process is killed, and `run` refuses more than an hour. With no workflow `maxTime`, the subprocess gets `run`'s default of 60 seconds.

**22. `runWorkflow` checks, then asks, then runs the program the check compiled.** *Why:* asking a person to approve a workflow that fails its own check wastes a prompt, and compiling twice could read the tool modules twice.

**23. Saving runs the full check, and the workflow's own `name` names its directory.** `writeWorkflow(workflow, tools, dir)` compiles and typechecks the workflow before anything is written. *Why:* a saved workflow should be one that compiles. The check needs the tool list, because the program imports the tools and the generator reads their signatures. A separate `name` parameter would be a second name that could disagree with the workflow's.

**24. A saved workflow's inputs schema is computed when it is saved and stored in the saved file's `meta`.** *Why:* only compiled code can turn the `inputs` type into a JSON Schema, which means a subprocess and a `std::run` prompt. Computing it at save time means `workflowTools` reads files instead of starting one subprocess per workflow each time a host builds its tool list. The toolbox stores its request schema the same way.

**25. A child process inherits the host's config.** Today only environment variables, the log settings, and `client.providerModules` reach it; `client.defaultModel`, `client.baseUrl`, and the rest of `agency.json` do not, because they are written into a program when it is compiled and the child is compiled with a fixed sandbox config. The parent will send its whole resolved config when it starts the child. That is a change to `run`, in its own PR. A client set from TypeScript with `setLLMClient` is an object and cannot be copied; reaching it would mean the child sends each model call back to the parent. That waits for a host that needs it: BMO sets its client from TypeScript only in a test.

## Goals

- A person can write a workflow by hand, or a GUI can write one, and the result is checked before it is saved or run.
- A saved workflow runs against the host's own tools, so every tool step raises the same interrupts it would raise in a conversation and the user's approval policy applies unchanged.
- Problems are reported in words a person can act on, naming the step and the field.
- A saved workflow can be offered to a model as one ordinary tool, with the workflow's inputs as the tool's parameters.
- A host can read a catalog of the tools a workflow may use, with their parameters and return types, to build a GUI.

## Non-goals

- Conditionals, loops, parallel steps, expressions, or templating inside strings.
- Writing a workflow from a past run's log, or an agent that drafts workflows. Both come later.
- A visual editor in the Agency package. The format is designed to be drawn, but drawing it is the host's job.
- TypeScript in the import closure of a workflow's tools. That is the separate `run` change.

## Anti-goals

Things that would make this a failure even if it worked:

- A tool step that runs without raising the tool's interrupts.
- A workflow format with a second way to say something Agency already says.
- A generator whose output a person cannot predict from the JSON.

## The format

Here is the meal plan example:

```json
{
  "format": 1,
  "name": "updateMealPlanFromNote",
  "description": "Copy this week's meal plan from the groceries note to the weekly meal plan list.",
  "inputs": "{ noteTitle: string }",
  "steps": [
    {
      "id": "note",
      "kind": "tool",
      "module": "./src/agent/appleNotes.agency",
      "tool": "searchNotes",
      "args": { "query": { "$ref": "inputs.noteTitle" } }
    },
    {
      "id": "text",
      "kind": "tool",
      "module": "./src/agent/appleNotes.agency",
      "tool": "readNote",
      "args": { "id": { "$ref": "steps.note[0].id" } }
    },
    {
      "id": "list",
      "kind": "tool",
      "module": "./src/agent/lists.agency",
      "tool": "findLists",
      "args": { "query": "weekly meal plan" }
    },
    {
      "id": "meals",
      "kind": "llm",
      "prompt": "The note below ends with this week's meal plan, one meal per line. Return the meals as a list of strings, in order, without day names.",
      "context": [{ "$ref": "steps.text.body" }],
      "output": "string[]"
    },
    {
      "id": "add",
      "kind": "tool",
      "module": "./src/agent/lists.agency",
      "tool": "addListItems",
      "args": {
        "listId": { "$ref": "steps.list[0].id" },
        "items": { "$ref": "steps.meals" },
        "section": "Meals"
      }
    }
  ],
  "result": { "$ref": "steps.add" },
  "limits": { "maxCost": 1.0, "maxTime": 300000 }
}
```

### Fields

| Field | Meaning |
| --- | --- |
| `format` | The format version, `1`. A reader refuses a version it does not know. Adding a step kind bumps the version. |
| `name` | An identifier: letters, digits, underscores. It is the directory name when saved and the tool name when offered to a model. |
| `description` | One or two sentences. It is the tool description when the workflow is offered to a model. |
| `inputs` | An Agency object type, as text. It becomes the `Inputs` type of the generated program and the parameter schema of the tool. |
| `steps` | The steps, run in order. |
| `result` | Optional. A reference or a literal that is the workflow's return value. Without it, the last step's value is returned. |
| `limits` | Optional. `maxCost` in dollars and `maxTime` in milliseconds, applied as a `guard` around the steps. Each is a positive number; `maxTime` is at most 3570000 (one hour less 30 seconds). |

### Steps

Every step has an `id`, an identifier unique within the workflow, and a `kind`. Any step may also have `limits`, with the same fields and rules as the workflow's, which cap that one step: `"limits": { "maxTime": 120000, "maxCost": 0.5 }` lets the step run two minutes and spend fifty cents. A step's limit may be no larger than the workflow's, and a step `maxTime` needs a workflow `maxTime`, because the workflow's guard would trip first, or the subprocess would be killed, and neither failure names the step.

**A tool step** has `module`, the module the tool is imported from; `tool`, the function's name in that module; and `args`, an object of named arguments. `module` is a `std::` module name or a path to an `.agency` file relative to the directory the host passes at run time. The step's value is what the tool returned, with a `Result` unwrapped (see "Results" below).

**An LLM step** has `prompt`, the instruction; `context`, a list of values appended to the prompt; and `output`, an Agency type as text that the reply must match. The step's value is the typed reply. `model` and `provider` are optional overrides.

### References

A reference is an object with one key, `$ref`, whose value is a path:

- `inputs.<name>` is a workflow input.
- `steps.<id>` is an earlier step's value, followed by any path into it: `.field` for an object field and `[n]` for an array index.

A reference may appear anywhere a value may appear: as a whole argument, inside an array, or inside an object inside an argument. A string that happens to start with `$` is a string. Only an object of the exact shape `{ "$ref": "..." }` is a reference, so there is no escaping to get wrong.

A reference may only point at a declared input or at a step that comes earlier in the list. In the generated code a reference is a plain expression, `note.value[0].id`, so the typechecker checks that the field exists and has the right type for the parameter it is passed to. Whether an index exists at run time (an empty array) is not a type question; that fails the step at run time with a message naming the step and the path.

### What is deliberately missing

No string interpolation. If a prompt needs a value, the value goes in `context`. If an argument needs two values joined, a function joins them.

No conditionals, loops, or parallel steps. The `kind` field is where one would be added.

No step may name another workflow. A saved workflow can be offered as a tool and called by name like any tool.

## The generated program

`compileWorkflow(workflow, tools)` turns the JSON above into this source:

```ts
import { searchNotes, readNote } from "./src/agent/appleNotes.agency"
import { findLists, addListItems } from "./src/agent/lists.agency"
import { Json } from "std::validation"

type Inputs = { noteTitle: string }
type Step_meals_output = string[]

export node main(inputs: Inputs!): Result {
  return guard(time: 300000, cost: 1) {
    const step_note_query = inputs.noteTitle
    const step_note = searchNotes(query: step_note_query)
    if (step_note is failure) {
      return failure("step note (searchNotes): ${step_note.error}", { step: "note", cause: step_note })
    }
    const step_text_id = step_note.value[0].id
    const step_text = readNote(id: step_text_id)
    if (step_text is failure) {
      return failure("step text (readNote): ${step_text.error}", { step: "text", cause: step_text })
    }
    const step_list_query = "weekly meal plan"
    const step_list = findLists(query: step_list_query)
    if (step_list is failure) {
      return failure("step list (findLists): ${step_list.error}", { step: "list", cause: step_list })
    }
    const step_meals_context1 = step_text.value.body
    const step_meals_context1_text = if step_meals_context1 is string then step_meals_context1 else JSON.stringify(step_meals_context1)
    let step_meals: Step_meals_output = null as Step_meals_output
    thread {
      const step_meals_reply: Step_meals_output = llm("The note below ends with this week's meal plan, one meal per line. Return the meals as a list of strings, in order, without day names." + "\n\nContext 1 (steps.text.body):\n" + step_meals_context1_text)
      step_meals = step_meals_reply
    }
    const step_add_items = step_meals
    const step_add_listId = step_list.value[0].id
    const step_add_section = "Meals"
    const step_add = addListItems(items: step_add_items, listId: step_add_listId, section: step_add_section)
    if (step_add is failure) {
      return failure("step add (addListItems): ${step_add.error}", { step: "add", cause: step_add })
    }
    return success(step_add.value)
  }
}

export node inputsSchema(): Json {
  return schema(Inputs).toJSONSchema("input")
}
```

What to notice:

- Each step is one statement, so an interrupt inside a step pauses the program at that step and a resume continues from it. This is the ordinary Agency resume story; nothing here is new.
- The LLM step runs in its own `thread`, so its prompt does not land in any caller's conversation. The reply is a typed `const` inside the block, because only the type on an `llm()` call's own declaration gives it a structured-output schema. The step's local is a `let` declared before the block and assigned inside it, because a `thread` block's value is its message list and a `return` inside one returns from the enclosing node (found when part 2 first ran the meal plan, 2026-10-29). Its context values are bound to locals before the block, because a `Result` narrowed by an `is failure` check is not narrowed inside a `thread` block (the typechecker reports AG2009 otherwise). An earlier form of this example, with inline arguments and unprefixed names, compiled on 2026-10-27 with stubbed tools; the plan's Task 7 pins this form.
- Every step value is a local, so a later step can reference any earlier one. There is no threading of a payload from state to state, which was the first thing AWS had to add variables to fix.
- Every argument is bound to its own local before the call, one line per field, so a type error on an argument maps to that field of that step.
- Every generated name starts with `step_` (or `Step_` for a type). A step named `failure` or `llm` then produces `step_failure`, which shadows nothing. The description is not written into the source; it is set on the tool value when the workflow is offered as a tool.
- The program always ends in `return success(...)`, because `main` is typed `Result` and a plain value or an unwrapped `.value` would not typecheck without a guard.
- `inputs` is declared `Inputs!`, so `{ noteTitle: 5 }` fails before the first step (decision 17).
- A context value that is a string, like the note body, reaches the model as its text. Anything else is sent as JSON (decision 18).
- A step with `limits` gets a guard around its call, named after the step, followed by the same failure check:

  ```ts
  const step_add = guard(label: "add", time: 120000, cost: 0.5) {
    return addListItems(items: step_add_items, listId: step_add_listId, section: step_add_section)
  }
  if (step_add is failure) {
    return failure("step add (addListItems): ${step_add.error}", { step: "add", cause: step_add })
  }
  ```

  A guard passes a `Result` its block returns through unchanged, so a tool's own failure and a trip both land in the one check. It wraps any other value in `success(...)`, so a step with `limits` always holds a `Result`, and a reference into it reads `.value` even when its tool returns a plain value. A trip raises `std::guard` first, as any guard does, so the user's handlers can give the step more budget. An LLM step with `limits` declares its typed reply inside the guard, so the structured-output schema still comes from the output type.
- `inputsSchema` exists so the tool wrapper can show the model the workflow's inputs. It is the same trick `std::toolbox` uses with its `requestSchema` node.

## How the generator is built

The generator has four stages. Each is a pure TypeScript function from one data shape to the next, lives in its own file under `lib/stdlib/workflow/`, and is tested on data in and data out. `compileWorkflow` in `stdlib/workflow.agency` does the one piece of I/O, reading tool signatures, and then calls the four in order.

### 1. Parse

JSON text, or an already-parsed value, becomes a typed `Workflow` or a list of problems. This stage knows only shape: the format version, that `name` and every step id and tool name are identifiers, that every `kind` is known, that a tool step has `module`, `tool`, and `args`, that an LLM step has a non-empty `prompt`, a `context` list, and an `output`, and that every reference is an object with one `$ref` key whose path is well formed. An identifier is what the parser's own `identifierParser` accepts. The rules are a list of functions; the stage is their concatenation.

### 2. Resolve

This is the preprocessor's role. A `Workflow`, the host's tool references, and the tools' signatures become a `ResolvedWorkflow`, in which every step carries everything the lowering needs and nothing is left to look up:

- the module and name it imports, verified against the list the host passed;
- whether its tool returns a `Result`, from the `returnType` field `describe` prints;
- every reference resolved to the input or the earlier step it names, with the path into it;
- the names the step will declare, from one naming function: its value `step_<id>`, one local per argument `step_<id>_<arg>`, one per context value `step_<id>_context<n>`, and for an LLM step its output type `Step_<id>_output`. The prefix is what makes any identifier safe as a step id.

Every semantic problem is found here, naming its step and field: a tool the host did not pass, a reference to a later step or an unknown input, a partial or renamed function in the tool list, a duplicate tool name (through the tool loop's own check), and two steps whose generated names coincide (`note` with an argument `query`, next to a step `note_query`). Signatures are passed in as data. The Agency side reads them, because reading a user's file raises `std::read`: for a `std::` module it calls `describe` on a re-export line, and for a file under `dir` it reads the file and calls `describe` on the text.

### 3. Lower

A `ResolvedWorkflow` becomes a list of fragments, `{ code, owner }`, where `code` is a Template Agency `Code` value (an AST fragment) and `owner` is the step and field it belongs to. One function per step kind returns that step's fragments.

The shapes of the generated statements live in one table, keyed by name, each a line of Agency with two kinds of slot:

```
binding: "const {{local}} = #value"
call:    "const {{value}} = {{tool}}({{args}})"
check:   'if ({{value}} is failure) { return failure("step {{id}} ({{tool}}): ${{{value}}.error}", { step: #id, cause: {{value}} }) }'
llm:     "const {{value}}: {{outputType}} = thread { return llm(#prompt{{options}}) }"
```

A `{{name}}` slot takes a name. The one function that turns a shape into a fragment substitutes it only after checking the replacement is a generated name or an identifier the parser accepts, and there is no other way to build a fragment. A `#name` slot takes a value: the text is parsed with `parseStatements`, then `fill`ed, which lifts a plain value to a literal node and never parses it, and grafts a `Code` value as a tree. This is what keeps the GitHub Actions script-injection bug class out of workflows: nothing a person types into a workflow can become an identifier or a call.

So untrusted text enters the program by three doors, and the generator composes no other text from workflow content:

1. **A value** (string, number, boolean, null, array, and object arguments; the prompt; a context label) goes through a `#` slot and is lifted.
2. **A name** (a step id, tool name, argument name, input name) passed the parser's own identifier check in stage 1 and goes through a `{{ }}` slot, which checks it again.
3. **Type text** (`inputs`, each LLM step's `output`) is canonicalized through `describe`: `describe("export type Inputs = <text>")` must return exactly one export, of kind `type`, named `Inputs`, and the declaration written into the program is the signature as `describe` printed it. Text that smuggles a second declaration fails that check.

A reference becomes an expression, `inputs.noteTitle` or `step_note.value[0].id`, parsed from text made only of a generated name, `.value`, and a path the format's reference grammar accepted. It is then grafted into a `binding` fragment's `#value` slot. An LLM step's prompt is a fold of `#left + #right` fragments over the prompt text, each context label, and `JSON.stringify(step_<id>_context<n>)`.

**Hygiene.** `fill` renames a template's binder when the filler mentions that name, so a filler cannot capture it. Function and node parameters count as binders, so filling a `#steps` hole inside `node main(inputs: Inputs)` with statements that mention `inputs` renames the parameter to `__hyg1_inputs` and leaves the body's `inputs` unbound. Two decisions follow. The scaffolding (the `main` node, its optional guard, and the `inputsSchema` node) is a fixed string constant, not a template with a hole. And the naming rules in stage 2 guarantee that no fragment ever binds a name its own filler mentions, so `fill` never renames anything the generator writes.

### 4. Render and check

Each fragment is printed on its own with `toSource`, the prints are joined into the scaffold's body slot, and the line map, which step owns which lines, is derived from those same prints by counting each one's lines. No combined print is made, so there is no second print that could disagree with the first. `checkWorkflow` then runs `compile(source, dir, strict: true)` and `typecheck(source, dir:, strict: true)` from `std::agency` and maps each error to its step through the line map. The field a diagnostic belongs to comes from its structured payload (for a wrong argument name, the `name` in the diagnostic's `params`), never from its message text.

### Results

After every tool step, the generated code checks the step's value and stops the workflow on a failure, with a message that names the step and the tool and carries the tool's own failure as `cause`. The check is emitted whatever the tool's declared return type, because Agency wraps every function in a try-catch that turns a thrown error into a failure, so a tool typed `string` can still return one; `x is failure` typechecks on any value. The tool's return type, read through `describe`, decides only whether a reference into the step's value adds `.value`.

This is close to what plain Agency already does, since a failure passed to a typed parameter skips the function and comes back out. The check only adds the step name to the message.

When a user wants to say what happens on failure, that is a future step kind that lowers to a `match` with `success` and `failure` arms, and the generator skips the automatic check for that step. Nothing is built for it now.

### Typed returns matter

A reference into a step's value is typechecked only as far as the tool's return type goes. A tool that returns `Result<Note[]>` gives the typechecker everything. A tool that declares no return type, or returns `any` or `Json`, gives it nothing, and a wrong path becomes a run-time failure. `checkWorkflow` reports all three as a warning so the author knows.

## Tools and modules

The host passes the tools a workflow may call as function values, the same list it would hand to `llm(tools:)`. Every function value carries the module it was defined in and its name. The generator reads those to write the imports, and `checkWorkflow` refuses a step whose `module` and `tool` are not among the functions the host passed. So the host controls both which tools and which modules a workflow may use, with one list, and the format's `module` field is verified against real function values rather than trusted.

A partial or a renamed function has no importable name. `checkWorkflow` refuses one and says to pass the original def.

A function value's `module` is the compiler's module id, a file path such as `stdlib/shell.agency`, so the generator translates it before comparing it with the format's `module` field. `moduleIdToOrigin` in `lib/runtime/origin.ts` already maps an id to `std::shell`, `pkg::name`, or `./path`, and the generator uses it to tell a `std::` or `pkg::` tool from a local one. A local tool's path comes from its source file, the absolute path the function value records, written relative to `dir` (ADI-253). A tool whose file is outside `dir` is refused, and so is a tool with no source file. The format's `module` is therefore written exactly as the import line will spell it: `std::shell`, `pkg::name`, or `./notes.agency` relative to `dir`.

For a module that is a user file, `module` is a path relative to `dir`, the directory the host passes to `runWorkflow`. `runCode` already confines local imports to `dir` and refuses absolute paths, `..`, and symlinks. Path aliases were considered and set aside: they would let a saved workflow survive a file move, but they are a compiler feature with a config surface, and the one thing they buy here is one line to fix when a host reorganizes.

### TypeScript in the import closure

`runCode` refuses any TypeScript file in the import closure. BMO's tools import TypeScript helpers, so a workflow cannot call them today. The fix is a change to `run`, not to workflows: an `allowedImports` list of files, relative to `dir`, that the sandbox compiler accepts. A child subprocess's effective list is its own argument intersected with the inherited list, so generated code that calls `run` can narrow the list but never widen it. This is the same shape `maxDepth` already has: `resolveDepthCap` in `lib/runtime/ipc.ts` tightens a caller's value by the ancestor's, and the inherited value rides in `SubprocessRunInfo`, seeded before the child imports any code. That change is its own PR with its own dev doc. This spec assumes it does not exist and tests with `std::` tools and plain `.agency` files.

## Checking a workflow

`checkWorkflow(workflow, tools, dir)` returns every problem it can find, so the author fixes them in one pass. That includes every tool in the list that cannot be imported (a partial, a renamed function, a package tool), reported together:

- the format version, the name, and that every step id is an identifier used once;
- every `kind` is one the format knows;
- every tool step's `module` and `tool` name one of the functions the host passed;
- every reference points at a declared input or an earlier step, and its path is well formed;
- then it compiles the generated source, in the sandbox, and maps each type error back to the step and field it came from.

The last bullet is the whole of argument checking: a wrong argument name, a missing required argument, a wrong type, a bad path into a step's value, and an LLM output type that does not fit where it is used are all type errors in the generated code. The generator records which line came from which step so the message says "step `text`, argument `id`" and not a line number.

The check runs nothing and raises no interrupt beyond the reads the compile needs.

## Running a workflow

`runWorkflow(workflow, inputs, tools, dir)`:

1. Checks the workflow, as `checkWorkflow` does, and fails with the problems if there are any. The check compiles the program, and the run uses that program (decision 22).
2. Raises `std::workflow::run` with the workflow's name, `dir`, and the inputs. A policy pins "this workflow may run" here. Each tool step still raises its own effects.
3. Runs the program's `main` with `run`, passing `{ inputs: inputs }` and a wall clock of the workflow's `maxTime` plus 30 seconds, or 60 seconds with no `maxTime` (decision 21). `run` raises `std::run`.
4. Returns what `main` returned: the result's value, or the failure that stopped the workflow, which names the step.

`recommended` approves neither `std::workflow::run` nor `std::run`: each starts code, so each stays with the prompt, the way `std::toolbox::save` does.

The subprocess machinery does the rest. Interrupts from any step go up the parent's handler chain and the user's policy answers them. An interrupt no handler answers pauses the child, which checkpoints and exits, and the interrupt surfaces to the user as any interrupt does. A resume starts a fresh child from the checkpoint. The workflow's `limits` are a `guard` inside the generated code, and `runCode`'s own limits cap the process.

### Isolation

A workflow runs in its own process with its own global state. Nothing a step says lands in the caller's conversation. A step cannot read the caller's variables, name a tool the host did not pass, or pass a function value to a tool. The format has no way to write any of those.

## Offering a workflow as a tool

`workflowTool(workflow, tools, dir)` returns one function value that runs the workflow when called:

```ts
return runWorkflow
  .partial(workflow: workflow, tools: tools, dir: dir)
  .rename(workflow.name)
  .describe(workflow.description)
  .withParamSchema("inputs", inputsSchema)
```

`inputsSchema` comes from running the generated program's `inputsSchema` node once, so the model sees `noteTitle: string` and not `inputs: object`. For a saved workflow it is read from the saved file's `meta`, where `writeWorkflow` stored it (decision 24). An optional input is optional in the tool's schema, because the stored schema is zod's input form, where a key with a default is not required (ADI-254). A workflow is a program with a `main`; the tool is one function that runs it. Nothing is extracted from the source.

A checkpoint keeps a schema set with `.withParamSchema`. The function value records each schema it was given in `paramSchemas`, and the reviver writes that record and calls `.withParamSchema` again on revive (`lib/runtime/revivers/functionRefReviver.ts`, ADI-249). So after a resume the model still sees the tool's `inputs` type, and the agent's learned tools keep their `request` type too.

`workflowTools(dir, tools)` lists a directory and builds one tool per saved workflow. A host with a handful of workflows adds these to its model's tool list, so "do the meal plan thing" is one ordinary tool choice. A workflow's name must not collide with a tool already in `tools`; `workflowTool` and `workflowTools` both refuse one that does, since each has both names in hand.

## The catalog

`catalog(tools)` returns, for each tool the host passed: its module, name, description, each parameter with its type and description, and its return type. This is what a GUI's tool dropdown reads, what lets a GUI offer `note[0].id` as a wire endpoint and refuse a wire from a string to a number, and what a person reads before writing a workflow by hand. It is built from `describe` and the tool's parameter schema, the same data the tool loop sends to a model. Each parameter carries its name, its type and default as Agency text, the text of its `@param` entry, and its JSON Schema (ADI-252).

## Saving a workflow

A workflow is saved as one file in the project directory's `workflows` folder:

```
<dir>/
  notes.agency
  workflows/
    updateMealPlanFromNote.json
```

The file holds `{ "workflow": ..., "meta": ... }`. `workflow` is the format above. `meta` holds when it was saved, by what, and the inputs schema (decision 24). The file name is the workflow's own `name`, and a file whose workflow has another name is refused. `dir` is also the directory local tool modules are named relative to, so the `workflows` folder keeps a listing away from the project's other files.

`writeWorkflow(workflow, tools, dir)` runs the full check, compile and typecheck, before it writes anything, so only a workflow that compiles is saved (decision 23). `runWorkflow` checks again at run time, because a tool may change after the save.

Two effects gate the directory, following `std::toolbox`:

- `std::workflow::scan { dir }` before a directory is read.
- `std::workflow::save { dir, name, workflow }` once, before anything is written. Every workflow that enters a directory raises it, so a policy that matches it sees all of them.

`scan` and `save` carry `@alwaysUnder(dir)` so an "always" answer pins the directory. `std::workflow::run` carries `@alwaysUnder(dir)` and `@always(name)`, so a user can approve every workflow in a directory, or one by name.

A review interrupt, where a draft is shown and feedback goes back to a model, belongs to the designer and comes with it.

## Public API

```text
// std::workflow
type Workflow = { format: number; name: string; description: string;
                  inputs: string; steps: Json[]; result?: Json; limits?: WorkflowLimits }
type WorkflowProblem = { step: string | null; field: string | null; message: string }
type WorkflowEntry = { name: string; path: string; workflow: Workflow; meta: WorkflowMeta }
type CatalogParam = { name: string; type: string | null; default: string | null;
                      description: string | null; schema: Json }
type CatalogEntry = { module: string; name: string; description: string;
                      params: CatalogParam[]; returns: string | null }

type WorkflowFailure = { problems: WorkflowProblem[] }

compileWorkflow(workflow: Workflow, tools: any[], dir: string = ""): Result<string, WorkflowFailure>
checkWorkflow(workflow: Workflow, tools: any[], dir: string = ""): Result<WorkflowProblem[], WorkflowFailure>
runWorkflow(workflow: Workflow, inputs: Json, tools: any[], dir: string = ""): Result<Json>
workflowTool(workflow: Workflow, tools: any[], dir: string = ""): Result<any>
workflowTools(dir: string, tools: any[]): Result<any[]>
catalog(tools: any[], dir: string = ""): Result<CatalogEntry[]>
loadWorkflow(name: string, dir: string): Result<WorkflowEntry>
listWorkflows(dir: string): Result<WorkflowEntry[]>
writeWorkflow(workflow: Workflow, tools: any[], dir: string): Result<WorkflowEntry>
```

`checkWorkflow` succeeds with the warnings, such as a tool that declares no return type. `runWorkflow` fails with the check's problems, with the failure of the step that stopped the workflow (its `data` names the step and carries the tool's failure as `cause`), or with a `run` limit failure.

`compileWorkflow` returns Agency source as text, not a `CompiledProgram`. Its docstring says so in the first line, since `std::agency` has a `compile` that returns a program handle.

Effects:

```text
effect std::workflow::scan { dir }
effect std::workflow::run  { name, dir, inputs }
effect std::workflow::save { dir, name, workflow }
```

## The MVP

The smallest version that proves the idea:

- The format, with tool steps, LLM steps, references, `inputs`, `result`, and `limits`.
- `compileWorkflow`, `checkWorkflow`, `runWorkflow`, `workflowTool`, `workflowTools`, `catalog`.
- Save, load, and list, with the two gates.

Cut from the MVP: writing a workflow from a log, the designer agent, the review interrupt, a use count in `meta`, tool schema hashes, and saving the generated source beside the JSON.

Tests:

- An Agency execution test: a workflow over two `std::` functions with no model call, run through `runWorkflow`, with the result checked. CI runs this with no LLM.
- The meal plan shape, with the notes and lists tools stubbed by small `.agency` files under `dir`, run with a policy that rejects `addListItems`. The workflow fails at step `add`, nothing after it runs, and the failure names the step.
- A workflow with a bad reference (`steps.note[0].title` where the note type has no `title`), checked, and the problem names step `text` and argument `id`.
- A workflow naming a tool the host did not pass, refused by `checkWorkflow`.
- A paused workflow, resumed, that finishes. This is the subprocess resume test with a workflow as the program.
- The generator is deterministic: compile the same workflow twice and compare the source.

## The parts

The MVP ships in three parts, each its own PR. Each part needs some small language or runtime fixes first, and each fix is its own PR.

1. **Part 1, the generator** (#1292, merged): the format, parse, resolve, lower, render, `compileWorkflow`, and `checkWorkflow`.
2. **Part 2, running**: `runWorkflow` and `std::workflow::run`, `Inputs!`, context strings as text, step limits, every bad tool reported at once, positive limits, and the warning for a `Json` return. Before it: #1297 (nodes check `!`) and the type checker fix for a guard around a `Result` (decision 20).
3. **Part 3, saving and offering**: `writeWorkflow`, `loadWorkflow`, `listWorkflows`, the `scan` and `save` effects, the inputs schema in `meta`, `workflowTool`, `workflowTools`, and `catalog`. Before it: the reviver fix for `.withParamSchema`.

Two more changes are needed before BMO can run a workflow against its real tools, and neither is part of a workflow PR: the config a child inherits (decision 25), and `allowedImports` for TypeScript files in the import closure.

## The end goal

This connects to BMO. BMO runs on an iPad on a fridge, and the owner pictures a drag-and-drop builder there: each block is a tool call or an LLM call, a dropdown picks the tool, fields take the inputs, and wires connect a block's output to a later block's input. That GUI is BMO's job, but the format is shaped for it: a block is a step, a wire is a `$ref`, the dropdown reads `catalog`, and the fields are `args`. Steps stay flat records with no expressions in them because a GUI can draw a `$ref` and cannot draw a string with code in it.

Before BMO can run a workflow against its real tools, the `allowedImports` change to `run` has to land, because BMO's tools import TypeScript. That is the follow-up.

## Calls I made

Marked so the owner can check them while reading:

- References are `{ "$ref": path }` objects, not `$`-prefixed strings, so a literal string can never be mistaken for one.
- `inputs` and an LLM step's `output` are Agency type text, not JSON Schema, because they become types in the generated program and the typechecker checks them.
- A tool step's `Result` is unwrapped and a failure stops the workflow with a message naming the step. The generator decides whether to emit the check from the tool's return type.
- An LLM step gets its values through `context`, appended to the prompt as labelled blocks (a string as its text, anything else as JSON), and runs in its own `thread`.
- `runWorkflow` checks the workflow, then raises `std::workflow::run` before the subprocess starts, in addition to each step's own effects.
- The generator is Template Agency fragments, not string building, so a filler is never parsed as code.
- `workflowTool` is a partial of `runWorkflow` with the inputs schema attached. Nothing is learned or extracted from the source.
- Adding a step kind bumps `format`.
- A tool list with a repeated name, a partial, or a renamed function is refused.
- The generator records a line-to-step map so type errors are reported by step and field.

## Questions the owner answered

1. Both gates stay: `std::workflow::run` carries the name a policy pins, and `std::run` follows it (decision 16).
2. A string context value is sent as its text, anything else as JSON (decision 18).

## Left to the builder

- The exact fragment templates and the line-to-step map.
- The `meta` field names, `savedAt` and `savedBy`.
- The problem messages' wording, as long as each names the step and the field.
