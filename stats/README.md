# Lunchbox install counter

A Cloudflare Worker that counts Lunchbox installs without knowing who anyone is.

Once a day, a copy of Lunchbox that has the count on sends one request with four things:

- a random ID it made on its first launch (not tied to you, your account or your machine)
- the Lunchbox version
- the system (macOS, Windows or Linux)
- the processor type (arm64 or x64)

The ID is hashed before it is stored. IP addresses are never stored and requests are not logged.
To stop one network from flooding the count, a one way hash of the address, salted with a secret
and the day, is kept for two days. Nothing about your rooms, agents, files, prompts or keys is ever
sent. Turn the count off in Lunchbox under Settings.

Deploy: `npx wrangler@4 d1 migrations apply lunchbox-stats --remote`, then `npx wrangler@4 deploy`.
The totals are at `/stats?key=...` for whoever holds STATS_KEY.
