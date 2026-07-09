# Constella

情報整理のためのデスクトップアプリ（Electron 製）。ノート・タスク（カンバン / ガント / カレンダー）・リサーチ・キャンバス・スケッチ・フロー図・路線図を、プロジェクト単位で横断的に扱えます。

> 旧称 `maind_set`。データは `%APPDATA%\Constella\constella.db`（SQLite）に保存され、アトミック保存・世代バックアップ・破損時の自動リカバリを備えています。

## 技術スタック

- Electron + [electron-vite](https://electron-vite.org/)
- React 18 + TypeScript
- TailwindCSS
- sql.js（SQLite / WASM）＋ IndexedDB（メディア）

## 開発

```bash
npm install
npm run dev          # Electron 開発モード（HMR）
npm run dev:preview  # レンダラのみをブラウザでプレビュー（localhost）
```

## ビルド

```bash
npm run build        # 型チェック + バンドル
npm run dist         # 配布物を release/ に生成（win-unpacked / portable / installer）
```

配布ビルドは `release/win-unpacked/Constella.exe` を直接実行するのが最速です（`npm run dist` のたびに更新されます）。

## ライセンス

Private / All rights reserved.
