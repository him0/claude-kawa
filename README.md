# claude-kawa

Claude Code の右パネルに川のライブカメラ画像を表示する mod。`/kawa` でパネルを開閉し、開いている間は一定間隔で画像を取り直す。

既定のカメラは [ウェザーニューズの太鼓橋カメラ](https://cam.wni.co.jp/taikobashi/camera.jpg)。

## インストール

Claude Code のプロンプトで次を実行する。

```
/plugin install kawa --marketplace him0/claude-kawa
```

marketplace の追加を聞かれたら `y`、続いてインストール先のスコープを選ぶ。

## 使い方

- `/kawa`: カメラ画像のパネルを開く。もう一度実行すると閉じる

## 描画方式

- 画像を描ける端末では、端末のインライン画像として元画像をそのまま表示する
  - iTerm2 3.5 以降 (フルスクリーン描画のとき)、kitty、Ghostty
- それ以外の端末や tmux の中では、2×2 画素を 1 セルの四分ブロック文字で近似して表示する

## 設定

`/plugin` の設定メニューから変更できる。

- `url`: 表示する JPEG の URL
- `refreshSec`: 画像を取り直す間隔 (秒)。0 で更新しない
- `render`: `auto` (既定。端末に合わせて選ぶ) / `image` / `raster`

## 必要なもの

macOS の `curl`、`sips`、`python3` を使って画像を取得・変換する。
