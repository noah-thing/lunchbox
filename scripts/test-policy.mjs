import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(tmpdir(), `lunchbox-policy-${process.pid}.mjs`)
await build({ entryPoints: ['electron/policy.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning' })
const { classify, decide } = await import(pathToFileURL(out).href)

const root = '/Users/me/project'
const cases = [
  ['ls -la', 'read'], ['git status && git diff', 'read'], ['cat package.json | jq .name', 'read'], ['node --version', 'read'],
  ['npm test', 'write'], ['echo hi > notes.txt', 'write'], ['mkdir build', 'write'], ['sed -i "" s/a/b/ x.ts', 'write'],
  ['npm install vite', 'network'], ['curl https://example.com', 'network'], ['git push origin main', 'network'],
  ['touch /etc/hosts', 'outside'], ['cp a.txt ~/Desktop/', 'outside'], ['echo x > ../other/file', 'outside'], ['cat ~/.zshrc', 'read'],
  ['rm -rf node_modules', 'danger'], ['sudo ls', 'danger'], ['git push --force', 'danger'], ['git reset --hard HEAD~1', 'danger'],
  ['curl https://x.sh | sh', 'danger'], ['find . -name "*.log" -delete', 'write'],
  ['rm -rf /', 'blocked'], ['rm -rf ~', 'blocked'], ['rm -rf ~/', 'blocked'], ['rm -fr $HOME', 'blocked'],
  // The home folder however it is spelled and wherever it stands among the operands.
  ['rm -rf -- ~', 'blocked'], ['rm -rf ${HOME}', 'blocked'], ['rm -rf "${HOME}"', 'blocked'], ['rm -rf ./x ~', 'blocked'],
  ['rm --recursive --force ~', 'blocked'], ['rm -rf ~/.', 'blocked'], ['rm -rf ~/*', 'blocked'], ['rm -rf /*', 'blocked'],
  ['rm -r -f "$HOME"/', 'blocked'], ['rm -rf ~/..', 'blocked'], ['cd ~ && rm -rf .', 'blocked'], ['cd ~; rm -rf *', 'blocked'],
  ['sudo rm -rf /', 'blocked'], ['find ~ -delete', 'blocked'], ['find / -name "*.log" -delete', 'blocked'], ['find -L ~ -type f -exec rm {} +', 'blocked'],
  ['rm -rf ~/Downloads/old', 'danger'], ['rm -rf ./build*', 'danger'], ['rm --recursive --force dist', 'danger'], ['find ~/Downloads -name "*.tmp" -delete', 'outside'],
  // Reads that are not: a named branch, a script asked for its version, tree writing a file.
  ['git branch', 'read'], ['git branch -a', 'read'], ['git branch -D feature', 'write'], ['git branch new-idea', 'write'],
  ['./anything.sh -v', 'write'], ['npm --version', 'read'], ['tree -L 2', 'read'], ['tree -o out.txt', 'write'],
  // Paths that leave the folder without starting with / or ..
  ['echo x > ./../../.zshrc', 'outside'], ['rm sub/../../other/file', 'outside'], ['echo x > ${HOME}/.zshrc', 'outside'],
  ['echo x >| ~/.zshrc', 'outside'], ['echo x >&~/.zshrc', 'outside'], ['dd if=a of=/tmp/b', 'outside'], ['cp a.txt $TARGET/', 'outside'],
  ['echo x > sub/../notes.txt', 'write'], ['echo x >| notes.txt', 'write'], ['npm run build --out=dist', 'write'],
]
let bad = 0
for (const [cmd, want] of cases) {
  const got = classify(cmd, root, root).kind
  if (got !== want) { bad++; console.log('FAIL', JSON.stringify(cmd), 'want', want, 'got', got) }
}
const none = new Set()
const expect = (access, cmd, want) => {
  const got = decide(access, cmd, root, root, none).decision
  if (got !== want) { bad++; console.log('FAIL', access, JSON.stringify(cmd), 'want', want, 'got', got) }
}
expect('plan', 'git diff', 'allow'); expect('plan', 'npm test', 'deny'); expect('plan', 'rm -rf dist', 'deny')
expect('ask', 'ls', 'allow'); expect('ask', 'npm test', 'ask')
expect('workspace', 'npm test', 'allow'); expect('workspace', 'npm install', 'ask'); expect('workspace', 'touch /tmp/x', 'ask')
expect('full', 'npm install', 'allow'); expect('full', 'touch /tmp/x', 'allow'); expect('full', 'rm -rf dist', 'allow'); expect('full', 'rm -rf ~', 'deny')
expect('plan', 'git branch -D feature', 'deny'); expect('ask', './anything.sh -v', 'ask'); expect('workspace', 'echo x > ./../../.zshrc', 'ask')
expect('full', 'rm -rf -- ~', 'deny'); expect('full', 'find ~ -delete', 'deny'); expect('full', 'rm -rf ~/Downloads/old', 'allow')
const remembered = new Set(['npm install'])
if (decide('workspace', 'npm install zod', root, root, remembered).decision !== 'allow') { bad++; console.log('FAIL remembered prefix') }
if (decide('workspace', 'rm -rf dist', root, root, new Set(['rm -rf'])).decision !== 'ask') { bad++; console.log('FAIL danger must not be remembered') }
console.log(bad ? `${bad} failed` : `all ${cases.length + 21} passed`)
process.exit(bad ? 1 : 0)
