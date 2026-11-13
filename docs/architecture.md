# Architecture

Lunchbox is an Electron app. The main process runs the agents and holds the rules about what they may do. The renderer, in React, draws what the main process sends it.

## Layout

```
electron/
  main.ts           window, IPC, keychain
  store.ts          rooms as JSONL logs that only grow, settings, the usage ledger
  system.ts         PATH, shells and processes on each platform
  policy.ts         what each access mode lets a command do
  shell.ts          `!` commands and proof checks
  limits.ts         plan windows read from each provider
  tally.ts          token and cost totals from each tool's own logs
  local.ts          Ollama, LM Studio and llama.cpp: find, start, download
  agents/           one parser per stream format, CLI and HTTP runners
  room/engine.ts    turns, the main agent, bringing others in, limits, memory, proof, side by side
  room/kit.ts       the tools one agent can use to reach another during its turn
  room/context.ts   what each agent is sent (the conversation or a briefing), ordered for prompt caching
  room/trim.ts      long command output cut to its start, its end and the lines that look like problems
  room/proof.ts     claims checked against the command history
shared/             types, prices, routing and plan parsing used by both sides
src/                the React renderer
test/               unit tests, recorded CLI output and the fake agent
```

## A turn

1. You send a message. It goes to the room's main agent, the first in the crew, unless you name someone with `@`.
2. `room/context.ts` builds the prompt with the stable part first (instructions, then the conversation) and the new part last, so providers can reuse the start from cache. A crewmate that joins gets a briefing in place of the conversation.
3. The agent runs as its own CLI, or over HTTP for API keys and local models. A parser turns its stream into text, commands, file edits and usage.
4. The main agent can ask a crewmate a question or bring one in for a task, through its tools or a line like `@grok: question`. Lunchbox sends the crewmate a briefing with the brief, shared memory, changed files and its task. The answer goes into shared memory and the main agent carries on.
5. The engine checks claims such as "the tests pass" against commands that exited 0 after the last edit.
6. The engine writes usage to the ledger, which Pool and Savings read.

## Saving

Three things lower what a turn costs. Each one is counted on its own turn in the ledger, apart from what the agent's own prompt caching saved.

- **Shortened command output.** `hands.ts` answers a Claude Code hook before each command. A command that only logs and ends by itself, such as a test run, a build or an install, runs with its output going to a file, and `room/trim.ts` keeps the start, the end and the lines that look like problems. The agent gets that and the path of the file. Commands that print content, such as `cat`, `git diff` or a search, are never touched. Neither is a dev server or a watcher, or any command in Plan or Ask.
- **Cache lifetime.** Claude Code on a subscription stores its cache for an hour, which costs twice the input price to write. A session nobody is waiting on, a flow or a crewmate called for one job, stores for five minutes at 1.25 times instead. The lifetime is chosen when a session starts and kept, because a request asking for one lifetime does not find entries written for the other. For a session a person talks to, the engine reads it once more just before its cache runs out, in a copy of the session that is thrown away, so the next message finds it cached. The reads for one pause never add up to more than a fifth of what a cold start would cost.
- **Not sent twice.** A resumed session gets only the memory that changed, and a crewmate gets a briefing instead of the conversation.

`npm run bench` runs the same tasks in plain Claude Code and in a room and prints what each cost. It uses real agents and real usage.

## Data

Each room is one `.jsonl` file of events in the app's user data folder. Settings, the ledger and plan readings sit next to them as JSON. Lunchbox sends data to the agents you use, to the company behind each login when it reads plan limits, and to a private repository when you send a bug report.
