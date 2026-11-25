# Installing Synapse: a guide for the agent doing the install

You are a coding agent (for example Claude Code) asked to install Synapse on this machine and connect one or more
projects to it. Follow the steps in order. Each step gives the command, the output to expect, and what to do when the
output differs. Steps marked **[HUMAN]** need the person you work for: stop, tell them exactly what to do, and wait.

Synapse is a local bus. Claude Code sessions on this machine share channel and direct messages, cooperative file
locks, a task board and decision cards, and each session receives bus messages pushed into its conversation.

## 0. Rules for you

- **Never print, log, commit or paste a key.** Keys live in `<home>/.env`. You may print a key's variable NAME, never
  its value. Never put a key in a URL or on a command line.
- **A person's personal key is typed by the person, not by you.** It is how the bus tells a person from an agent; if
  you see it, it no longer proves anything. Step 4 is [HUMAN] for that reason.
- **Detect the OS once** (`node -p process.platform`: `win32`, `darwin` or `linux`) and use that branch where a step has one.
- **What takes effect when:** a change to `synapse.config.json`, `projects.json` or `.env` needs a bus restart
  (`synapse restart`). A change to the MCP client needs a new Claude Code session. A hook file is live the moment it is saved.
- Commands below run from the root of this repository. `synapse` means `node bin/synapse.mjs`.
- The Synapse home is `SYNAPSE_HOME`, default `~/.synapse` (on Windows `%USERPROFILE%\.synapse`). Pass `--home <dir>`
  to any command to use another one.
- Before step 3, tell the human what the install will change, so they can say no: a home folder with the keys and the
  installed app; per project, an MCP server entry, four hooks that run in every future session there, and a `.synapse/` folder; the bus listens on 127.0.0.1 only. Nothing leaves the machine
  unless the human turns on the Discord pack (step 13).

## Trust model: what Synapse is and is not

Synapse coordinates sessions that run under **one trusted OS account**. Cards, locks and roles are cooperative: they
keep honest sessions from colliding and route decisions to a person. They are **not a security gate against an agent
that has full access to that account**: such an agent can read and edit the config, the installed code and the keys,
and so can make the bus say anything. A card answered on the dashboard is as trustworthy as the account it runs under.
Locks are advisory: an edit made outside the Edit and Write tools (for example by a shell command), or while the bus
is down, is not checked.

If you need approvals that an unrestricted agent cannot forge, run the bus and its home under a **separate OS account**
that the agents cannot read or write, and give the agents' account only the project keys (as environment variables,
not the home). The hooks there still need a readable `synapse.config.json` and `projects.json` (neither holds a key) at
the agents' `SYNAPSE_HOME`. This setup is optional and not automated here.

**With the Discord pack on** (step 13), Discord becomes a second way in, and this is who can act through it:
- Only Discord accounts listed in `synapse.config.json` (`people.<name>.accounts.discord`) count; each maps to exactly
  one person. Every other account is refused and logged, and the log never holds the id.
- A mapped person's messages in a mapped channel are posted to the bus under that person's name, only in projects that
  person is allowed in.
- A card is decided only by an owner or approver allowed in its project, once, and only by a tap on the exact
  message the bot posted for that card, in its channel. The bus, not the pack, decides who that person is and whether
  they may answer.
- Whoever controls a mapped Discord account acts as that person. Whoever holds the bot token can post as the bot and
  read the mapped channels: the token is a key, kept in `<home>/.env` and never printed.
- Everything posted to a mapped channel is visible to everyone who can read that channel on Discord. Known keys and credential-shaped text are replaced with `[redacted]` first,
  but other sensitive text is not. Use private channels.

## 1. Check the prerequisites

```sh
node -v
npm -v
git --version
claude --version
```

Expected: Node `v22.15.0` or newer; npm and git print a version; `claude` prints a version.

- Node older than 22.15: stop and tell the human to install a current Node (it needs `node:sqlite`).
- `claude` not found: the bus still installs, but sessions need Claude Code. Tell the human; carry on. The hooks use
  the exec form (`command` plus `args`), which needs a recent Claude Code.
- The default bus port is 4560. If another program uses it, pick a free port and pass `--port <n>` in step 3.

## 2. Install the dependencies

```sh
npm ci
```

