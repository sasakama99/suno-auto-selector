# Suno AI Auto Selector by Title

Suno AI で**タイトルを入力するだけで完全一致する曲を自動選択**し、曲数と合計再生時間を集計するTampermonkeyスクリプトです。

## 特徴

- 🎯 タイトルの**完全一致**で自動選択（OR検索：複数指定すれば全部選ばれる）
- 📊 **曲数と合計時間**をリアルタイム集計
- 🔄 無限スクロール対応（新しく読み込まれた曲も自動判定）
- 🎨 邪魔にならない折りたたみ可能なパネルUI
- ⚡ 自動更新対応

## インストール

### 1. Tampermonkey拡張をブラウザに導入

- [Chrome版](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [Firefox版](https://addons.mozilla.org/ja/firefox/addon/tampermonkey/)
- [Edge版](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

### 2. スクリプトをインストール

下のリンクをクリック → Tampermonkeyのインストール画面が開く → 「インストール」を押すだけ

👉 **[インストール](https://raw.githubusercontent.com/sasakama99/suno-auto-selector/main/suno-auto-selector.user.js)**

## 使い方

1. [suno.com](https://suno.com) を開く
2. 画面右上に🎯パネルが表示される
3. 入力欄にタイトルを入力（**改行 or カンマ区切り**で複数指定可能）
   ```
   ジャズ1
   ジャズ2
   ```
4. 完全一致する曲が自動でハイライトされ、曲数と合計時間が表示される

## 自動更新について

Tampermonkeyは定期的（デフォルトで1日1回）に更新をチェックします。新バージョンが公開されると自動でインストールされます。

すぐに更新したい場合は：
1. Tampermonkeyのアイコンをクリック
2. 「ダッシュボード」→「インストール済みスクリプト」
3. 該当スクリプト横の「最終更新」リンクから手動チェック可能

## ライセンス

MIT
