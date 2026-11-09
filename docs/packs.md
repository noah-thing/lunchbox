# Packs

A pack sets a room up for one kind of work. It adds a brief to each agent's instructions and suggests ideas to start from, and it can add checks you run from `/` in the composer. Lunchbox comes with packs for Software, Research, SEO, Writing, Data, Design, Growth, Security and Learning.

A pack is a small JSON file:

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

| Field | What it does |
| --- | --- |
| `id` | Unique, lowercase |
| `name`, `line` | How the pack shows up in the app |
| `brief` | Added to the instructions of each agent in a room that uses the pack |
| `ideas` | Starting points shown on the home screen |
| `checks` | Commands you can run from `/`; a passing check also counts as proof |

Add one from **Library → Packs**, from a file or from a link such as a GitHub gist. Share yours the same way.