Expected: `added N packages`, exit code 0. On failure, read the npm error; most often the network or an old npm.
There are no native modules in the core, so no compiler is needed. This also installs `discord.js`, an optional
dependency the core never loads (only the Discord pack of step 13 does); `npm ci --omit=optional` leaves it out.

## 3. Create the Synapse home

```sh
node bin/synapse.mjs init --owner <name>
```

`<name>` is the human's short lowercase name (letters, digits, `-`, `_`). They are the first owner: owners decide cards.

Expected:

```
synapse init: home <home>
  ok    app installed at <home>/app
  ok    wrote <home>/synapse.config.json (owner: <name>, port 4560)
  ok    wrote <home>/projects.json
  ok    <home>/.env is mode 600              (macOS, Linux)
  note  <home>/.env inherits its folder's Windows ACL ...   (Windows)
```

- `dependencies are missing`: run step 2.
- `exists, is not empty and is not a Synapse home`: the folder is someone else's; pick another `--home`.
- On Windows the note is expected: Node cannot set a Windows ACL, so the key file relies on the user profile's
  default permissions. Tell the human once, and keep the home inside their user profile.
- Running `init` again later upgrades the app and keeps the config, registry and keys. It refuses, changing nothing,
  while `<home>/app` holds a file Synapse did not install or an installed file that was edited, and names them: move
  them out (or restore them) first. A failed upgrade puts the previous app and manifest back and exits 1; if that
  rollback itself fails, the message says where each copy is and how to put it back.
- `another synapse command (pid N)`: wait for it. `left by pid N, which is no longer running` or `unreadable`: if no
  synapse command is running, `synapse unlock` clears it (it refuses while that pid is alive).

## 4. [HUMAN] Set the owner's personal key

Tell the human, word for word:

> In a terminal of your own (not through me), in this folder, run:
> `node bin/synapse.mjs set-human-key <name>`
> and type a personal key twice: 12 to 256 printable characters, no spaces. It is not shown. Keep it; you will sign in
> to the dashboard with it. Tell me when it says "stored a hash".

Until an owner has a key, nobody can answer a card, and `dev_ask` refuses to park one. Check, without reading any key:

```sh
node bin/synapse.mjs doctor
```

Expected: no `no owner has a key yet` note. If it is still there, the human has not finished step 4.

To add another person later: `set-human-key <their name> --role approver` (or `owner`, or `pingable`; add
`--projects a,b` to limit them to some projects). Their own terminal, their own key.

## 5. Connect a project

```sh
node bin/synapse.mjs add-project <project dir> --bot <bot name>
```

`<bot name>` is the name this project's sessions use on the bus (lowercase, for example `webbot`). It must not be a
person's name. Repeat for every project.

Expected:

```
synapse add-project: <id> (bot <bot>) at <dir>
  ok    registry entry in <home>/projects.json; key SYNAPSE_KEY_<ID> in <home>/.env (value not shown)
  ok    <dir>/.mcp.json: server "synapse" (machine-local: kept out of git)
  ok    <dir>/.synapse/config.json
  ok    <dir>/.claude/settings.local.json: 4 Synapse hooks (exec form: node + script path, no shell)
  ok    <git dir>/info/exclude: /<path>/.synapse/, /<path>/.mcp.json ignored (this machine only)
Next:
  1. restart the bus so it loads the new project: synapse restart
  2. [human] start Claude Code in <dir> with:
       claude --dangerously-load-development-channels server:synapse
```

What it wrote, so you can explain it: `.mcp.json` runs the Synapse MCP client with `node` and an absolute path into the
home (no key in the file; the client checks its arguments against `projects.json` for this folder); `.synapse/config.json` tells the hooks the project and bot (no key; the hooks use it only
while `projects.json` registers that project at this folder, see the README's trust model); four hooks in
`.claude/settings.local.json` (check-in, check-out, the pre-edit lock check, post-edit sync). These hold this machine's
paths, so by default they stay out of git: `.synapse/`, `.claude/settings.local.json` and an untracked `.mcp.json` get
anchored lines in the repository's exclude file (the one `git rev-parse --git-path info/exclude` names, not the
committed `.gitignore`) unless git already ignores them; a `warn` line names any that git still does not ignore.
Existing MCP servers, hooks and settings are kept. All files change together or not at all, and the manifest
(`<home>/install-manifest.json`) records a sha256 of each file, MCP entry and hook entry exactly as written. When
`projects.json` gives the bot its own key (`roster.<bot>.keyEnv`), the bot's sessions are wired with that key. A
Synapse MCP entry, hook entry or `.synapse/config.json` that is not what this installation wrote is never overwritten:
`add-project` stops and names it.

