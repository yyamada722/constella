// Inline markdown link parsing shared by the itinerary renderer, the plan PDF
// exporter and the link-inserting UI, so all three agree on what an attachment
// link looks like.
//
// A *bare* destination — `[a](local:C:\x.pdf)` — cannot contain whitespace, which
// meant an entirely ordinary server path (`C:\Trip Files\ticket.pdf`,
// `/Volumes/Asset Shoot/ticket.pdf`) silently rendered as plain text and never
// reached the attachment/別紙 machinery. CommonMark's angle-bracket destination
// (`[a](<local:C:\Trip Files\ticket.pdf>)`) carries spaces verbatim, so that is
// what we insert; both forms are accepted when parsing, since links written
// before this existed are still bare.

/**
 * Fresh matcher for `[label](dest)` / `[label](<dest>)`.
 *
 * A new instance per call because callers drive `lastIndex` — a shared /g regex
 * would leak position between them.
 */
export function createMdLinkRe(): RegExp {
  return /\[([^\]\n]+)\]\((?:<([^<>\n]*)>|([^)\s]*))\)/g
}

/** Destination captured by {@link createMdLinkRe}, whichever form matched. */
export function mdLinkHref(m: RegExpExecArray | RegExpMatchArray): string {
  return m[2] ?? m[3] ?? ''
}

/** Wrap a destination in angle brackets when a bare one could not hold it. */
export function mdLinkDest(dest: string): string {
  return /[\s()<>]/.test(dest) ? `<${dest}>` : dest
}

/** Ready-to-insert markdown link with a destination that survives round-tripping. */
export function mdLink(label: string, dest: string): string {
  return `[${label}](${mdLinkDest(dest)})`
}

/**
 * Undo the percent-encoding markdown renderers apply to hrefs.
 *
 * Needed only when reading an href back out of rendered DOM (marked and remark
 * both run destinations through `encodeURI`); text parsed straight from the
 * source markdown is already literal. Malformed escapes are left alone so a path
 * that legitimately contains `%` is never mangled.
 */
export function decodeMdHref(href: string): string {
  try { return decodeURIComponent(href) } catch { return href }
}
