import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  idiomJudge({
    name: "handler-uses-match",
    standard: `Four things, each worth a quarter. (1) The handler decides the interrupt
with ONE match expression on the effect name (\`match(data.effect) { "std::read"
=> approve() ... }\`), not a chain of if statements comparing data.effect. (2) The
conditional write is a guard arm that reads the directory from the interrupt's
data field (\`"std::write" if (data.data.dir == ".") => approve()\` when the
handler parameter is named data), not an if inside the arm. (3) Every reject is
\`reject()\` with no message argument (\`return reject()\` is fine). (4) The Result
that foo returns is unwrapped with a match on \`success(v)\` / \`failure(e)\`, not
with \`is success\` checks.
Code that is not valid Agency scores 0 whatever else it does. Not valid means
the parser would refuse it: a handler is written \`with (data) { ... }\` and match
arms use \`=>\`, exactly as in the reference; forms like \`on std::read(data) { ... }\`
do not exist. An if where a match belongs is an idiom miss that loses its
quarter, not invalid syntax.`, not with \`is success\`
checks. Full marks need all four; an if-chain on the effect name scores 0.
Code that is not valid Agency scores 0 whatever else it does. Not valid means
the parser would refuse it: a handler is
written \`with (data) { ... }\` and match arms use \`=>\`, exactly as in the
reference; forms like \`on std::read(data) { ... }\` do not exist.`,
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
