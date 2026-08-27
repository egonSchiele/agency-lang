## How the optimizer reads a reply

Every `${...}` in a reply is an interpolation. Not a suggestion, not a convention: a rule. Get this wrong and every candidate is rejected.

The model sees the target as plain text, and the target sees the model as plain text. Put differently: there is no escaping in either direction. Discovery stores two things for a text target: the text, and the list of interpolations. The list comes from the real parse of the real literal; it is never re-derived from text, and that is the whole point.

A reply is checked in two steps. First the text is parsed; then its interpolations are compared with the stored list. Same placeholders, same count, none added. And no more.
