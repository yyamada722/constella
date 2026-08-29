import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // Base URL of the local server that serves the YouTube/Vimeo embed wrapper page
  // (gives the player a real http origin so it isn't rejected from file://).
  embedBase: (ipcRenderer.sendSync('embed:base') as string) || '',
  // SQLite database file persistence (handled in the main process)
  db: {
    load: (): Promise<Uint8Array | null> => ipcRenderer.invoke('db:load'),
    save: (bytes: Uint8Array): Promise<void> => ipcRenderer.invoke('db:save', bytes),
    reset: (): Promise<void> => ipcRenderer.invoke('db:reset'),
    // Corruption recovery: list candidate snapshots (.bak + rolling daily
    // backups, newest first) and read one back by its returned name.
    recoveryList: (): Promise<{ name: string; size: number; mtime: number }[]> => ipcRenderer.invoke('db:recovery-list'),
    loadRecovery: (name: string): Promise<Uint8Array | null> => ipcRenderer.invoke('db:load-recovery', name),
  },
  // A cheap version token (mtime-size) of the DB file, to detect when another
  // device (iPad over LAN) changed it and we should reload.
  dbEtag: (): Promise<string> => ipcRenderer.invoke('db:etag'),
  // LAN access (serve the app + data to external devices on the same network).
  remote: {
    status: (): Promise<{ enabled: boolean; port: number; urls: { label: string; url: string }[] }> => ipcRenderer.invoke('remote:status'),
    set: (on: boolean): Promise<{ enabled: boolean; port: number; urls: { label: string; url: string }[] }> => ipcRenderer.invoke('remote:set', on),
  },
  // Media proxy: serve this renderer's IndexedDB media blobs to remote clients.
  onRemoteMediaRequest: (cb: (reqId: string, id: string) => void): void => {
    ipcRenderer.on('remote:media-request', (_e, reqId: string, id: string) => cb(reqId, id))
  },
  replyRemoteMedia: (reqId: string, bytes: Uint8Array | null, mime?: string): void => {
    ipcRenderer.send('remote:media-reply', reqId, bytes, mime ?? '')
  },
  // 他マシンとの同期(同期フォルダ方式): フォルダ内ファイルの読み書きは main が担当し、
  // push/pull/競合の判定はレンダラー(persistence/folderSync.ts)が行う。
  sync: {
    get: (): Promise<unknown> => ipcRenderer.invoke('sync:get'),
    configure: (patch: { folder?: string | null; enabled?: boolean; deviceName?: string }): Promise<unknown> =>
      ipcRenderer.invoke('sync:configure', patch),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('sync:pick-folder'),
    setDirty: (dirty: boolean): Promise<void> => ipcRenderer.invoke('sync:set-dirty', dirty),
    inspect: (): Promise<unknown> => ipcRenderer.invoke('sync:inspect'),
    push: (gen: number, expectPrev: number): Promise<unknown> => ipcRenderer.invoke('sync:push', gen, expectPrev),
    // pull は prepare(長いフォルダ読み)→ commit(ローカルDB差し替え)の2段。
    // 間にレンダラーが「その間の編集」を確認できるようにするための分割。
    pullPrepare: (expectedGen: number, deadlineMs?: number): Promise<unknown> => ipcRenderer.invoke('sync:pull-prepare', expectedGen, deadlineMs),
    pullCommit: (expectedGen: number): Promise<unknown> => ipcRenderer.invoke('sync:pull-commit', expectedGen),
    pullDiscard: (): Promise<void> => ipcRenderer.invoke('sync:pull-discard'),
    pullUndo: (): Promise<{ ok: boolean; dbRestored?: boolean }> => ipcRenderer.invoke('sync:pull-undo'),
    // 競合の項目単位マージ用: base スナップショット / フォルダ側 DB の生バイト。
    readBase: (): Promise<Uint8Array | null> => ipcRenderer.invoke('sync:read-base'),
    readFolderDb: (): Promise<{ ok: boolean; error?: string; gen?: number; bytes?: Uint8Array; deviceName?: string }> =>
      ipcRenderer.invoke('sync:read-folder-db'),
    listRemoteMedia: (): Promise<string[]> => ipcRenderer.invoke('sync:list-remote-media'),
    backupMediaRefs: (): Promise<string[]> => ipcRenderer.invoke('sync:backup-media-refs'),
    readRemoteMedia: (name: string): Promise<{ bytes: Uint8Array; mime: string } | null> =>
      ipcRenderer.invoke('sync:read-remote-media', name),
    writeRemoteMedia: (id: string, bytes: Uint8Array, mime: string): Promise<boolean> =>
      ipcRenderer.invoke('sync:write-remote-media', id, bytes, mime),
    backupConflict: (source: 'local' | 'remote'): Promise<string | null> =>
      ipcRenderer.invoke('sync:backup-conflict', source),
  },
  // AI assistant — Anthropic Claude API proxied through main (key never enters the renderer).
  ai: {
    getSettings: (): Promise<{ hasKey: boolean; model: string }> => ipcRenderer.invoke('ai:get-settings'),
    setSettings: (s: { apiKey?: string; model?: string }): Promise<{ hasKey: boolean; model: string }> => ipcRenderer.invoke('ai:set-settings', s),
    chat: (
      streamId: string,
      opts: { system: string; messages: { role: 'user' | 'assistant'; content: string }[]; model?: string; maxTokens?: number },
      onChunk: (text: string) => void,
      onDone: (info: { stopReason: string | null; usage: unknown }) => void,
      onError: (msg: string) => void,
    ): (() => void) => {
      const chunkH = (_e: unknown, id: string, t: string) => { if (id === streamId) onChunk(t) }
      const doneH = (_e: unknown, id: string, info: { stopReason: string | null; usage: unknown }) => {
        if (id === streamId) { onDone(info); off() }
      }
      const errH = (_e: unknown, id: string, m: string) => { if (id === streamId) { onError(m); off() } }
      const off = () => {
        ipcRenderer.off('ai:chunk', chunkH)
        ipcRenderer.off('ai:done', doneH)
        ipcRenderer.off('ai:error', errH)
      }
      ipcRenderer.on('ai:chunk', chunkH)
      ipcRenderer.on('ai:done', doneH)
      ipcRenderer.on('ai:error', errH)
      ipcRenderer.send('ai:chat', streamId, opts)
      return off
    },
    cancel: (streamId: string): void => ipcRenderer.send('ai:cancel', streamId),
  },
  // Open a media card's stored bytes in the OS default app. `type` is the card
  // type, used main-side to force a safe file extension.
  openFile: (bytes: Uint8Array, name: string, type: string): Promise<void> => ipcRenderer.invoke('file:open-temp', bytes, name, type),
  // Local / server file references (`local:` refs): files stay on the NAS or the
  // local disk; the app stores only the path and reads bytes on demand.
  // 計画の PDF 書き出し: 印刷用 HTML → PDF 化と、保存ダイアログ経由の書き出し。
  pdf: {
    render: (
      html: string,
      margins: { top: number; bottom: number; left: number; right: number },
      opts?: { pageSizeInch?: { width: number; height: number } },
    ): Promise<Uint8Array> =>
      ipcRenderer.invoke('pdf:render-html', html, margins, opts),
    save: (bytes: Uint8Array, defaultName: string): Promise<boolean> => ipcRenderer.invoke('pdf:save', bytes, defaultName),
  },
  // 自動アップデート。mode='auto'(Winインストーラー版)は自動DL→installで再起動適用、
  // mode='notify'(mac/ポータブル/開発)は新版の存在を知らせてリリースページへ誘導する。
  update: {
    get: (): Promise<{ current: string; mode: 'auto' | 'notify'; state: unknown }> => ipcRenderer.invoke('update:get'),
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    install: (): void => ipcRenderer.send('update:install'),
    openPage: (): Promise<void> => ipcRenderer.invoke('update:open-page'),
    onState: (cb: (state: unknown) => void): (() => void) => {
      const h = (_e: unknown, s: unknown): void => cb(s)
      ipcRenderer.on('update:state', h)
      return () => { ipcRenderer.off('update:state', h) }
    },
  },
  localFile: {
    // `kind` (image/pdf/video/audio) pre-selects the dialog's file filter.
    pick: (kind?: string): Promise<string[] | null> => ipcRenderer.invoke('local:pick', kind),
    stat: (path: string): Promise<{ exists: boolean; size?: number; mtime?: number }> => ipcRenderer.invoke('local:stat', path),
    read: (path: string): Promise<{ bytes: Uint8Array; mime: string } | null> => ipcRenderer.invoke('local:read', path),
    open: (path: string): Promise<string> => ipcRenderer.invoke('local:open', path),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('local:reveal', path),
  },
})
