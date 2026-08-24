---
name: "Code templates and holes"
---

# Code templates and holes

<a id="ag8001"></a>

## AG8001 — This file is a template with unfilled holes (&#123;names&#125;) and cannot be run directly. Load it with `loadTemplate` and fill it first.

*Default severity: error.*

This file contains template holes (`#name`), which mark gaps for code or values to be filled in later. A file with unfilled holes is a template, not a program, so it cannot be compiled or run directly.

**How to fix:** load the file with `loadTemplate`, fill every hole with `fill`, and run the completed program (for example with `runCode(toSource(filled))`). Use `holesOf` to list what still needs filling.

<a id="ag8002"></a>

## AG8002 — The hole `#&#123;name&#125;` is in a position that gives it no expected type. Annotate it, for example `#&#123;name&#125;: string`.

*Default severity: error.*

An expression hole normally takes its type from its position — in `const x: string = #text`, the hole is a string. This hole sits in a position that supplies no type, so nothing constrains what may fill it.

**How to fix:** annotate the hole inline:

```agency
node main() {
  const x = #mystery: string
  return x
}
```

<a id="ag8003"></a>

## AG8003 — Generator '&#123;name&#125;' may raise &#123;effects&#125;, so it cannot run at compile time. Compilation installs no interrupt handlers, so those operations could not complete anyway. Move the effectful work out of the generator.

*Default severity: error.*

A generator can reach an operation that asks for permission.

Compilation installs no interrupt handlers, so an operation that stops to ask a question can never finish while a generator runs. Catching it before the generator starts means you get told which effect, and where, instead of a failure part-way through.

The effect does not have to be in the generator itself. It counts if the generator can reach it by calling, however many files away that is.

**How to fix:** move the effectful work out of the generator. Read the file at runtime and pass the contents in as a splice argument, or generate code that does the reading when the program runs rather than when it compiles.

<a id="ag8004"></a>

## AG8004 — Generator '&#123;name&#125;' cannot be checked for effects: &#123;reason&#125;. An empty effect list from an incomplete reading means nothing, so it is refused rather than run.

*Default severity: error.*

A generator could not be checked for effects, so it was refused rather than run.

Working out what a generator can reach means reading source code. Four things cannot be read that way: a file that does not parse, a compile-time splice that has not expanded yet, a function received as a parameter and then called, and a function reference stored in a variable before being passed on.

An empty effect list from a reading that could not see one of those is not evidence of safety, so it fails closed. The message names which one it hit and where.

**How to fix:** fix the file that does not parse, or rewrite the reached function so the call is direct rather than through a parameter or a variable. If the generator does not need that helper at all, stop calling it — the check follows calls, so an unused helper in the same file is not a problem.

<a id="ag8005"></a>

## AG8005 — `&#123;name&#125;` must be imported from another file to be used in a splice. A generator cannot be defined in the file that splices it, because it has to be compiled first.

*Default severity: error.*

A splice called a function that is not imported from another file.

The generator has to be compiled before the file that splices it can be compiled, so it cannot live in that same file — there would be no order that works. This is the same restriction Template Haskell calls the stage restriction.

**How to fix:** move the generator into its own `.agency` file and import it.

<a id="ag8006"></a>

## AG8006 — The generator `&#123;name&#125;` reaches non-Agency code through `&#123;importPath&#125;`. Compile-time generators may import only `std::` modules and relative `.agency` files, because JavaScript raises no interrupts and cannot be checked. Set `allowNonAgencyGenerators` in your config to permit it.

*Default severity: error.*

A compile-time generator, or something it imports, reaches code that is not Agency.

Splices are safe to run during compilation because dangerous operations in Agency ask permission first, and compilation has nobody to ask, so they cannot complete. That reasoning covers Agency code only. JavaScript and TypeScript ask nothing, so a generator that can reach an npm package can do anything at all, with nothing to stop it.

The rule covers everything a generator can reach, not just what it imports directly. A local `.agency` file that looks harmless can import an npm package one step further down.

**How to fix:** move the work into Agency, or set `allowNonAgencyGenerators: true` in your config if the generator genuinely needs a JavaScript library. Turning it off means the generator can do whatever that library can.

<a id="ag8007"></a>

## AG8007 — The generator `&#123;name&#125;` returned a `&#123;actual&#125;` fragment, but this splice is in &#123;position&#125; position and needs a `&#123;expected&#125;` fragment.

*Default severity: error.*

A generator returned a piece of code that does not fit where the splice sits.

A splice at the top level of a file needs whole declarations — functions, nodes, types. A splice in expression position needs a single expression. Returning a whole program where a value belongs, or the reverse, cannot be pasted in.

**How to fix:** check what the generator builds. A code literal holding a `def` is a program fragment; one holding a bare value is an expression fragment.

<a id="ag8008"></a>

## AG8008 — The generator `&#123;name&#125;` failed while running: &#123;reason&#125;

*Default severity: error.*

The generator itself failed while running: it threw, exceeded its time limit, or ran out of memory.

Generators run in a separate process with a wall-clock and a memory cap, so a runaway generator becomes a compile error rather than a hung compiler.

