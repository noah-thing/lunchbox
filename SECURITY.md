# Security

Lunchbox runs agents that can read files and run commands, so the rules about what they may do matter.

## Reporting

Please don't open a public issue for a security problem. Use **Security → Report a vulnerability** on this repository. You'll get a reply within a few days.

Examples worth reporting:

- A command that runs in a mode that should refuse it
- A way for an agent to reach outside its folder in Plan, Ask or Auto
- API keys or logins leaving the computer, other than to the company that issued them

## How Lunchbox handles secrets

- API keys are sealed with the system keychain through Electron's safe storage.
- Agent logins stay with each tool. For plan limits, Lunchbox reads them and sends them only to the company that issued them. This can be turned off in Settings.
- Rooms, settings and usage are stored locally and never uploaded.
