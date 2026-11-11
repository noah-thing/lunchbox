// Why an agent left a turn, in words a person can act on. The engine's reason is the tool's own
// error, already cleaned; this decides how to say it, so a refused key does not read as a crash.
export function wallWhy(from: string, reason: string) {
  if (/^(is |hit )/.test(reason)) return `${from} ${reason}`
  // Messages that already name the agent, such as "OpenCode is not installed on this computer".
  if (reason.toLowerCase().startsWith(from.toLowerCase())) return reason
  if (/\b40[13]\b|authentication fail|invalid (api )?key|incorrect api key|unauthori[sz]ed|invalid x-api-key/i.test(reason)) {
    return `${from} refused its API key (${reason.match(/\b40[13]\b/)?.[0] ?? 'not accepted'}). Check the key in Agents`
  }
  if (/already in use|is port \d+ in use|server process exited/i.test(reason)) {
    return `${from} could not start its background service, often because another copy of it is running. Close it and try again`
  }
  return `${from} stopped with an error: ${reason}`
}
