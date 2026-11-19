# Session journals

One file per session lives here. No session writes to another session's file,
so two agents can never overwrite each other and no lock is needed.

With active Claude/Codex hooks, SessionStart creates the journal and prints its
name. Use its basename without `.md` as the lock and evidence owner. Without
active hooks, choose one session id for both. Keep an existing journal if hooks
are configured midway through the session.

This README is not a journal. Every other `.md` in this directory is one.

Each entry needs all five labels, or the Stop hook will not count it:

```markdown
## YYYY-MM-DD - short title

Agent:

Action:

Result:

Next step:

Open:
```

Before handing off, let the tooling attach the sixth, optional field instead of
typing a claim:

```
node .ai/bin/protocol-handoff.cjs record --owner <your-session-id>
```

Never edit an entry after `record`; add a new one.

## What the tools read in an entry

The format is a closed list, not a promise to read every Markdown or HTML construct:

- A fenced code block (` ``` ` or `~~~`), an indented code block and an HTML comment
  (`<!-- ... -->`) are quotes. A heading, a label, an `Evidence:` block or an
  `- entry:` line inside them is text of the entry.
- Everything else at column 0 is structure, including lines inside `<pre>`,
  `<details>`, a table or any other construct. To show an example of an entry line,
  put it in a fence or indent it four spaces.
- A label written twice is one value: it runs to the next label of another name.

Every tool that writes a journal or `.ai/ARCHIVE.md` computes the result in memory,
checks it, and writes once. When the check fails it refuses by name, with line
numbers, and the file stays byte for byte as it was:

- `ENTRY_AMBIGUOUS`: the write would change text outside the Evidence block of the
  newest entry, replace a block that is not the entry's recorded block, move a section
  heading, or leave the newest entry with other than one `- entry:` line; or the block
  states a receipt field twice. Readers (`verify`, the validator, the report gate)
  report such an entry in the state `ambiguous` and never pick one reading.
- `ENTRY_INCOMPLETE`: the newest entry lacks one of the five labels.
- `ENTRY_SECRET`: the entry holds a credential-shaped value; redact it first.
- `ENTRY_CHAIN_BROKEN`: the hash chain of the result would not verify.
- `ENTRY_STALE`: the journal (or `.ai/ARCHIVE.md`) changed while the tool worked;
  nothing more was written; run the command again.

A carriage return is refused as `ENTRY_AMBIGUOUS`: save the journal as UTF-8 with LF
line ends and run the command again.

Every kernel writer of a journal (journal add, record, rehash, the archive move, the
stop writer, the seat journal commit) holds one lock of that journal, the file
`.<journal name>.add.lock` beside it, for its whole read, check and write. A second
writer is refused while it is held (`journal writer is busy or lock needs
investigation`); a lock left by a dead process on this host is cleared, any other is
never cleared. Lock order: the journal lock, then the shared-document lock. Against
a writer that takes no lock (an editor, an older tool) each writer compares the file
with what it read right before the replace; that leaves only the instant between the
last read and the replace open.

When this directory passes thirty files, move the oldest closed journals whole
into `.ai/ARCHIVE.md`. Moving entries out of a journal does not reduce the file
count; moving the file does. See section 8 of `AGENTS.md`.
