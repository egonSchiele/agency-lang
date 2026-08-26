import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  idiomJudge({
    name: "handler-uses-match",
    standard: `
    Here's an example of handler syntax:

    handle {
      foo()
    } with (data) {
      return match (data.effect) {
        "std::read" => approve()
        "std::write" if (data.data.dir == ".") => approve()
        _ => reject()
      }
    }

    The handler receives a parameter named \`data\`. \`data\` has an \`effect\` field
    for the effect name and a \`data\` field for the interrupt's additional data.
    Note that you can set guards on match arms. See the \`"std::write"\` arm for an
    example.

    And here's how to unwrap a Result:

    match (result) {
      success(v) => "approved"
      failure(e) => "rejected"
    }

    Make sure that:
    1. the handler uses one match on \`data.effect\` to decide, not a chain of if statements.
    2. the write decision is a guard on the match arm, as shown above, not an if inside the arm.
    3. every reject is a plain \`reject()\` with no message.
    4. the Result from foo is unwrapped with a match, not with \`is success\` checks.

    All four of these points count equally towards the final score.`,
    reference: `import { foo } from "./foo.agency"

export def callFoo(effect: string, dir: string = "."): string {
  let outcome = ""
  handle {
    const result = foo(effect, dir)
    outcome = match(result) {
      success(v) => "approved"
      failure(e) => "rejected"
    }
  } with (data) {
    return match(data.effect) {
      "std::read" => approve()
      "std::write" if (data.data.dir == ".") => approve()
      _ => reject()
    }
  }
  return outcome
}`,
  }),
];
