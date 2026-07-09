// Image intake helpers — widen the set of loadable image formats.
//
// Chromium's <img> natively renders png / jpeg / gif / webp / avif / bmp / ico /
// svg, so those "just work" once the picker/drop filters let them through. TIFF
// and TGA are NOT supported by <img>, so we decode them to PNG on load (TIFF via
// utif, TGA via the small decoder below) and hand the rest of the app a normal,
// renderable blob.
import * as UTIF from 'utif'

// Extensions treated as images even when the OS supplies no/oddball MIME type
// (common for .tga, sometimes .tif). Used by the drag-drop / file-input guards.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|tga)$/i

// File-input `accept` — image/* plus explicit tif/tga so those still surface in
// dialogs that filter strictly by MIME (TGA usually has an empty type).
export const IMAGE_ACCEPT = 'image/*,.tif,.tiff,.tga'

// True for anything we can load (native or via decode). Accepts by MIME first,
// then by extension (covers empty-MIME .tga / .tif dropped from disk).
export function isImageFile(f: { type?: string; name?: string }): boolean {
  return (!!f.type && f.type.startsWith('image/')) || (!!f.name && IMAGE_EXT.test(f.name))
}

function decodeKind(type: string, name: string): 'tiff' | 'tga' | null {
  if (/tiff?/i.test(type) || /\.tiff?$/i.test(name)) return 'tiff'
  if (/tga|targa/i.test(type) || /\.tga$/i.test(name)) return 'tga'
  return null
}

async function rgbaToPng(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Promise<Blob> {
  if (!w || !h) throw new Error('bad image dimensions')
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const img = ctx.createImageData(w, h)
  img.data.set(rgba.subarray(0, w * h * 4))
  ctx.putImageData(img, 0, 0)
  return await new Promise<Blob>((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'))
}

async function decodeTiff(file: Blob): Promise<Blob> {
  const buf = await file.arrayBuffer()
  const ifds = UTIF.decode(buf)
  if (!ifds.length) throw new Error('empty tiff')
  UTIF.decodeImage(buf, ifds[0], ifds)
  const rgba = UTIF.toRGBA8(ifds[0])
  return rgbaToPng(rgba, ifds[0].width, ifds[0].height)
}

// Compact TGA decoder: truecolor (24/32-bit) + grayscale (8-bit), uncompressed
// (types 2/3) and RLE (types 10/11). Colormapped TGA (rare) is unsupported and
// falls back to the raw file via normalizeImageBlob's catch.
async function decodeTga(file: Blob): Promise<Blob> {
  const d = new Uint8Array(await file.arrayBuffer())
  const idLen = d[0]
  const cmType = d[1]
  const imgType = d[2]
  const w = d[12] | (d[13] << 8)
  const h = d[14] | (d[15] << 8)
  const depth = d[16]
  const desc = d[17]
  const topLeft = (desc & 0x20) !== 0
  if (cmType !== 0) throw new Error('tga colormap unsupported')
  if (![2, 3, 10, 11].includes(imgType)) throw new Error(`tga type ${imgType} unsupported`)
  if (![8, 24, 32].includes(depth)) throw new Error(`tga depth ${depth} unsupported`)
  const bpp = depth >> 3
  const n = w * h
  let p = 18 + idLen // skip header + image id (color map absent when cmType===0)
  const px = new Uint8Array(n * bpp) // file-order pixels: BGR(A) or gray
  if (imgType < 9) {
    px.set(d.subarray(p, p + n * bpp))
  } else {
    // RLE: high bit of the packet header = run, low 7 bits = count-1.
    let o = 0
    while (o < n) {
      const hdr = d[p++]
      const count = (hdr & 0x7f) + 1
      if (hdr & 0x80) {
        for (let i = 0; i < bpp; i++) { const v = d[p + i]; for (let c = 0; c < count; c++) px[(o + c) * bpp + i] = v }
        p += bpp
      } else {
        px.set(d.subarray(p, p + count * bpp), o * bpp)
        p += count * bpp
      }
      o += count
    }
  }
  const rgba = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    let r: number, g: number, b: number, a: number
    if (depth === 8) { const v = px[i]; r = g = b = v; a = 255 }
    else { b = px[i * bpp]; g = px[i * bpp + 1]; r = px[i * bpp + 2]; a = depth === 32 ? px[i * bpp + 3] : 255 }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a
  }
  // TGA's default origin is bottom-left; flip to canvas' top-left unless flagged.
  let out = rgba
  if (!topLeft) {
    out = new Uint8ClampedArray(n * 4)
    const row = w * 4
    for (let y = 0; y < h; y++) { const src = (h - 1 - y) * row; out.set(rgba.subarray(src, src + row), y * row) }
  }
  return rgbaToPng(out, w, h)
}

// Convert a picked/dropped image into a browser-renderable blob. TIFF/TGA become
// PNG; native formats pass through untouched. Any decode failure falls back to the
// original file (so a native attempt still happens rather than losing the image).
export async function normalizeImageBlob(file: File | Blob): Promise<Blob> {
  const kind = decodeKind((file as File).type || '', (file as File).name || '')
  if (!kind) return file
  try {
    return kind === 'tiff' ? await decodeTiff(file) : await decodeTga(file)
  } catch (e) {
    console.warn('image decode failed; using original file', e)
    return file
  }
}
