# Contributing

Thanks for taking the time. Changes go through pull requests on this repository.

## Setup

```sh
npm install
npm run dev
```

You need Node 24. The tests and `npm run tour` use a fake agent in `test/fake-agent.mjs` that prints the same stream formats as Claude Code, Codex and Grok, so you can work on rooms without real agents.

## Before you open a pull request

```sh
npm run typecheck
npm test
```

CI runs both, plus the build, on macOS, Windows and Linux. If you change anything on screen, run `npm run tour` and look at the screenshots in `test/shots`.

## Guidelines

- **Policy lives in the main process.** Anything about what an agent may do belongs in `electron/policy.ts`, with a test in `scripts/test-policy.mjs`.
- **Real data on screen.** Screens show what the app knows, and a button does what its label says.
- **Three platforms.** Paths, shells and processes go through `electron/system.ts`.
- **Plain words.** Keep interface text short and direct, without em dashes.
- **Small commits** that say what changed and why.

## Reporting a problem

Open an issue with what you did, what you expected and what happened. Screenshots help. For anything that could expose keys or let an agent do more than its mode allows, see [SECURITY.md](SECURITY.md) instead.
