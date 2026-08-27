## How the optimizer reads a reply

Every `${...}` in a reply is an interpolation. There is no escaping in either direction.

Discovery stores two things for a text target: the text, and the list of interpolations from parsing the literal in the source file. The list is never re-derived from text.

A reply is checked in two steps. The text is parsed, and its interpolations are compared with the stored list: the same placeholders, the same number of times, none added.
