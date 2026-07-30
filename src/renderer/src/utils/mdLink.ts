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

// `<` and `>` are legal in POSIX filenames, and an angle-bracket destination
// cannot carry them literally — the closing `>` would land early. Percent-escape
// just those two (plus `%` itself, so the mapping stays reversible) and undo it
// when parsing. Deliberately narrow: paths written before this encoding existed
// are stored raw, and a broad decode would corrupt any that legitimately contain
// a `%XX`-looking run.
function encodeDest(dest: string): string {
  // `%` first, so the escapes introduced below are not escaped again.
  return dest.replace(/%/g, '%25').replace(/</g, '%3C').replace(/>/g, '%3E')
}

function decodeDest(dest: string): string {
  // One left-to-right pass, so "%253C" yields the literal "%3C" and not "<".
  return dest.replace(/%(25|3C|3E)/g, (_, code: string) => (code === '25' ? '%' : code === '3C' ? '<' : '>'))
}

/** Destination captured by {@link createMdLinkRe}, whichever form matched. */
export function mdLinkHref(m: RegExpExecArray | RegExpMatchArray): string {
  const dest = m[2] ?? m[3] ?? ''
  // Only our own schemes are decoded; an http URL's %3C is part of the URL.
  return dest.startsWith('local:') ? decodeDest(dest) : dest
}

/** Escape what a destination can't hold, and bracket it when a bare one won't do. */
export function mdLinkDest(dest: string): string {
  const escaped = encodeDest(dest)
  return /[\s()]/.test(escaped) ? `<${escaped}>` : escaped
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
