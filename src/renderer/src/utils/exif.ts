// Minimal JPEG metadata reading. Kept separate from its callers so it stays a
// pure byte parser with no DOM or PDF dependencies.

/**
 * EXIF Orientation of a JPEG: 1 means the stored pixels are already upright,
 * which is also what we return for anything we cannot parse.
 *
 * Matters because consumers that hand JPEG bytes straight to something with no
 * notion of EXIF (a PDF image XObject, say) would otherwise render a portrait
 * phone photo rotated.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1 // not a JPEG
  let off = 2
  while (off + 4 <= view.byteLength) {
    const marker = view.getUint16(off)
    if ((marker & 0xff00) !== 0xff00) return 1 // desynced — give up
    if (marker === 0xffda) return 1 // start of scan; no EXIF before the pixels
    const size = view.getUint16(off + 2)
    // APP1 = "Exif\0\0" + a TIFF header whose IFD0 holds tag 0x0112. A file can
    // carry several APP1 segments (Adobe tools often write XMP first), so a
    // non-Exif one is skipped rather than ending the scan.
    if (marker === 0xffe1 && off + 10 <= view.byteLength && view.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10
      if (tiff + 8 > view.byteLength) return 1
      const le = view.getUint16(tiff) === 0x4949
      const ifd = tiff + view.getUint32(tiff + 4, le)
      if (ifd + 2 > view.byteLength) return 1
      const n = view.getUint16(ifd, le)
      for (let i = 0; i < n; i++) {
        const entry = ifd + 2 + i * 12
        if (entry + 12 > view.byteLength) break
        if (view.getUint16(entry, le) === 0x0112) return view.getUint16(entry + 8, le)
      }
      return 1
    }
    if (size < 2) return 1 // malformed length would loop forever
    off += 2 + size
  }
  return 1
}
