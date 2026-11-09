# Lunchbox

A desktop workspace where the AI agents you already pay for work together in one room.

Claude Code, Codex, Grok and Gemini each run as the real command line tool, with their own login and plan. Lunchbox gives them a shared memory, lets them ask each other for help, moves the work on when one runs out, and checks what they claim against what actually ran.

## What happens in a room

You describe the goal once. The first agent in the crew picks it up, and from there:

**Handoffs.** An agent that needs someone else writes `@grok: what are people saying about this today` on its own line. Grok answers, the answer goes into the room's memory, and the first agent carries on with it. The room stops after a fixed number of hops so a conversation can't loop.

**Limits.** When an agent hits its usage limit or fails to start, the next one in the crew takes the same task with the same memory. The reset time is read from the error when the tool gives one, and the agent comes back on its own after that.

**Shared memory.** The brief, answers between agents, changed files, your decisions and anything you pin are kept as versioned blocks. Each agent is sent only the blocks that changed since it last looked. Agents that support resuming a session (Claude Code, Codex, Grok) also get only the conversation since their last turn.

**Proof.** When an agent says the tests pass or the build works, Lunchbox looks for a matching command that exited 0 after the last file edit, whether the agent ran it or you did. If there isn't one, you're asked whether to run the project's own check, ask the agent to prove it, or accept it as is.

**Side by side.** Send one message to the whole crew and they answer on their own, in columns. The one you keep is recorded as a decision and counted on the Agents page.

Rooms can be forked from any message, replayed, and saved as a skill: the brief plus the steps that worked, ready to start a new room with `/`.

## Access

The mode is picked per message in the composer, not once at setup.

| Mode | Agents | Commands you run with `!` |
| --- | --- | --- |
| Plan | Read only | Reads run, everything else is refused |
| Ask | Read freely, edits wait for you | Anything that writes asks first |
| Auto | Edit and run inside the folder | Free inside the folder, outside asks |
| Full access | No restrictions | Free, except deleting folders, sudo and force pushes |

Some commands never run in any mode, such as `rm -rf ~` or formatting a disk. The rules live in `electron/policy.ts` and are covered by `scripts/test-policy.mjs`.

## Agents

| Agent | How it runs |
| --- | --- |
| Claude Code | `claude -p` with streamed JSON, sessions resumed per room |
| Codex | `codex exec --json`, sandbox set from the mode |
| Grok Build | `grok` headless with streamed messages |
| Gemini CLI | `gemini -p` with streamed JSON |
| Ollama | Local HTTP API, any chat model you have pulled |
| Anthropic, OpenAI, xAI, Gemini, OpenRouter | API keys, sealed with the system keychain. Anthropic requests mark the room context for prompt caching. |

Agents are found on your `PATH` when the app starts and again from the Agents page. Each can have a model, a daily budget in dollars and an on/off switch. Usage and cost come from the tools' own reports.

## Packs

A pack focuses a room on one kind of work: a brief for the crew, starting ideas and optional checks that show up under `/`. Software, Research, SEO and Writing are built in. Import more from Settings. A pack is a plain JSON file:

```json
{
  "id": "landing-pages",
  "name": "Landing pages",
  "line": "Pages that convert",
  "brief": "This room builds landing pages. Mobile first, one call to action, measure with Lighthouse.",
  "ideas": ["Build a landing page for the product in this folder"],
  "checks": [{ "label": "Lighthouse", "command": "npx --yes @lhci/cli autorun" }]
}
```

## Development

Requires Node 24.

```sh
npm install
npm run dev        # Vite and Electron with hot reload
npm test           # policy rules, stream parsers, proof, memory, a full room against stand-in agents
npm run typecheck
npm run tour       # drives the real app with stand-in agents and saves screenshots to test/shots
npm run live       # one short room with the real Claude Code and Grok; uses a little of your plan
npm run dist       # installers for the current platform into release/
```

CI checks macOS, Linux and Windows on every push. Tagging `v*` builds a dmg and zip for macOS, an installer for Windows, and an AppImage and deb for Linux.

### Layout

```
electron/
  main.ts           window, IPC, keychain
  store.ts          rooms as append-only JSONL, settings, ledger
  system.ts         PATH, shells and process handling per platform
  policy.ts         what each access mode lets a command do
  shell.ts          runs `!` commands and proof checks
  agents/           one parser per stream format, CLI and HTTP runners
  room/engine.ts    turns, handoffs, limits, memory, proof, side by side
  room/context.ts   what each agent is sent
  room/proof.ts     claims against the command history
shared/             types and plan parsing used by both sides
src/                React renderer
test/               unit tests, recorded CLI output, the stand-in agent
```

Data lives in the app's user data folder (`~/Library/Application Support/Lunchbox` on macOS, `%APPDATA%\Lunchbox` on Windows, `~/.config/Lunchbox` on Linux). Each room is one `.jsonl` file you can read with any editor.
