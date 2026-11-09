<p align="center">
  <img src=".github/assets/icon.png" width="112" height="112" alt="Lunchbox">
</p>

<h1 align="center">Lunchbox</h1>

<p align="center">
  A desktop app that runs Claude Code, Codex, Grok and Gemini together on your projects, with the logins you already have.
</p>

<p align="center">
  <a href="https://github.com/noah-thing/lunchbox/actions/workflows/ci.yml"><img src="https://github.com/noah-thing/lunchbox/raw/badges/ci.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/version-0.1.1-F2F0EA?style=flat-square&labelColor=121110" alt="Version 0.1.1">
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-F2F0EA?style=flat-square&labelColor=121110&label=runs%20on" alt="Runs on macOS, Windows and Linux">
  <img src="https://img.shields.io/badge/Electron-45-F2F0EA?style=flat-square&labelColor=121110&logo=electron&logoColor=F2F0EA" alt="Electron 45">
  <img src="https://img.shields.io/badge/license-all%20rights%20reserved-F2F0EA?style=flat-square&labelColor=121110" alt="All rights reserved">
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a>
  &nbsp;·&nbsp;
  <a href="#how-it-works"><b>How it works</b></a>
  &nbsp;·&nbsp;
  <a href="#your-data"><b>Your data</b></a>
  &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md"><b>Contributing</b></a>
</p>

<br>

https://github.com/user-attachments/assets/92e057ae-6206-4a41-ae07-bffed98bee19

<p align="center"><sub>Recorded as it ran. Claude plans a hackathon announcement, Grok searches X, Codex draws the banner, builds the event page and runs the tests.</sub></p>

<br>

## What it is

You probably pay for more than one AI tool. Lunchbox puts them in the same window and lets them work on the same task: Claude Code, Codex, Grok Build, Gemini CLI, local models through Ollama or LM Studio, and API keys from Anthropic, OpenAI, xAI, Google and others.

Each tool runs as itself, signed in with your account and billed to your plan. Lunchbox has no server of its own and sells no access.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/room-dark.png">
  <img alt="A Lunchbox room: Grok has searched X, Codex has designed the banner and is running the tests" src=".github/assets/room-light.png">
</picture>

<table>
  <tr>
    <td width="50%" valign="top">
      <b>You pick who leads</b><br>
      Your messages go to the agent you choose. It does the work and brings in another when that one is better at it, such as Grok for a search on X.
    </td>
    <td width="50%" valign="top">
      <b>Briefings, not transcripts</b><br>
      Agents that are not working get nothing. When one joins, it receives the goal, what the room has learned, the files changed and its task.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <b>When a plan runs out</b><br>
      If an agent hits its usage limit, the next one in the crew takes over the same task and is told where things stand.
    </td>
    <td valign="top">
      <b>Proof for claims</b><br>
      When an agent says the tests pass, Lunchbox looks for a passing run after the last edit. If there is none, it asks you.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <b>Prompt caching</b><br>
      Requests are ordered so providers can reuse what they have already read. The Savings page shows what that saved.
    </td>
    <td valign="top">
      <b>Flows</b><br>
      Steps that run on a schedule, like nightly checks, a morning X digest or a weekly SEO pass. 25 templates included.
    </td>
  </tr>
</table>

## Quick start

**1. Install Lunchbox.** One line downloads the latest version for your computer, installs it and opens it.

```sh
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/noah-thing/lunchbox-releases/main/install.sh | sh
```

```powershell
# Windows, in PowerShell
irm https://raw.githubusercontent.com/noah-thing/lunchbox-releases/main/install.ps1 | iex
```

