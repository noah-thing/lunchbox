// Until Lunchbox has an Apple Developer ID, the Mac app is signed ad hoc. Electron's binary comes
// with a partial, linker-made signature that does not cover the app's resources; a downloaded app
// signed like that reads as "damaged and can't be opened", with no way past it. A whole ad-hoc
// signature turns that into the ordinary "could not verify" prompt, which Open Anyway clears.
// Runs after the app is packed and before the dmg and zip are made, and stops the build if the
// signature does not verify.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
