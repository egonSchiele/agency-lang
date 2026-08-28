// Every judge prompt the writing-rewrite graders use. Each is a
// { standard, context } pair for the bundled rubric judge: the standard is
// what the rewrite must meet, the context is what the judge needs to check
// it. The work the judge sees is always the rewritten text.

type Rubric = { standard: string; context: string };

const original = (sourceFileText: string) => `The original text:\n\n${sourceFileText}`;

export const flawFixed = (p: { point: string; notes: string }): Rubric => ({
  standard:
    "The work is a rewrite of the original text. An editor made this point about the original. Does the rewrite fix it? The fix may differ from what the editor suggested, as long as the problem the editor named is gone. If the editor said a passage should go, it must be absent from the rewrite; a reworded version of it does not count. Score 1 when the problem is gone, 0 when the rewrite still has it, and in between when it is partly fixed.",
  context: `The editor's point:\n\n${p.point}\n\nThe editor's full notes, for context:\n\n${p.notes}`,
});

export const matchesCuts = (p: { sourceFileText: string; cleaned: string }): Rubric => ({
  standard:
    "The work is a rewrite of the original text. You also have an editor's version of the same text. Compare the original with the editor's version and list what the editor removed: sentences, details, or whole sections that are absent from the editor's version. (If the editor's version is empty, the editor removed everything.) A clause the editor reworded while keeping its fact was not removed. Then check the rewrite: is each removed item absent from it too? Score in proportion to how much of what the editor removed the rewrite also leaves out. If the editor removed nothing, score 1 when the rewrite keeps every fact of the original, and lower the score in proportion to the facts it drops.",
  context: `${original(p.sourceFileText)}\n\nThe editor's version:\n\n${p.cleaned}`,
});

export const faithful = (p: { sourceFileText: string; assignment: string }): Rubric => ({
  standard:
    "The work is a rewrite of the original text. Does it keep the facts the same as the original, or does it invent facts? A rewrite may cut or simplify freely, and it may use facts from the assignment the text was written for, but it must never add a claim or detail that neither the original nor the assignment contains. Every identifier (a code name, a path, a symbol like `std::notes::create`) must appear in the rewrite exactly as the original has it, unless the rewrite cut the sentence it was in. Lower the score in proportion to the number of invented details and altered identifiers.",
  context: `${original(p.sourceFileText)}\n\nThe assignment the text was written for:\n\n${p.assignment}`,
});

export const leavesCleanAlone = (p: { sourceFileText: string }): Rubric => ({
  standard:
    "The work is a rewrite of the original text. The original was already clear, so the best rewrite is the original unchanged or nearly so. Score 1 when the rewrite is the same text or differs only in a word or two. Lower the score in proportion to how much the rewrite changed: restructured sentences, dropped facts, added material, or a different tone.",
  context: original(p.sourceFileText),
});
