Read through any docs you added to docs/dev/, as well as all the comments you have added across all files in this PR, and consider whether this is useful information for future readers to know, or whether these are just your implementation notes and thought process. If it is the latter, then they do not belong in this PR.

## Docstrings vs doc comments

For any docstrings you have added: The docstring is sent as the tool description for the LLM. Ask yourself what part of this belongs in the docstring versus what part of it belongs in a doc comment. A dark comment is written at the top, is written directly about the function declaration and contains information that would be useful for the developer to know as opposed to the LLM. Here is a simple example. This is a function that scans the subdirectories in a directory looking for skills files.

Bad example – docstring is long and contains a lot of unnecessary info

```
export def scanSkillsSubdirs(
  root: string,
  subdirs: string[],
): Record<string, SkillEntry[]> {
  """
  Scan named subdirectories of a root, each holding one agent's
  flat-layout skills. Raises one `std::skills::skillsDir` interrupt for
  the root; its approval covers the reads. Each subdirectory gets its
  own MAX_SKILL_FILES scan; one with no markdown files (or that does not
  exist) yields no entry. Taking the names as a parameter keeps the
  record's keys caller-chosen data, never something read off the disk.

  @param root - The directory holding the subdirectories
  @param subdirs - The subdirectory names to scan
  """
```

Good – Extra info is moved to a doc comment instead. Note that the information about what interrupt gets raised is no longer in a comment. The function itself has a `raises` clause on it instead. Also note that the doc comment now explains what this function is for instead of giving redundant detail about implementation

```
/**
This function is meant to be used when you have multiple subagents and each subagent has your own skills directory. You can use this function to read the skills files, and group them under different agent names.
*/
export def scanSkillsSubdirs(
  root: string,
  subdirs: string[],
): Record<string, SkillEntry[]> raises <std::skills::skillsDir> {
  """
  Scan named subdirectories of a root. Each subdirectory holds agent skills.

  @param root - The directory holding the subdirectories
  @param subdirs - The subdirectory names to scan
  """
```
