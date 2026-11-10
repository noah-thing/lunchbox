import { accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'

// The parts of the Mac updater that need no Electron, so the tests can load them.

export type Asset = { url: string; sha512: string; size: number }
export type Feed = { version: string; files: Asset[] }

// latest-mac.yml as electron-builder writes it. Only the fields used here are read.
export function parseFeed(text: string): Feed | null {
  const version = text.match(/^version:\s*['"]?([^'"\s]+)/m)?.[1]
  if (!version) return null
  const files: Asset[] = []
  for (const block of text.split(/^\s*-\s+url:/m).slice(1)) {
    const url = block.match(/^\s*['"]?([^'"\s]+)/)?.[1]
    const sha512 = block.match(/^\s*sha512:\s*['"]?([^'"\s]+)/m)?.[1]
    const size = Number(block.match(/^\s*size:\s*(\d+)/m)?.[1])
    if (url && sha512 && size) files.push({ url, sha512, size })
  }
  return { version, files }
}

// The zip built for this Mac's chip. An Intel build would run on Apple silicon only through
// Rosetta, so the chip has to match.
export function pick(feed: Feed, arch = process.arch): Asset | undefined {
  const chip = arch === 'arm64' ? 'arm64' : 'x64'
  return feed.files.find((f) => f.url.endsWith('.zip') && f.url.includes(`-mac-${chip}.`))
}

// The swap needs to replace the bundle where it lies. An app run from the disk image, or moved
// somewhere read-only by Gatekeeper, cannot update itself; the person gets the download instead.
export function canReplace(bundle: string) {
  if (!bundle.endsWith('.app') || /\/AppTranslocation\/|^\/Volumes\//.test(bundle)) return false
  try {
    accessSync(dirname(bundle), constants.W_OK)
    accessSync(bundle, constants.W_OK)
    return true
  } catch {
    return false
  }
}
