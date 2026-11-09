# Architecture

Lunchbox is an Electron app. The main process runs the agents and owns every rule about what they may do. The renderer is React and only draws what the main process sends it.

## Layout

```
electron/
  main.ts           window, IPC, keychain
  store.ts          rooms as append-only JSONL, settings, the usage ledger
  system.ts         PATH, shells and processes on each platform
  policy.ts         what each access mode lets a command do
  shell.ts          `!` commands and proof checks
  limits.ts         plan windows read from each provider
  tally.ts          token and cost totals from each tool's own logs
  local.ts          Ollama, LM Studio and llama.cpp: find, start, download
  agents/           one parser per stream format, CLI and HTTP runners
  room/engine.ts    turns, handoffs, limits, memory, proof, side by side
  room/context.ts   what each agent is sent, ordered for prompt caching
  room/proof.ts     claims checked against the command history
shared/             types, prices, routing and plan parsing used by both sides
src/                the React renderer
test/               unit tests, recorded CLI output and the stand-in agent
```

## A turn

1. You send a message. The engine picks who leads, by kind of work and rating or by crew order.
2. `room/context.ts` builds the prompt: the stable part first (instructions, then the conversation), the new part last, so providers can reuse the start from cache.
3. The agent runs as its own CLI, or over HTTP for API keys and local models. Its stream is parsed into text, commands, file edits and usage.
4. Lines like `@grok: question` become handoffs. The answer goes into shared memory and the first agent continues.
5. Claims such as "the tests pass" are checked against commands that exited 0 after the last edit.
6. Usage is written to the ledger, which feeds Pool and Savings.

## Data

Each room is one `.jsonl` file of events in the app's user data folder. Settings, the ledger and plan readings sit next to them as JSON. Nothing is sent anywhere except to the agents themselves and, for plan limits, to the company that issued each login.
