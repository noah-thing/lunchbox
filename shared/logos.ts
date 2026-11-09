import type { Connector } from './types'

// A connector wears its product's logo when the address or command says which product it is,
// and a terminal or a server when it is something of the person's own.
const LOGOS: [RegExp, string][] = [
  [/openrouter\.ai/, 'openrouter'], [/generativelanguage\.googleapis|aistudio/, 'gemini'], [/models\.github|github\.ai/, 'github'], [/nvidia\.com/, 'nvidia'],
  [/deepseek/, 'deepseek'], [/groq\.com/, 'groq'], [/mistral\.ai/, 'mistral'], [/together\.(xyz|ai)/, 'together'], [/fireworks\.ai/, 'fireworks'],
  [/cerebras/, 'cerebras'], [/moonshot|kimi/, 'kimi'], [/deepinfra/, 'deepinfra'], [/perplexity/, 'perplexity'], [/anthropic|claude/, 'claude'],
  [/openai\.com/, 'openai'], [/x\.ai\b/, 'grok'], [/:11434|ollama/, 'ollama'], [/:1234\b|lmstudio/, 'lmstudio'], [/llama|:8080\b/, 'llamacpp'],
  [/^opencode\b/, 'opencode'], [/^qodercli\b|^qoder\b/, 'qoder'], [/^crush\b/, 'crush'], [/^aider\b/, 'aider'], [/^goose\b/, 'goose'],
  [/^cursor-agent\b|^cursor\b/, 'cursor'], [/^qwen\b/, 'qwen'], [/^amp\b/, 'amp'], [/^claude\b/, 'claude'], [/^codex\b/, 'codex'], [/^gemini\b/, 'gemini'], [/^grok\b/, 'grok'],
]
export function logoOf(c: Partial<Pick<Connector, 'kind' | 'base' | 'command'>>) {
  const where = c.kind === 'cli' ? (c.command ?? '').trim().replace(/^.*[\\/]/, '').toLowerCase() : (c.base ?? '').toLowerCase()
  return LOGOS.find(([re]) => re.test(where))?.[1] ?? (c.kind === 'cli' ? 'terminal' : c.kind === 'anthropic' ? 'claude' : 'server')
}