Prefer a normal download? The dmg, the Windows installer, the deb and the AppImage are all under [Releases](https://github.com/noah-thing/lunchbox-releases/releases/latest). Lunchbox updates itself after that.

**2. Have at least one agent.** Lunchbox finds the ones you have on first launch.

| Agent | Install | Sign in |
| --- | --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Gemini CLI | `npm install -g @google/gemini-cli` | `gemini` |
| Grok Build | [x.ai/cli](https://x.ai/cli) | `grok login` |
| Local models | [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai) or `llama-server` | none |
| API keys | Anthropic, OpenAI, xAI, Google, OpenRouter and more | Agents page in the app |

**3. Say what you want done** and press Enter.

## How it works

### Rooms

A room has a goal, a crew and a folder. Without a folder, Lunchbox makes one inside `Documents/Lunchbox`, named after what you asked for.

| | |
| --- | --- |
| **Main agent** | The first agent in the crew answers everything you do not address to someone else. Change it with Make main in the agent menu, or in Settings for new rooms. |
| **Bringing others in** | The main agent can ask a crewmate a question, or bring one in for a piece of work. A line in the room says who joined and why, and another says when it stepped out. Writing `@codex` yourself brings Codex in the same way. |
| **Memory** | The brief, answers between agents, changed files and anything you pin are kept as versioned blocks. An agent is sent only the blocks that changed since it last looked. |
| **Proof** | When an agent says the build works, Lunchbox looks for a matching command that exited 0 after the last edit. If there isn't one, you decide what happens next. |
| **Side by side** | Send one message to the whole crew and keep the answer you like. Your picks rate the agents per kind of work. |
| **Rewind** | The folder is saved before every message, so any change can be undone. Rooms can be forked, replayed and exported. |

### Access

You choose the mode per message, in the composer.

| Mode | Agents can | Commands you run with `!` |
| --- | --- | --- |
| Plan | Read only | Reads run, the rest is refused |
| Ask | Read freely, edits wait for you | Anything that writes asks first |
| Auto | Edit and run inside the folder | Free inside the folder, outside asks |
| Full access | Anything on the computer, without asking | Free, except wiping the disk or the home folder |

Some commands never run in any mode, such as `rm -rf ~`. The rules live in [`electron/policy.ts`](electron/policy.ts) and have their own tests.

### Pool, Savings, Packs and Flows

- **Pool** adds up your plans and keys: what is left in each five hour and weekly window, when it resets, and which agent your picks rate highest for each kind of work.
- **Savings** shows what prompt caching saved, per agent and per room.
- **Packs** give a room instructions for one kind of work, such as software, research, SEO or writing. See [docs/packs.md](docs/packs.md) to write your own.
- **Flows** run a few steps on a schedule, each in a room of its own.

## Your data

Everything stays on your computer.

| What | Where |
| --- | --- |
| Rooms, settings and usage | `~/Library/Application Support/Lunchbox` on macOS, `%APPDATA%\Lunchbox` on Windows, `~/.config/Lunchbox` on Linux |
| API keys | The system keychain |
| Agent logins | With each tool, untouched |

Each room is one `.jsonl` file you can open in any editor. Plan limits are read with the login each tool already has, and that login only goes to the company that issued it. You can turn this off in Settings.

## Development

You need [Node 24](https://nodejs.org).

```sh
git clone https://github.com/noah-thing/lunchbox.git
cd lunchbox
npm install
npm run dev         # Vite and Electron with hot reload
npm test            # policy rules, parsers, caching, limits and full rooms run with fake agents
npm run typecheck
npm run tour        # drives the real app and saves screenshots to test/shots
npm run dist        # installers for the current platform in release/
```

CI runs the type check, tests and build on macOS, Windows and Linux for every pull request. [CONTRIBUTING.md](CONTRIBUTING.md) explains how changes are made and [docs/architecture.md](docs/architecture.md) how the code is laid out.

## Made by

<a href="https://x.com/fsconfig">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/maker-dark.png">
    <img alt="Noah, @fsconfig on X" src=".github/assets/maker-light.png" width="157" height="64">
  </picture>
</a>

## License

Copyright © 2026 noah-thing. All rights reserved.

Agent marks come from [Lobe Icons](https://github.com/lobehub/lobe-icons) under the MIT license, see [licenses/lobe-icons.txt](licenses/lobe-icons.txt). The llama.cpp, Aider and Crush marks come from those projects' own files, and the terminal and server icons from [Phosphor](https://phosphoricons.com) under the MIT license, see [licenses/phosphor-icons.txt](licenses/phosphor-icons.txt). Product names and logos belong to their owners.
