// 挿入テンプレート・スニペット定数（MarkdownText / TypolMarkdown 共通）。
// ここを一箇所にしておくと、テンプレ文面や日付書式の変更が両エディタに同時に効く。

export const MD_CALLOUT = '> [!NOTE] タイトル\n> 内容\n'

export const jpDate = (): string => {
  const d = new Date()
  const wd = '日月火水木金土'[d.getDay()]
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}(${wd})`
}

export const jpDateTime = (): string => {
  const d = new Date()
  return `${jpDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const TPL_MINUTES = (): string =>
  `## 議事録 ${jpDate()}\n\n**参加者**: \n**目的**: \n\n### 決定事項\n\n- \n\n### TODO\n\n- [ ] \n\n### メモ\n\n- \n`

export const TPL_DAILY = (): string =>
  `## 日報 ${jpDate()}\n\n### 今日やったこと\n\n- \n\n### 明日やること\n\n- [ ] \n\n### 気づき・メモ\n\n- \n`
