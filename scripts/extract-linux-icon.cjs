// build/icon.icns の ic10 チャンク（1024x1024 PNG）を抽出して build/icon.png に書き出す。
// ICNS は単純な TLV 構造（4byteタイプ + 4byte長(BE) + データ）で、ic07〜ic10 は
// PNG データがそのまま埋め込まれているため、mac専用ツール(iconutil等)なしに抽出できる。
// アイコンを更新した際はこのスクリプトを再実行して build/icon.png も更新すること。
const fs = require('node:fs')
const path = require('node:path')

const ICNS_PATH = path.join(__dirname, '..', 'build', 'icon.icns')
const OUT_PATH = path.join(__dirname, '..', 'build', 'icon.png')
const PREFERRED_TYPES = ['ic10', 'ic09', 'ic14', 'ic08']

const data = fs.readFileSync(ICNS_PATH)
if (data.toString('latin1', 0, 4) !== 'icns') {
  throw new Error(`${ICNS_PATH} is not a valid ICNS file`)
}

const chunks = new Map()
let pos = 8
while (pos < data.length) {
  const type = data.toString('latin1', pos, pos + 4)
  const length = data.readUInt32BE(pos + 4)
  chunks.set(type, data.subarray(pos + 8, pos + length))
  pos += length
}

const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chosenType = PREFERRED_TYPES.find(t => chunks.has(t) && chunks.get(t).subarray(0, 8).equals(pngSig))
if (!chosenType) {
  throw new Error(`No PNG-format icon chunk found in ${ICNS_PATH}`)
}

fs.writeFileSync(OUT_PATH, chunks.get(chosenType))
console.log(`wrote ${OUT_PATH} from ${chosenType} chunk (${chunks.get(chosenType).length} bytes)`)
