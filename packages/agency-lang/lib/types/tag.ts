import { BaseNode } from "./base.js";
import type { Expression } from "../types.js";
import type { ListTrivia, NamedArgument } from "./dataStructures.js";

/** The tag names the compiler itself reads. Any other `@name` above a def
 *  is a decorator: a call to the user's function `name` with the def's body
 *  as the block argument (docs/dev/language/decorators.md). A reserved name
 *  keeps the static argument grammar; a decorator takes the ordinary call
 *  argument list, named arguments included. */
export const RESERVED_TAG_NAMES = [
  "capabilities",
  "validate",
  "jsonSchema",
  "hidden",
  "always",
  "alwaysUnder",
  "optimize",
] as const;

export type Tag = BaseNode & {
  type: "tag";
  name: string;
  /** Named arguments appear only on a decorator tag; the reserved tags
   *  keep the positional, static-only grammar. */
  arguments: (Expression | NamedArgument)[];
  /** Comments between arguments, in the order the tag prints. Only a
   *  decorator tag carries them. */
  argumentTrivia?: ListTrivia[];
  /** Whether the tag was written with parentheses. `@capabilities()` and
   *  `@capabilities` mean the same thing; the formatter keeps the spelling. */
  parentheses?: boolean;
};

export function isReservedTagName(name: string): boolean {
  return (RESERVED_TAG_NAMES as readonly string[]).includes(name);
}

/** A tag the compiler does not read itself, so it names a decorator. */
export function isDecoratorTag(tag: Tag): boolean {
  return !isReservedTagName(tag.name);
}

/** The positional arguments of a tag. Every reserved tag is positional, so
 *  its readers go through this and never see a decorator's named argument. */
export function positionalTagArguments(tag: Tag): Expression[] {
  return tag.arguments.filter(
    (argument): argument is Expression => argument.type !== "namedArgument",
  );
}
