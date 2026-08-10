// electron-builder の afterPack フック。
//
// 証明書なしの構成では electron-builder が署名工程をスキップするが、
// Electron 同梱バイナリの ad-hoc 署名はリブランド（Info.plist 書き換え・
// asar 組み込み）の時点で封印が壊れる。Apple Silicon のカーネルは有効な
// 署名（最低でも ad-hoc）を要求するため、壊れたままだと quarantine を
// 外しても起動できない。dmg に固める前に ad-hoc (-) で再署名して封印し直す。
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSignForMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  // 実証明書で署名する構成（将来 Developer ID を入れた場合）では何もしない
  if (process.env.CSC_LINK || process.env.CSC_NAME) return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`  • ad-hoc signing  app=${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