- `.mcp.json is tracked in git`: the project commits its `.mcp.json`. Either run the printed `claude mcp add --scope
  local ...` command and then `add-project ... --no-mcp`, or, if everyone shares the same home layout, pass `--shared`
  (writes `.claude/settings.json`, `.mcp.json` and a `.gitignore` line, all meant to be committed).
- `.claude/settings.local.json is tracked in git`: untrack it (`git rm --cached .claude/settings.local.json`) or pass
  `--shared`.
- `is not valid JSON`: fix that file; nothing was changed.
- `is a person's name`: choose another `--bot`. `already used for <other dir>` or `already uses the key name`: pass `--id`.

## 6. Start the bus

```sh
node bin/synapse.mjs start --background
```

Expected: `synapse: bus started (pid N) at http://127.0.0.1:<port>; dashboard http://127.0.0.1:<port>/; log <home>/data/bus.log`.
Use that dashboard address from here on.

- `did not come up`: read the last lines of `<home>/data/bus.log`. `cannot start:` lists config problems to fix.
  `port is already in use`: another bus or program holds the port; `synapse stop`, or set another `server.port`.
- After any later config change: `node bin/synapse.mjs restart`. `stop` acts only on a process it can prove is this
  bus; `not answering as this bus` means the recorded pid now belongs to something else, and it was left alone.
- To run it in the foreground instead (for a service manager such as systemd, launchd or Task Scheduler), the command is
  `node <home>/app/server/server.mjs`, with `SYNAPSE_HOME` set when the home is not the default.
- The bus binds 127.0.0.1 and answers only to its own loopback host names. Serving it to other machines needs
  `server.allowRemote: true` with a non-empty `server.allowedHosts` (the bus will not start without one, and answers
  any other Host header with 421), and a TLS proxy in front: keys travel in HTTP headers.

## 7. Check everything

```sh
node bin/synapse.mjs doctor --ready
```

Expected: every line `ok` (a few `note` lines are fine) and `synapse doctor: all checks passed`. It checks Node,
`node:sqlite`, the installed app, the config, the key file's permissions, that the bus is up and proves it holds this
home's bus secret (no key is sent before that), that it accepts each
project's key, that an owner has a personal key, and for each project folder the bot's key (it must authenticate as that
bot, or for the project), the exact MCP entry (type, command, arguments, environment) and each of the four hooks once
with its type, matcher and script; with Discord on, the token's presence (never its value), that discord.js loads,
the mapping and the connection (step 13). Only after every check of every project passed does it run a probe that starts the
MCP client as this installation writes it (never the command in the file) and lists its tools. A
project wired with `--no-mcp` is listed at the end under `not verified`: check that server yourself.

- `bus not reachable`: run step 6. `key refused` or `does not know it`: `synapse restart`.
- `no owner has a key yet`: step 4. Any other `FAIL` line names the file and the fix.

Optional self-test (temporary folders only, safe to run any time): `node scripts/smoke-install.mjs`. Expected last
line: `smoke: N/N passed`.

## 8. [HUMAN] The first session in a project

Tell the human:

> Open a terminal in `<project dir>` and run
> `claude --dangerously-load-development-channels server:synapse`
> Claude Code will ask whether to trust the folder, whether to use the project's MCP server "synapse", and will warn
> that development channels are loaded. Accept all three. The flag is needed on every launch: without it the session
> still connects but never shows bus messages. An organisation-managed Claude Code may disable channels; then the
> tools work but no message is pushed into the session.

