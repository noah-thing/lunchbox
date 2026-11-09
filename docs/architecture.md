# Architecture

Lunchbox is an Electron app. The main process runs the agents and owns every rule about what they may do. The renderer is React and only draws what the main process sends it.

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
  room/proof.ts     claims checked against the command history
shared/             types, prices, routing and plan parsing used by both sides
src/                the React renderer
test/               unit tests, recorded CLI output and the fake agent
```

## A turn

1. You send a message. It goes to the room's main agent, the first in the crew, unless you name someone with `@`.
2. `room/context.ts` builds the prompt: the stable part first (instructions, then the conversation), the new part last, so providers can reuse the start from cache.
3. The agent runs as its own CLI, or over HTTP for API keys and local models. Its stream is parsed into text, commands, file edits and usage.
4. The main agent can ask a crewmate a question or bring one in for a task, through its tools or a line like `@grok: question`. A crewmate that joins gets a briefing (the brief, shared memory, changed files and its task), never the transcript. Its answer goes into shared memory and the main agent continues.
5. Claims such as "the tests pass" are checked against commands that exited 0 after the last edit.
6. Usage is written to the ledger, which feeds Pool and Savings.

## Data

Each room is one `.jsonl` file of events in the app's user data folder. Settings, the ledger and plan readings sit next to them as JSON. Nothing is sent anywhere except to the agents themselves and, for plan limits, to the company that issued each login.
