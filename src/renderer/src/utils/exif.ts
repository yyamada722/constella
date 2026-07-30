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
    if (size < 2) return 1 // malformed length would loop forever
    // Every read below is bounded by this segment, not by the buffer: a segment
    // with an understated length would otherwise let us reinterpret the bytes of
    // whatever follows as EXIF and report a rotation from garbage.
    const segmentEnd = off + 2 + size
    if (segmentEnd > view.byteLength) return 1 // truncated — neither trustworthy nor skippable

    // APP1 = "Exif\0\0" + a TIFF header whose IFD0 holds tag 0x0112. A file can
    // carry several APP1 segments (Adobe tools often write XMP first), so a
    // non-Exif one is skipped rather than ending the scan.
    if (marker === 0xffe1 && off + 10 <= segmentEnd && view.getUint32(off + 4) === 0x45786966 && view.getUint16(off + 8) === 0) {
      const tiff = off + 10
      if (tiff + 8 > segmentEnd) return 1
      const order = view.getUint16(tiff)
      if (order !== 0x4949 && order !== 0x4d4d) return 1 // neither "II" nor "MM"
      const le = order === 0x4949
      if (view.getUint16(tiff + 2, le) !== 0x002a) return 1 // TIFF magic
      const ifd = tiff + view.getUint32(tiff + 4, le)
      if (ifd < tiff + 8 || ifd + 2 > segmentEnd) return 1
      const n = view.getUint16(ifd, le)
      for (let i = 0; i < n; i++) {
        const entry = ifd + 2 + i * 12
        if (entry + 12 > segmentEnd) break
        if (view.getUint16(entry, le) === 0x0112) {
          // Orientation is defined as a single SHORT in 1..8; anything else is
          // corrupt, and rotating by it would be worse than leaving it alone.
          const wellFormed = view.getUint16(entry + 2, le) === 3 && view.getUint32(entry + 4, le) === 1
          const value = view.getUint16(entry + 8, le)
          return wellFormed && value >= 1 && value <= 8 ? value : 1
        }
      }
      return 1
    }
    off = segmentEnd
  }
  return 1
}