Then, inside that session (you, or the session's agent):

- `/mcp` lists `synapse` as connected. That proves the MCP connection only, not channel delivery.
- The session starts with a `Synapse: checked in as "<bot>"` note in its context (from the SessionStart hook).
- **Channel delivery:** from another session of the project, or from the dashboard's message box, post to channel
  `code`. It must appear in this session as a `<channel>` message. Until one has arrived, channels are not working.

To run two sessions of one project side by side, give each a seat name, for example
`DEV_SYNC_SEAT=left claude --dangerously-load-development-channels server:synapse` (PowerShell:
`$env:DEV_SYNC_SEAT='left'; claude ...`; cmd: `set DEV_SYNC_SEAT=left && claude ...`). Sessions that share one name
never hear each other. Use named seats, not `auto`, in projects with hooks.

## 9. Smoke test with the human (optional)

1. In the session: `dev_msg_send` to channel `code`. Another session of the project receives it as a `<channel>` message.
2. In the session: `dev_sync_lock` a file. In a second session, editing that file is refused by the pre-edit hook.
3. In the session: `dev_ask` with two options. The tool answers that the card is parked on the dashboard and gives its
   address; it also tells the agent to put the question in its reply, in case nobody is at the dashboard.
4. **[HUMAN]** opens the dashboard address from step 6 in a browser on this machine, signs in with their name and
   personal key, and taps one option. The answer arrives in the asking session as a channel message naming the askId.
   If the session was closed, the answer waits and is delivered when it reconnects. The client can prove only that it
   handed the answer to an initialised Claude Code session, not that the session showed it (one launched without the
   channels flag drops it): if an answer seems missing, `dev_msg_history` with channel `direct` shows it
   while it is among the project's last 200 messages.

## 10. Optional parts

- **Discord** (relayed channels, cards with buttons, pings): off by default; step 13.
- **Privacy-sensitive hooks** from the original system (mirroring every prompt, sending command lines, mirroring
  session-to-session messages, running post-push commands from repo config) are not part of this build.

## 11. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No `<channel>` messages appear in a session | Launched without `--dangerously-load-development-channels server:synapse`, the `.mcp.json` server is not named `synapse`, or channels are disabled by your organisation. |
| The client log says close code 4001 | No key resolved (the `--key-env` variable is not in `<home>/.env`), or a key in the URL. Re-run `add-project`, then `restart`. |
| Close code 4002 | The bus does not know the project: `synapse restart`. |
| Close code 4003 | The bot name is not in the project's `assertableBots` (`projects.json`). |
| Two sessions of one bot do not hear each other | Give each a different `DEV_SYNC_SEAT`. |
| `dev_ask` says nobody can answer | No owner or approver allowed in that project has a personal key yet (step 4), nor, with Discord on, a Discord account id while the bot is connected (step 13). |
| The dashboard says the name or key was not accepted | Wrong key, or the person has no key yet (step 4). Twenty wrong tries in 15 minutes lock the address out for a while. |
| `host_not_allowed` | The request used a host name other than 127.0.0.1 or localhost; use the dashboard address from step 6. |
| A change has no effect | Config, registry and keys: `synapse restart`. MCP client: start a new Claude Code session. |
| `discord: the bus is not connected to Discord` | Wrong token (`discord setup --new-token`), the Message Content intent is off, or no network. The reason is in `<home>/data/bus.log`. |
| A Discord message never reaches the bus | Its author is not mapped (`accounts.discord`), is not allowed in that project, or the channel is not mapped; `bus.log` says which (`refused a message`). |
| A tap says "does not know your Discord account" or "not an owner or approver" | Map the account, or give that person the `approver` role for the project, then `synapse restart`. |
| `the discord.js package is not installed` | Discord is on but the optional dependency was left out: `npm ci` (without `--omit=optional`), then `synapse init`. Or `synapse discord disable`. |

## 12. Uninstall

```sh
node bin/synapse.mjs uninstall
```

This is a dry run: it lists what it would remove, taken from `<home>/install-manifest.json` only: the `synapse` server
it added to each project's `.mcp.json`, its four hooks, the `.synapse/config.json` it wrote, the ignore lines it added,
and in the home the installed app files, the bus's data files and the files `init` created. Each is removed only while
it is exactly what Synapse wrote (its recorded sha256); a file you changed, and anything you added, is kept and named.
An edited Synapse MCP or hook entry, a Synapse hook in the settings file it did not write, or a second copy of one,
still runs the app, so uninstall lists it under `Remove these by hand`, keeps the
home, app and manifest, and exits 1; the same happens when a project step fails. Remove or fix what it names, then run
it again. Session records in `<home>/data/seats` are left for you. Folders are removed only when empty, and a folder
without the `.synapse-home` marker is refused. **[HUMAN]** Show the list and ask for a yes before you run:

```sh
node bin/synapse.mjs uninstall --yes
```

Add `--keep-home` to keep the home folder (keys and history).

## 13. Optional: the Discord pack

Mirrors mapped bus channels to Discord channels both ways, posts decision cards with buttons (Other and Dismiss
included), and turns `dev_notify_human` into a ping. Only mapped bus channels are mirrored; a project broadcast
(`dev_msg_broadcast`) stays on the bus. Read the Discord part of the trust model above to the human before you start. Nothing changes
until the command of 13.3; `synapse discord disable` turns it off again.

### 13.1 [HUMAN] Create the bot

Tell the human:

> 1. Open https://discord.com/developers/applications, choose **New Application**, and name it.
> 2. On the **Bot** page: choose **Reset Token** and keep the token for step 13.3 (do not paste it to me or anywhere
>    else). Under **Privileged Gateway Intents**, switch on **Message Content Intent**; leave the other two off. You may
>    switch off **Public Bot**.
> 3. On **General Information**, copy the **Application ID**, then open this address with it filled in, pick your
>    server and authorise:
>    `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=68608`
>    (68608 = View Channels, Send Messages, Read Message History; nothing else).
> 4. In Discord: **User Settings > Advanced > Developer Mode** on. Right-click each channel that should mirror a project
>    channel and **Copy Channel ID**; right-click your own name and **Copy User ID**. Use private channels, and give the
>    bot access to them. Tell me the ids (they are not secret; the token is).

### 13.2 Decide the mapping

One Discord channel per project and bus channel, for example `my-app/code` and `my-app/build`. A Discord channel
belongs to one project only; the bus refuses a channel mapped twice. Cards for a project go to its
`code` mapping (or the first one); `--cards my-app=build` picks another. Each person who should answer on Discord
needs their user id, and must already be in `people` (step 4, or `set-human-key <name> --role approver`).

### 13.3 [HUMAN] Turn it on

Build the command with the ids, then tell the human to run it in a terminal of their own (it asks for the token and
does not show it):

```sh
node bin/synapse.mjs discord setup --person <name>=<user id> --channel <project>/code=<channel id> [--channel ...]
```

Expected:

```
synapse discord: on
  ok    bot token stored in <home>/.env as SYNAPSE_DISCORD_TOKEN (value not shown)
  ok    N Discord channel(s) mapped for M project(s); K person(s) with a Discord account id
```

- `is not in people`: add the person first (13.2). `mapped to both`: one Discord channel was given twice.
- `discord.js ... in` (not installed, or does not load): step 2 ran with `--omit=optional`, or the install is
  damaged; run `npm ci`, then `synapse init`.
- `does not look like a bot token`: the paste was not the token (three parts joined by dots); copy it again.
- `set in this shell's environment`: a `SYNAPSE_DISCORD_TOKEN` variable in the shell would win over `<home>/.env`
  when the bus starts from that shell; unset it first. `holds a bus key`: `discord.tokenEnv` names a key variable.
- Setup re-reads the config under the install lock and runs every boot check on the result; any problem means nothing
  was written. While the pack is off, problems in the `discord` block are only warnings; once it is on, they stop the bus.
- With a token already stored, you may run `discord setup` yourself to change ids or mappings (`kept the one in`);
  `--new-token` asks the human for a new one.

### 13.4 Restart and check

```sh
node bin/synapse.mjs restart
node bin/synapse.mjs doctor --ready
```

Expected, besides the usual lines: `discord: bot token set`, `the discord.js package loads`, `N channel(s) mapped`,
`N owner(s) or approver(s) can answer on Discord` and `discord: the bus is connected to Discord`. Give it a few
seconds after the restart to connect. Then, with the human: a message they type in a mapped channel appears in a
session as a `<channel>` message under their name; a `dev_ask` appears in Discord with one button per option, and
their tap answers the session.

### 13.5 Not in this release: permission approvals

Answering Claude Code's permission prompts from Discord is planned, not part of this release: those prompts are
answered in the session as before.

## For maintainers: the release gate

Before publishing, scan every commit of every ref, not only the current tree:

```sh
npm run release-check
```

It runs `scripts/leak-check.mjs --history --require-denylist --require-secrets`. A clean index scan says nothing about
the history a push would publish; this gate fails on any commit that carries a secret value, a deny-list term or a
token pattern.
