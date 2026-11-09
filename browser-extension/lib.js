// Constella アプリ (localhost) との通信と、未送信キュー。

// src/main/browserBridge.ts の PORTS と揃える。
const PORTS = [38947, 38948, 38949, 38950]
export const MAX_CLIP_BYTES = 100 * 1024 * 1024

// offline: アプリ未起動 / unauthorized: 接続コード違い / rejected: アプリが内容を拒否
export class BridgeError extends Error {
  constructor(kind, message) {
    super(message || kind)
    this.kind = kind
  }
}

export const getStored = (keys) => chrome.storage.local.get(keys)
export const setStored = (obj) => chrome.storage.local.set(obj)

async function post(port, path, code, body, timeoutMs) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${code}` },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
}

async function findPort(code, preferred) {
  const order = preferred ? [preferred, ...PORTS.filter((p) => p !== preferred)] : PORTS
  let sawUnauthorized = false
  for (const port of order) {
    try {
      const res = await post(port, '/ping', code, undefined, 1200)
      const json = await res.json().catch(() => null)
      if (res.ok && json?.result?.app === 'constella') return port
      if (res.status === 401 && json?.app === 'constella') sawUnauthorized = true
    } catch { /* このポートには居ない */ }
  }
  throw new BridgeError(sawUnauthorized ? 'unauthorized' : 'offline')
}

async function request(path, body, timeoutMs) {
  const { code, port: cached } = await getStored(['code', 'port'])
  if (!code) throw new BridgeError('unauthorized')
  const port = await findPort(code, cached)
  if (port !== cached) await setStored({ port })
  let res
  try {
    res = await post(port, path, code, body, timeoutMs)
  } catch {
    throw new BridgeError('offline')
  }
  const json = await res.json().catch(() => null)
  if (res.status === 401) throw new BridgeError('unauthorized')
  // 503 = 起動直後でレンダラーの受付前。未起動と同じく後で再送できる。
  if (res.status === 503) throw new BridgeError('offline')
  if (!res.ok || !json?.ok) throw new BridgeError('rejected', json?.error || `エラー (${res.status})`)
  return json.result
}

export const checkCode = (code) => findPort(code)
export const rpc = (method, params) => request('/rpc', JSON.stringify({ method, params }), 25000)

export function sendSave(meta, clipBlob) {
  const head = new TextEncoder().encode(JSON.stringify(meta))
  const body = new Blob(clipBlob ? [head, clipBlob] : [head])
  return request(`/save?metaLength=${head.length}`, body, 120000)
}

// ── 未送信キュー (アプリ未起動のあいだ溜める。クリップは容量の都合で持たない) ──

async function readQueue() {
  return (await getStored(['queue'])).queue || []
}

export async function refreshBadge() {
  const n = (await readQueue()).length
  await chrome.action.setBadgeBackgroundColor({ color: '#6366f1' })
  await chrome.action.setBadgeText({ text: n ? String(n) : '' })
}

export async function enqueue(meta) {
  const queue = await readQueue()
  queue.push({ ...meta, description: meta.description.slice(0, 4000), dedupe: true, lenient: true })
  await setStored({ queue })
  await refreshBadge()
}

export async function flushQueue() {
  let queue = await readQueue()
  while (queue.length) {
    try {
      await sendSave(queue[0], null)
    } catch (e) {
      // アプリ未起動・接続コード違いは次回へ。内容の拒否は再送しても通らないので捨てる。
      if (e.kind !== 'rejected') break
    }
    queue = queue.slice(1)
    await setStored({ queue })
  }
  await refreshBadge()
}