**How to fix:** read the reported reason. A timeout usually means an unbounded loop; a thrown error is an ordinary bug in the generator, which you can test directly by calling it from a normal program.

<a id="ag8009"></a>

## AG8009 — A generator module cannot itself contain a splice. Move the inner generation into a separate module.

*Default severity: error.*

A generator module contains a splice of its own.

Expanding it would mean compiling a generator in order to compile a generator, with no obvious place for that to stop.

**How to fix:** move the inner generation into a third module that neither of the other two splices.

<a id="ag8010"></a>

## AG8010 — Generated code refers to `&#123;name&#125;`, which it neither declares nor imports. Generated code may use only names it declares itself and names it imports.

*Default severity: error.*

Generated code refers to a name it did not declare and did not import — most likely a variable that happens to exist where the splice was written.

Pasting code into a file puts it next to whatever names are already there, so a generated reference to `tmp` would silently pick up a local `tmp` at the splice site. Refusing is the only way to keep a generator from depending on the accident of what its caller named things.

**How to fix:** have the generator declare or import everything it uses, or pass the value in as a splice argument.

<a id="ag8011"></a>

## AG8011 — The splice argument `&#123;name&#125;` is declared in this file, so it does not exist yet when the generator runs. Splice arguments may be literals, code literals, or imported names.

*Default severity: error.*

A splice passed an argument that is declared in the file being compiled.

The generator runs while that file is still being compiled, so nothing declared in it exists yet. Only values that already exist can be passed in.

**How to fix:** use a literal, a code literal, or a name imported from another module.

<a id="ag8012"></a>

## AG8012 — The generator `&#123;name&#125;` declares `&#123;declared&#125;`, which this file already declares. Generated declarations may not replace existing ones.

*Default severity: error.*

A splice generated a declaration whose name the file already uses.

Agency does not catch this on its own. Two functions with the same name is a hard error. Two top-level constants with the same name is not, and the later one silently wins. A generator that picked the name of one of your constants would quietly replace it, and nothing would say so.

The same rule covers two splices in one file generating the same name.

**How to fix:** rename one of them. If the generator picks names from data you pass in, prefix them so they cannot collide with hand-written ones.

<a id="ag8013"></a>

## AG8013 — The generator `&#123;name&#125;` produced an exported declaration (`&#123;declared&#125;`). Generated declarations cannot be exported yet, because other files resolve imports without running generators. Remove the `export`.

*Default severity: error.*

A splice generated a declaration marked `export`, and generated declarations cannot be exported yet.

Other files find out what a module exports by reading its source, not by compiling it. For a generated declaration to be importable, every file that resolved an import would have to run the generator that produced it — including `agency doc`, `agency pack`, and your editor. That is a much bigger promise than compiling one file, so for now generated declarations are visible only inside the file that spliced them.

**How to fix:** drop the `export` from the generated declaration. If the name needs to be shared, write a hand-authored wrapper that calls it and export that.

Lifting this restriction is tracked as issue #687.

<a id="ag8014"></a>

## AG8014 — The generator `&#123;name&#125;` returned &#123;kind&#125;, which cannot sit at the top level of a file. Top-level code runs at initialization, which cannot branch, loop, or wait.

*Default severity: error.*

A splice at the top level of a file adds the generator's output to the file, so that output is held to the same rule as anything you write there yourself: top-level code runs at initialization and cannot branch, loop, or wait.

**How to fix:** have the generator return declarations (`node`, `def`, `type`), bindings, or plain calls. If it needs to branch, put the branching inside a `def` it declares, or splice it inside a node body instead.

<a id="ag8015"></a>

## AG8015 — `&#123;name&#125;` is not defined in this template. A template can only use names it declares or imports itself, because a hole hides whatever fills it. Move the code that defines `&#123;name&#125;` into this template, or move the code that uses it into the fragment that defines it.

*Default severity: error.*

A template is checked before anything fills it, so a hole is opaque: the checker cannot see what will arrive there, and neither can the code around it.

This also covers names from the file the template is written in. A template becomes its own program — `toSource` prints it and `runCode` compiles the print — and the surrounding file is not there when that happens.

**How to fix:** keep each fragment self-contained. Move the code that defines the name into the template, or move the code that uses it into the fragment that defines it. A template may always use the prelude, language builtins, and anything it declares or imports itself.

<a id="ag8016"></a>

## AG8016 — `&#123;file&#125;` contains a splice that would run the generator `&#123;name&#125;` at compile time, and generator execution was declined. Compile again without `--refuse-splices` (or with `refuseSplices` off) to allow it.

*Default severity: error.*

This file contains a splice, and generator execution was declined for this compile.

Compiling a `$( ... )` runs its generator right then, during compilation. So compiling a file you have not read means running code you have not read. That is bounded — a generator may import only `std::` modules and other `.agency` files, and compilation installs no interrupt handlers, so anything dangerous cannot finish — but it is still execution, and you may prefer to decline it. Inspecting a repository you just cloned is the usual reason.

Nothing ran: the refusal happens before the generator is resolved, so its file was never opened.

**How to fix:** compile again without `--refuse-splices`, or with `refuseSplices` off in your config, once you are satisfied the generator is one you want to run. Note that sandboxed compilation refuses splices unconditionally and this setting has no bearing on it.
