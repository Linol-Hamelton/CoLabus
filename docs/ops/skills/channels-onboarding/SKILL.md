---
name: channels-onboarding
description: Connect the channels (CLI clients, API keys, MCP servers) of a project. Runs the read-only doctor, shows ONE checklist of the actions only the user can do (log in, authorize, add keys), then stops for the user. Use right after the kernel is installed in a project, when a channel or key is missing, or when the user asks what to connect. Never receives, reads or asks for a key value.
---

# Channels onboarding

Rule source:  and `docs/ops/CHANNELS.md`. Tools: `docs/ops/channels-doctor.cjs`, `channels-keys.cjs`, `channels-env.cjs`,
`channels-dedupe.cjs`, `channels-guard.cjs` (in a project that received the pilot kit they are under
`docs/ops/pilot-kit/src/docs/ops/`).

## Hard limits

1. Never receive, read, print, ask for, paste or remember a key value. If the user pastes one into the chat, tell them to revoke
   it at the provider and rotate it, and do not repeat it anywhere (journal, file, command).
2. Never run `channels-keys.cjs add`, `rotate` or `remove`. The user types the value in their OWN terminal at the hidden prompt; removal is
   the user's decision. You may show the exact command for the user to run.
3. Never install a client or server, log in, edit a client config or `.mcp.json`, delete a file or a duplicate. You report, the user acts.
4. Never put a value in argv, a file, a prompt or a journal; names of keys and `file:line` are fine.
5. Sealed certifier sessions get no keys and no MCP, whatever the project chose.

## Steps

1. **Run the doctor** from the project root:

   ```bash
   node docs/ops/channels-doctor.cjs --network
   ```

   It is read-only. `--network` lets the clients health-check the MCP servers the user already configured (this is how a server that
   needs authorization is found); tell the user that before you run it. Exit 0 means nothing to do, 1 means actions pending, 2 means
   the run itself failed: report the one-line reason and stop.
2. **Ask which channels the project wants** (clients without a menu tool: a numbered list). Read the catalog groups from the doctor
   output (CLI clients found, API keys, MCP servers). Record the answer, names only, in `docs/channels-project.json`
   (`{"schema":"channels-project/1","want":[...],"declined":[...],"updated":"YYYY-MM-DD"}`) and re-run the doctor so the list
   matches the choice. Do not offer a channel the doctor lists under "Not offered" (unverified or excluded).
3. **Show ONE checklist** from `.ai/runtime/CHANNELS-STATUS.md`, section "Your actions", grouped in the order the user will do it:
   `install`, `login`, `authorize`, `add-key`, `connect`, `repair`. For each item show the exact command or the browser step from the
   file. For MCP the MCP recommender (`docs/ops/skills/mcp-recommender/SKILL.md`) chooses optional servers; this skill only reports their state.
4. **Duplicates.** Run `node docs/ops/channels-dedupe.cjs` and show the findings (file:line and NAME). Say plainly that removal is the
   user's decision; offer nothing that deletes.
5. **Stop for the user.** Say: "Do these steps in your own terminal and browser. Tell me when done and I will re-run the doctor."
   Do not guess, do not retry on their behalf, do not work around a missing key.
6. **Re-run** `node docs/ops/channels-doctor.cjs --network` when the user says they are done. Repeat from step 3 until "Your actions" is empty.
7. **Running a command that needs keys** (after the user added them): `node docs/ops/channels-env.cjs run --keys <channel,...> -- <command>`.
   The keys exist only in that child process; its output is filtered for the injected values when it is not a terminal. Start the clients
   that need keys (for example goose, or a client with an MCP server that reads a key) through this command.
8. **Journal.** Record in the session journal which channels were requested, the doctor's exit code and the count of actions left.
   Names only. Never a value, a prefix or a length.

## What the doctor does not know

Where a verified read-only login check does not exist (most clients), the doctor says `unknown (no verified read-only check)` and does not
claim a login state. Where an install command is not verified it says so and does not offer one. Keys are per device: a checklist for another
machine is not valid here.
