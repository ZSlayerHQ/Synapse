# Synapse

A local coordination bus for Claude Code sessions. Sessions on one machine (or a private network) share
messages, cooperative file locks, a task board and decision cards, and each session receives bus messages
pushed into its conversation through Claude Code's development channels.

> **Status: v2 pre-release (branch `v2`).** The v1 tree was replaced. The core (bus server, MCP client, core
> hooks, the `synapse` CLI) and the optional Discord pack are in place; a refreshed dashboard follows.

## Install

Point your Claude Code agent at [`AGENTS.md`](AGENTS.md): it is a step-by-step install guide written for an
agent to execute, with the expected output of each step and the steps that need you.

In short, with Node 22.15 or newer:

```sh
npm ci
node bin/synapse.mjs init
node bin/synapse.mjs add-project /path/to/your/project --bot mybot
node bin/synapse.mjs start
node bin/synapse.mjs doctor --ready
```

## Trust model

Synapse coordinates Claude Code sessions that run under **one trusted OS account**. Decision cards, file locks and
roles are cooperative coordination between those sessions, not a security gate: an agent with full access to that
account can edit the config, the installed code and the keys. Locks are advisory, and edits made outside the hooked
tools are not checked. If approvals must hold against unrestricted agents, run the bus under a separate OS account
the agents cannot read or write, and hand the agents only project keys. That setup is an option, not the default.
Details: [AGENTS.md](AGENTS.md#trust-model-what-synapse-is-and-is-not).

**A repository's files are untrusted.** A branch, a clone or a vendored folder can carry its own `.synapse/config.json`,
so that file only names a project and a bot. The hooks use it only when `<home>/projects.json` registers that project at
exactly that folder, send only the key the registry binds for that bot, and send it only to the bus in
`<home>/synapse.config.json` (never a URL from the project, never `DEV_SYNC_URL`). Otherwise they send nothing and say why.
The same holds for a project's `.mcp.json`: the MCP client sends only the key the registry binds to the project
registered at its working folder, only to that bus, and stops before connecting on a `--url`, `--http`, or a
`--project` or `--key-env` the registry disagrees with. An installed client also ignores `SYNAPSE_HOME`.

**Keys go only to a proven bus.** Another account on the machine could take the bus port while the bus is down. So the
client, the hooks and `synapse doctor` first send a random nonce with no key, and send a key only when the answer is an
HMAC of it under `<home>/data/bus-secret` (a private file the bus writes once and never sends). Otherwise they refuse
and say why. The dashboard cannot check this from a browser: open it only while `synapse doctor` shows the bus proven.

**Only approve a `synapse` MCP server you added yourself.** Claude Code runs whatever command a project's `.mcp.json`
names. A cloned repository's `.mcp.json` can therefore run its own code before Synapse checks anything, so approve the
`synapse` server only in a project where you ran `synapse add-project` yourself. `synapse doctor` reports a `.mcp.json`
entry that differs from what add-project wrote.

**Discord (optional, off by default)** adds a second way in. Only Discord accounts mapped to a configured person count;
each acts as that person, only in projects that person is allowed in, and only an owner or approver of a card's
project can decide it, by a tap on that card's own message (the bus checks this, not the pack). Every other account is refused and logged. Whoever holds the
bot token can post as the bot and read the mapped channels, and everyone who can read a mapped channel sees what is
posted there; known keys and credential-shaped text are redacted first. Set it up with `synapse discord setup`
([AGENTS.md step 13](AGENTS.md#13-optional-the-discord-pack)).

## Known limits

- **Channel push needs a flag and your organisation's consent.** Each Claude Code launch must pass
  `--dangerously-load-development-channels server:synapse`, and an organisation policy can switch development channels
  off. Without them, sessions still have the `dev_*` tools but receive no pushed messages.
- **A delivery ack covers the handoff to Claude Code, not the display.** The client acks a card answer once it has
  written it to an initialised session; MCP gives no display receipt. A missing answer can be read back with
  `dev_msg_history` (channel `direct`) while it is among the project's last 200 messages.
- **Lock keys are lexical.** The bus and the hooks share one path policy, with case matching taken from the project
  folder. A symlink or junction alias, or a subfolder whose case rules differ from the project root, can give one file
  two keys (a missed conflict) or two files one key (a false one).

- **Discord: cards are edited by message id.** After a bus restart a card closed elsewhere is still edited (its
  message id is stored with the card). Posts made while the bot is disconnected are not mirrored later, and a project
  broadcast is never mirrored.
- **Permission approvals from Discord are planned**, not in this release: Claude Code's permission prompts are
  answered in the session.

## Releasing

`npm run release-check` scans every commit of every ref for secret values, deny-listed terms and token patterns.
Run it before any push; a clean tree scan does not cover history.

## Layout

| Path | What |
|---|---|
| `server/` | the bus: HTTP API + WebSocket on one port (default 4560), loopback by default |
| `client/` | the stdio MCP server each Claude Code session runs (`dev_*` tools, channel push) |
| `hooks/` | Claude Code hooks: session check-in/out, pre-edit lock check, post-edit sync |
| `server/packs/discord/` | the optional Discord pack, loaded only when `discord.enabled` is true |
| `shared/` | code the bus and the hooks both use (the one lock-key policy) |
| `bin/synapse.mjs` | the CLI: `init`, `add-project`, `start`, `doctor`, `discord setup`, `uninstall` |
| `dashboard/` | a small local dashboard: who is online, recent messages, open decision cards |
| `schema/` | the JSON schema for `synapse.config.json` |
| `scripts/leak-check.mjs` | the pre-commit check that keeps secrets and personal data out of the repo |

## License

MIT, see [LICENSE](LICENSE).
