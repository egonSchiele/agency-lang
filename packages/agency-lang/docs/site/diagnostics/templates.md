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

## AG8003 — The generator `&#123;name&#125;` raises &#123;effects&#125; and cannot run at compile time. Compile-time generators must be effect-free.

*Default severity: error.*

A compile-time generator ran, or would have run, code that raises an interrupt effect — reading a file, writing one, hitting the network.

Compilation refuses to run effectful code. Unlike a normal program run, no handlers are installed while compiling, so there is nothing to approve or reject an effect against, and a build that quietly touched the filesystem would be a surprise.

**How to fix:** move the effectful work out of the generator. If it needs data from a file, read the file at run time instead, or pass the data in as a plain argument to the splice.

<a id="ag8005"></a>

## AG8005 — `&#123;name&#125;` must be imported from another file to be used in a splice. A generator cannot be defined in the file that splices it, because it has to be compiled first.

*Default severity: error.*

A splice called a function that is not imported from another file.

The generator has to be compiled before the file that splices it can be compiled, so it cannot live in that same file — there would be no order that works. This is the same restriction Template Haskell calls the stage restriction.

**How to fix:** move the generator into its own `.agency` file and import it.

<a id="ag8006"></a>

## AG8006 — The generator `&#123;name&#125;` reaches non-Agency code through `&#123;importPath&#125;`. Compile-time generators may import only `std::` modules and relative `.agency` files, because JavaScript and TypeScript raise no effects and cannot be checked.

*Default severity: error.*

A compile-time generator can reach JavaScript or TypeScript, either by importing it directly or through another Agency file that does.

The whole safety argument for running generators at compile time is that dangerous operations in Agency raise effects, and effects can be checked before anything runs. JavaScript raises no effects, so nothing can be checked about it. A generator that can reach JavaScript can do anything.

**How to fix:** a generator and everything it imports, however indirectly, may use only `std::` modules and relative `.agency` files. `pkg::` imports are not allowed in a generator either, since a package can itself reach JavaScript.

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
