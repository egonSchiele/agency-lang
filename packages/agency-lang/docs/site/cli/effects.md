---
title: Effects
description: Documents the `agency effects` command, which lists the built-in capability sets and policies that the --approve, --reject, and --policy flags accept.
---

# Effects

```
agency effects
```

Lists the names you can pass to the approval flags: the built-in
capability sets for [`--approve` and `--reject`](/cli/policy#approving-and-rejecting-with-flags),
and the built-in policies for `--policy`.

```
Effect sets:
  FileRead     Read-only filesystem access: reading files and listing/searching paths.
  FileWrite    Filesystem mutation: creating, editing, moving, copying, and deleting.
  FileSystem   All filesystem access — reads and writes.
  Shell        Arbitrary command / process execution.
  ...

Built-in policies:
  minimal      ...
  recommended  ...
  with-writes  recommended + auto-approve file writes and git changes, scoped to the current directory and its children.
  approve-all  ...

Use a set or an effect name with --approve / --reject, a policy with --policy:
  agency agent --policy with-writes --reject Shell
```

A capability set is a named group of related interrupt effects, declared
in [`std::capabilities`](/stdlib/capabilities). Passing a set name to
`--approve` or `--reject` is shorthand for naming every effect in the
set.

## Describing one name

Pass a name to see it in full.

A **set name** shows the set's documentation, what it is composed of,
and the effects a flag would actually grant:

```
$ agency effects FileSystem
FileSystem

All filesystem access — reads and writes.

FileSystem = FileRead + FileWrite

Member effects:
  std::read
  std::readBinary
  ...
```

An **effect name** (it contains `::`) answers the reverse question —
which sets would grant it:

```
$ agency effects std::write
Sets that include std::write:
  FileWrite
  FileSystem
```

A **built-in policy name** shows the policy's description and its full
rule set as JSON, resolved against your current directory — so
dir-scoped rules show the real paths they would match if you launched
with that policy here:

```
agency effects with-writes
```

An unknown name is an error, with a suggestion when it looks like a
typo of a real one.
