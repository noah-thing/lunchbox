<p align="center">
  <img src=".github/assets/icon.png" width="112" height="112" alt="Lunchbox">
</p>

<h1 align="center">Lunchbox</h1>

<p align="center">
  The AI tools you already pay for, working together in one room.
  <br>
  <a href="#install">Install</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#how-it-works">How it works</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/noah-thing/lunchbox/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/noah-thing/lunchbox/ci.yml?branch=main&style=flat-square&label=ci&labelColor=121110&color=F2F0EA" alt="CI"></a>
  <img src="https://img.shields.io/badge/version-0.1.0-F2F0EA?style=flat-square&labelColor=121110" alt="Version 0.1.0">
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-F2F0EA?style=flat-square&labelColor=121110&label=runs%20on" alt="Runs on macOS, Windows and Linux">
  <img src="https://img.shields.io/badge/Electron-45-F2F0EA?style=flat-square&labelColor=121110&logo=electron&logoColor=F2F0EA" alt="Electron 45">
  <img src="https://img.shields.io/badge/license-all%20rights%20reserved-F2F0EA?style=flat-square&labelColor=121110" alt="All rights reserved">
</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/room-dark.png">
  <img alt="A Lunchbox room: Claude leads, Grok has searched X, Codex has designed the banner and is building the event page" src=".github/assets/room-light.png">
</picture>

<p align="center"><sub>Claude leads, Grok searches X, Codex designs the banner and builds the page. One room, one memory.</sub></p>

## About

Lunchbox is a desktop app for people who use more than one AI agent. Claude Code, Codex, Grok Build, Gemini CLI, local models and API keys join the same room. They share what they know, ask each other for help in the middle of a task, and take over from each other when a plan runs out.

Every agent runs as the real tool with its own login and plan. Lunchbox does not resell access or route your work through a server of its own.

## Highlights

- **One room, every agent.** Describe the goal once. The crew plans it, splits it up and works from one shared memory.
- **Handoffs while they work.** An agent asks a crewmate for what that crewmate does best, gets the answer and carries on with it.
- **Limits stop being a wall.** When one agent runs out, the next picks up the same task with the same memory. Pool shows what each plan has left, read from the providers.
- **Claims get checked.** "The tests pass" counts as proved only when a passing run happened after the last edit.
- **Prompt caching built in.** Requests are arranged so providers reuse what they have already seen. Savings shows what it saved.
- **Flows.** Work that runs on a schedule, such as nightly checks, a morning X digest or a weekly SEO pass. 25 templates to start from.
- **Local first.** Rooms are plain files on your computer and keys are sealed with the system keychain.

## Install

Lunchbox is in private development. The release workflow builds a dmg for macOS, an installer for Windows, and an AppImage and deb for Linux for every tagged version. Until the first public release, run it from source.

## Quick start

You need [Node 24](https://nodejs.org) and at least one agent.

```sh
git clone https://github.com/noah-thing/lunchbox.git
cd lunchbox
npm install
npm run dev
```

On first launch Lunchbox looks for agents on your computer and lists what it found. Any of these work:

| Agent | Install | Sign in |
| --- | --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Gemini CLI | `npm install -g @google/gemini-cli` | `gemini` |
| Grok Build | [x.ai/cli](https://x.ai/cli) | `grok login` |
| Local models | [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai) or `llama-server` | none |
| API keys | Anthropic, OpenAI, xAI, Google, OpenRouter | Agents page |

Then type what you want done and press Enter.

## How it works

### Rooms

A room is one goal, one crew and one folder. If you don't pick a folder, Lunchbox makes one for the room, named after what you asked for.

- **Handoffs.** An agent writes `@grok: what are people saying about this today` on its own line, or borrows a crewmate's tool during its turn. The answer lands in the room's memory and the first agent continues.
- **Memory.** The brief, answers between agents, changed files and anything you pin are kept as versioned blocks. Each agent is sent only what changed since it last looked.
- **Proof.** When an agent claims the build works, Lunchbox looks for a matching command that exited 0 after the last edit. If there isn't one, you decide what happens next.
- **Side by side.** Send one message to the whole crew and keep the answer you like. Your picks rate the agents per kind of work.
- **Rewind.** The folder is saved before every message, so any change can be undone. Rooms can be forked, replayed and exported.

### Access

You choose the mode per message in the composer.

| Mode | Agents can | Commands you run with `!` |
| --- | --- | --- |
| Plan | Read only | Reads run, the rest is refused |
| Ask | Read freely, edits wait for you | Anything that writes asks first |
| Auto | Edit and run inside the folder | Free inside the folder, outside asks |
| Full access | Anything on the computer | Free, except deleting folders, sudo and force pushes |

Some commands never run in any mode, such as `rm -rf ~`. The rules live in [`electron/policy.ts`](electron/policy.ts) and have their own tests.

### Pool and Savings

Pool shows every plan and key as one allowance: what each one has left in its 5 hour and weekly windows, when they reset, and who is best at which kind of work. Savings shows what prompt caching saved, per agent and per room.

### Packs and Flows

A pack focuses a room on one kind of work, such as software, research, SEO or writing. A flow runs a few steps on a schedule, each in a room of its own. See [docs/packs.md](docs/packs.md) to write your own pack.

## Your data

Everything stays on your computer.

| | Where |
| --- | --- |
| Rooms, settings and usage | `~/Library/Application Support/Lunchbox` on macOS, `%APPDATA%\Lunchbox` on Windows, `~/.config/Lunchbox` on Linux |
| API keys | The system keychain |
| Agent logins | With each tool, untouched |

Each room is one `.jsonl` file you can open in any editor. Plan limits are read with the login each tool already has, and that login only goes to the company that issued it. You can turn this off in Settings.

## Development

```sh
npm run dev         # Vite and Electron with hot reload
npm test            # policy rules, parsers, caching, limits and a full room with stand-in agents
npm run typecheck
npm run tour        # drives the real app and saves screenshots to test/shots
npm run dist        # installers for the current platform in release/
```

CI runs the type check, tests and build on macOS, Windows and Linux for every pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made and [docs/architecture.md](docs/architecture.md) for how the code is laid out.

## License

Copyright © 2026 noah-thing. All rights reserved.

Agent marks come from [Lobe Icons](https://github.com/lobehub/lobe-icons) under the MIT license, see [licenses/lobe-icons.txt](licenses/lobe-icons.txt). Product names belong to their owners.
