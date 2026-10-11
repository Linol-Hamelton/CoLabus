# L6 pilot kit

Installed by `docs/ops/pilot-install.cjs` from the protocol source repository. It is a small, self-contained set of files that records
what the agents you launch in this project actually did, in the same `launch-record/1` format the source repository uses.
The recording wrapper has no gates, no candidate registry, no operator contour and no network code. Kit v3 adds, under `src/docs/ops/`, the mandatory MCP minimum with its recommender and the channels tools (doctor, keys, wizard, env, dedupe, guard); they only read, never install a server, never edit `.mcp.json` or a client config and never store a key value. What the user does next (doctor, logins, keys, the three mandatory MCP servers, optional servers, `.gitignore` lines) is in `docs/ops/PILOT-NEXT-STEPS.md`.

## Use

Put `docs/ops/pilot-kit/run-and-record.cjs ... --` in front of any agent command:

```
node docs/ops/pilot-kit/run-and-record.cjs --client codex --model gpt-5.5 --role author --task "what this run is for" -- codex exec --file prompt.md
```

Options (all optional): `--client`, `--model` (the model you asked for), `--effort`, `--role`, `--stage`, `--task`, `--name` (launch id slug),
`--prompt-file` (its path and sha256 are recorded), `--log` (a client log file the served-model check may read), `--caller`, `--journal`.
Everything after `--` is the command. Its output is passed through unchanged and its exit code is the exit code of this wrapper.

Each run appends ONE line to  (append only, never rewritten): launch id, start and end time, requested
tuple, working directory, git head and tree state, exit code and failure class, wall seconds. The wrapper warns when the record does not
pass the validator and refuses to write a line that contains a secret-shaped string.

`servedModel` (the model that really answered, with `servedModelSource` and `servedModelConfidence`) is written only when
`src/docs/ops/served-model.cjs` is in this kit and finds it in the client banner or log. If the file is missing the field is left out:
the requested model in `tuple.model` is then NOT evidence of the served model.

## Check the journal

```
node docs/ops/pilot-kit/src/docs/product/launch-records/tools/launch-record-validate.cjs check 
```

## The full contour (L4, L5, L6)

The launch wrapper with the dispatch engine, the packet wiring, the candidate gate, `state-brief`, the owner-words journal and the L6 statistics tools are installed next to this kit at their own paths; see `docs/ops/PILOT-L4-L6.md` (commands, switches, limits, rollback).

## Keys wizard

One command asks for every key of the project in turn (add or skip) and writes it into the OS credential store under the names the project already reads; then, optionally, it offers the client logins (claude, codex, vibe, mimo and the others the catalog lists) and runs one only when you answer `y`:

```
node docs/ops/pilot-kit/src/docs/ops/channels-wizard.cjs
```

Before every prompt the wizard shows the vendor page where the key is created and a one-line hint (what to set, for example the credit limit). Answers: `a` add, `e` take the value of a variable that is already set in this machine environment (read inside the process, never printed), `o` open the vendor page in the default browser (only on `o`), `s` skip, `r` rotate, `q` quit. After it, `node docs/ops/pilot-kit/src/docs/ops/channels-verify.cjs` makes one read-only request per available key, only to the vendor of that key, and prints name, state and balance (never a value). On a new machine run the wizard, then the verify command.

The value is typed at a hidden prompt, never shown and never an argument. `--list` prints the services and the stored state without asking; `--only openrouter,groq` limits the walk. The installer offers it at the end of a real install (`--keys=ask|yes|no`); to add one key by hand use `channels-keys.cjs add <channel> --alias <name>` from the same directory.

## Do not publish the pilot branch

The branch `kernel-pilot-*` holds the installed kernel, journals and launch records: never push it to a PUBLIC repository. `pre-push-guard.sample` (in this directory) is a pre-push hook you may install: `cp docs/ops/pilot-kit/pre-push-guard.sample .git/hooks/pre-push`. It refuses the push of a `kernel-pilot-*` branch unless `ALLOW_KERNEL_PILOT_PUSH=1` is set for that push.

## What is in the kit

`KIT-MANIFEST.json` lists every copied file with its sha256, the source SHA and the roots that were pending when the kit was installed
(`served-model.cjs`, `seat-check.cjs` land with D9; run `pilot-install` again from the source repository once they exist, on a new branch).
