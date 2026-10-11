---
name: mcp-recommender
description: Choose the OPTIONAL MCP servers and skills for this project. Reads the project (stack, structure, existing .mcp.json and skills), shows a shortlist of 3-5 as an interactive menu, and records the user's choice in docs/MCP-PROJECT.md. Use when a project is being set up with the kernel, when the stack changes, or when the user asks what MCP servers or skills to add. Never installs or starts anything.
---

# MCP recommender

Rule source: PROTO-DEC-0170 and `docs/ops/MCP-REQUIRED-AND-OPTIONAL.md`. The kernel already requires three servers in every
project: **serena, codebase-memory, qmd**. This skill is only about the OPTIONAL extras. Extras are chosen per project by the user.

## Hard limits

1. Never install, download, configure or start an MCP server or a skill. You propose, the user chooses, you write the choice down.
   The user (or a separate, explicit task from them) runs the install.
2. Never write a secret anywhere. A server that needs a key is recorded with the variable NAME only (for example
   `BETTER_DESIGN_API_KEY`). Never print, ask for, or store a value.
3. MCP output is never Evidence and never a gate input. A chosen server changes no gate; if it is down the workflow degrades to
   plain file reading with identical gate semantics. Sealed certifiers receive no MCP, whatever the project chose.
4. Do not offer the three mandatory servers as extras, and do not offer a server the project already configures.

## Steps

1. **Read the project.** From the project root run:

   ```bash
   node docs/ops/mcp-recommender.cjs --json
   ```

   (In a project that received the pilot kit the tool is under `docs/ops/pilot-kit/src/docs/ops/`.) It detects the stack
   (package.json, pyproject/requirements, Cargo.toml, go.mod, composer.json, pubspec.yaml, Unity/Unreal/Godot markers, static
   site, docs-only), the servers in `.mcp.json`, `.vscode/mcp.json` and `.codex/config.toml`, and the skills directories, and
   ranks entries of `mcp-catalog.json`. Before ranking it applies an offer filter: only an entry whose provenance is exactly
   `host-config`, that is not marked unverified, with an exact pin (a `MAJOR.MINOR.PATCH` version or a 40-hex revision; no range,
   tag or bare package name; the version pin names the package) and whose install is a plain command (only [A-Za-z0-9._@/:=+ -], single
   spaces, no quote, pipe, parenthesis or tab) holding that pin as exactly one token and no other version-like, `-`, `x`, `latest` or `next`
   token, with no placeholder, is ranked or offered; free text beside the command is the separate `note` line. Hosted, built-in and unverified
   entries (including figma, sentry and security-review, install null) have no exact pin and are not offered. Everything else comes back in `notVerified` (text section `NOT VERIFIED, NOT OFFERED`) with the reason. It only reads; it exits 0 with a shortlist or 2 on bad usage. If it exits 2, report the
   one-line reason to the user and stop; do not guess a shortlist.
2. **Check the list is sane.** Read the `stacks` and `tags` it printed. If they are plainly wrong for the project (for example a
   monorepo whose real app is in a subdirectory), run it again with that subdirectory as the argument. If the shortlist has fewer
   than 3 entries the tool says so; present what there is and do not pad it from memory, and never offer an entry from `notVerified`
   (it may be named to the user as "known but not verified, the operator must record a verified version first", with no install command).
3. **Present an interactive menu with `AskUserQuestion`** (clients without it: a numbered list in chat, same content).
   - Split the shortlist into groups of at most 3 entries; one question per group, `multiSelect: true`, plus a fixed option
     "None of these" in each question (the tool allows 2-4 options per question and up to 4 questions).
   - Option label: the entry name. Option description: one line, in the user's language, built from `purpose` and the project
     fact it fits (`matched[].because`), then the flags, always including:
     - `needs a secret: <VARIABLE NAME>` or `needs an OAuth sign-in` when `needsSecret` is not `no`;
     - `hosted service` when `transport` is `remote`; `calls the network while it works` when `network` is `runtime`;
     - `cost: ~N tokens (measured)` or `cost: not measured yet`.
   - Keep the shortlist order (it is already ranked). Do not add entries the tool did not return, and do not move an entry from
     `notVerified` into the menu.
4. **Record the choice** in `docs/MCP-PROJECT.md` (create it from the template below if it is missing; if it exists, edit only the
   "Chosen" and "Declined" sections and the date line). Record chosen entries with their `pin` and `install` note exactly as the tool
   printed them (every offered entry is `host-config` with an exact pin that its install text uses; there is no "choose at install" case). Record the
   entries the user declined under "Declined" so the next run does not re-offer them without a reason.
5. **Hand the install back to the user.** Say which entries were chosen, show each `install` note as text, and say plainly that
   nothing was installed. After the user installs a server, the measured schema size goes into the table:

   ```bash
   node docs/ops/mcp-schema-budget.cjs --config .mcp.json --server <name>
   ```

   Record `tokens`, the date and this command in the row. The project's budget is the sum of the recorded rows; adding a server
   later is a new user choice (run this skill again), not a silent change.

## Template: `docs/MCP-PROJECT.md`

```markdown
# MCP and skills of this project

Rule: PROTO-DEC-0170. Updated: <YYYY-MM-DD>. Chosen by: <user name>. Recommender run on: <YYYY-MM-DD>.
Figures are measured with the command in each row, never assumed. Adding a server or raising a figure is a new user choice.

## Mandatory (kernel minimum)

| server | measured tokens | date | command | kind | reason | pin | secret variable |
|---|---|---|---|---|---|---|---|
| serena | not measured | - | node docs/ops/mcp-schema-budget.cjs --config .mcp.json --server serena | mcp | symbol navigation | <pin> | none |
| codebase-memory | not measured | - | node docs/ops/mcp-schema-budget.cjs --config .mcp.json --server codebase-memory | mcp | code graph | <pin> | none |
| qmd | not measured | - | node docs/ops/mcp-schema-budget.cjs --config .mcp.json --server qmd | mcp | document search | <pin> | none |

## Chosen for this project

| server | measured tokens | date | command | kind | reason | pin | secret variable |
|---|---|---|---|---|---|---|---|
| <name> | not measured | - | node docs/ops/mcp-schema-budget.cjs --config .mcp.json --server <name> | <mcp or skill> | <why it fits this project> | <pin> | <VARIABLE NAME or none> |

## Declined

| name | reason |
|---|---|

## Budget

Total measured tokens of the rows above: <N> on <YYYY-MM-DD>. Not to be exceeded without a new user choice.
```

A row whose measured-tokens cell is a number (for example `4327`) is picked up by the recommender as a known cost on its next
run. Keep the first four columns in this order.
