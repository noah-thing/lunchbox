# Security

Lunchbox runs agents that can read files and run commands. Please report any way around the rules that limit them.

## Reporting

Use **Security → Report a vulnerability** on this repository instead of a public issue. You'll get a reply within a few days.

Examples worth reporting:

- A command that runs in a mode that should refuse it
- A way for an agent to reach outside its folder in Plan, Ask or Auto
- API keys or logins leaving the computer, other than to the company that issued them

## How Lunchbox handles secrets

- Lunchbox seals API keys with the system keychain through Electron's safe storage.
- Agent logins stay with each tool. To show plan limits, Lunchbox reads them and sends them only to the company that issued them. You can turn this off in Settings.
- Lunchbox stores rooms, settings and usage on your computer and uploads none of it.
- A bug report you send goes to a private repository, with keys and your home folder path removed first.
