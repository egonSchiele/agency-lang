import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  idiomJudge({
    name: "handler-uses-match",
    standard: `The handler decides the interrupt with ONE match expression on the
effect name (\`match(data.effect) { "std::read" => approve() ... }\`), not a
chain of if statements comparing data.effect. The conditional write is a guard
arm (\`"std::write" if (data.data.dir == ".") => approve()\`), not an if inside
the arm. Every reject is a bare \`reject()\`. The Result that foo returns is
unwrapped with a match on \`success(v)\` / \`failure(e)\`, not with \`is success\`
checks. Full marks need all four; an if-chain on the effect name scores 0.
Code that is not valid Agency scores 0 whatever else it does: a handler is
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
