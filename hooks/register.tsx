import type { EngineInterface, Register } from 'claude-code'

const PANE_ID = 'kawa'

// モジュール内には JPEG デコーダも生バイト取得手段も無いので、ホスト側で
// curl → sips (BMP 化) → Python 標準ライブラリで画素を読む。
// 1 セル = 2×2 画素を明暗 2 色に量子化し、四分ブロック文字で形を表す (chafa と同じ手法)。
// 出力は 1 行目が "columns rows"、以降 1 セルあたり 16 桁の hex (文字コード 4 + 前景 6 + 背景 6)。
const RASTER_SCRIPT = `
import subprocess, sys, struct, tempfile, os
url, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
d = tempfile.mkdtemp()
jpg, bmp = os.path.join(d, 'in.jpg'), os.path.join(d, 'out.bmp')
subprocess.run(['curl', '-sS', '-m', '10', '-o', jpg, url], check=True)
subprocess.run(['sips', '-z', str(rows * 2), str(cols * 2), '-s', 'format', 'bmp', jpg, '--out', bmp], check=True, capture_output=True)
b = open(bmp, 'rb').read()
off = struct.unpack_from('<I', b, 10)[0]
w, h = struct.unpack_from('<ii', b, 18)
bpp = struct.unpack_from('<H', b, 28)[0]
stride = ((w * bpp // 8) + 3) & ~3
bottom_up = h > 0
h = abs(h)
def px(x, y):
    src = (h - 1 - y) if bottom_up else y
    i = off + src * stride + x * (bpp // 8)
    return (b[i + 2], b[i + 1], b[i])
def lum(c): return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
def avg(cs):
    n = len(cs)
    return tuple(sum(c[k] for c in cs) // n for k in range(3))
def hexc(c): return f'{c[0]:02x}{c[1]:02x}{c[2]:02x}'
# 四分ブロック。ビットは 左上=1, 右上=2, 左下=4, 右下=8 で「前景で塗る位置」
QUAD = {0: ' ', 1: '▘', 2: '▝', 3: '▀', 4: '▖', 5: '▌', 6: '▞', 7: '▛',
        8: '▗', 9: '▚', 10: '▐', 11: '▜', 12: '▄', 13: '▙', 14: '▟', 15: '█'}
cw, ch = w // 2, h // 2
print(f'{cw} {ch}')
for cy in range(ch):
    out = []
    for cx in range(cw):
        q = [px(cx * 2, cy * 2), px(cx * 2 + 1, cy * 2), px(cx * 2, cy * 2 + 1), px(cx * 2 + 1, cy * 2 + 1)]
        ls = [lum(c) for c in q]
        thr = (max(ls) + min(ls)) / 2
        mask = 0
        bright, dark = [], []
        for i, (c, l) in enumerate(zip(q, ls)):
            if l >= thr and max(ls) - min(ls) > 8:
                mask |= 1 << i; bright.append(c)
            else:
                dark.append(c)
        if not bright:  # ほぼ均一なセルは全面ベタ塗り
            mask, bright, dark = 15, q, q
        fg, bg = avg(bright), avg(dark) if dark else avg(bright)
        out.append(f'{ord(QUAD[mask]):04x}{hexc(fg)}{hexc(bg)}')
    print(''.join(out))
`

// Image 用。元画像をそのまま PNG にして渡し、縮小は端末に任せる。
// Image の上限 (2 MiB) を超えそうなら長辺を詰める。出力は 1 行目が "width height"、2 行目が PNG の base64
const PNG_SCRIPT = `
import subprocess, sys, tempfile, os, base64
url = sys.argv[1]
d = tempfile.mkdtemp()
jpg, png = os.path.join(d, 'in.jpg'), os.path.join(d, 'out.png')
subprocess.run(['curl', '-sS', '-m', '10', '-o', jpg, url], check=True)
subprocess.run(['sips', '-s', 'format', 'png', jpg, '--out', png], check=True, capture_output=True)
for side in (1280, 960, 640, 480):
    if os.path.getsize(png) <= 1_800_000: break
    subprocess.run(['sips', '-Z', str(side), png], check=True, capture_output=True)
b = open(png, 'rb').read()
w, h = int.from_bytes(b[16:20], 'big'), int.from_bytes(b[20:24], 'big')
print(f'{w} {h}')
print(base64.b64encode(b).decode())
`

type Frame = { columns: number; rows: number; cells: string }
type Picture = { png: string; width: number; height: number }
type RenderMode = 'auto' | 'image' | 'raster'

let url = ''
let refreshSec = 60
let renderMode: RenderMode = 'auto'
// Image を描ける端末か。iTerm2 はフルスクリーン描画のときだけなので、そちらは描画時に見る
let imageTerminal: 'iterm2' | 'native' | undefined
let frame: Frame | undefined
let picture: Picture | undefined
let error: string | undefined
let fetching = false
// Raster は画素をセルに焼くのでサイズごとに取り直す。Image は端末が縮小するので 'image' だけ覚える
let wanted: { columns: number; rows: number } | 'image' | undefined
let timer: { cancel: () => void } | undefined

async function detectImageTerminal($: EngineInterface): Promise<void> {
  // tmux は allow-passthrough の設定次第なので Raster に倒す
  if (await $.env.get('TMUX')) return
  const program = await $.env.get('TERM_PROGRAM')
  if (program === 'iTerm.app') {
    const [major = 0, minor = 0] = ((await $.env.get('TERM_PROGRAM_VERSION')) ?? '').split('.').map(Number)
    if (major > 3 || (major === 3 && minor >= 5)) imageTerminal = 'iterm2'
  } else if (program === 'ghostty' || (await $.env.get('TERM')) === 'xterm-kitty') {
    imageTerminal = 'native'
  }
}

function usesImage(isFullscreen: boolean | undefined): boolean {
  if (renderMode !== 'auto') return renderMode === 'image'
  return imageTerminal === 'native' || (imageTerminal === 'iterm2' && isFullscreen === true)
}

function fetchWanted($: EngineInterface): void {
  if (wanted === 'image') void fetchPicture($)
  else if (wanted) void fetchFrame($, wanted.columns, wanted.rows)
}

async function fetchPicture($: EngineInterface): Promise<void> {
  if (fetching) return
  fetching = true
  try {
    const { exitCode, stdout, stderr } = await $.process.run(['python3', '-c', PNG_SCRIPT, url], { timeoutMs: 30_000 })
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
    const [size = '', png = ''] = stdout.trim().split('\n')
    const [width, height] = size.split(' ').map(Number) as [number, number]
    picture = { png, width, height }
    error = undefined
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    fetching = false
    $.ui.invalidate('ui.render')
  }
}

// 画像を columns × rows セルの Raster に変換する
async function fetchFrame($: EngineInterface, columns: number, rows: number): Promise<void> {
  if (fetching) return
  fetching = true
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      ['python3', '-c', RASTER_SCRIPT, url, String(columns), String(rows)],
      { timeoutMs: 30_000 },
    )
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
    const lines = stdout.trim().split('\n')
    const [w, cellRows] = lines[0]!.split(' ').map(Number) as [number, number]
    const words = new Uint32Array(w * cellRows * 3)
    for (let y = 0; y < cellRows; y++) {
      const row = lines[y + 1]!
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3
        const o = x * 16
        words[i] = parseInt(row.slice(o, o + 4), 16)
        words[i + 1] = parseInt(row.slice(o + 4, o + 10), 16)
        words[i + 2] = parseInt(row.slice(o + 10, o + 16), 16)
      }
    }
    frame = { columns: w, rows: cellRows, cells: new Uint8Array(words.buffer).toBase64() }
    error = undefined
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    fetching = false
    $.ui.invalidate('ui.render')
  }
}

function startRefresh($: EngineInterface): void {
  timer?.cancel()
  timer = undefined
  if (refreshSec <= 0) return
  timer = $.clock.every(refreshSec * 1000, () => fetchWanted($))
}

function stopRefresh(): void {
  timer?.cancel()
  timer = undefined
  wanted = undefined
}

export const register: Register = (on, options) => {
  url = String(options.url ?? 'https://cam.wni.co.jp/taikobashi/camera.jpg')
  refreshSec = Number(options.refreshSec ?? 60)
  renderMode = (options.render as RenderMode | undefined) ?? 'auto'

  on('session.start', async ($, e, next) => {
    await detectImageTerminal($)
    await $.command.register({
      name: 'kawa',
      description: '川のライブカメラ画像の右パネルを開閉する',
    })
    return next(e)
  })

  on('command.run', { command: 'kawa' }, async ($, e, next) => {
    // 開いていれば閉じる。タイマーの停止は ui.close フックに任せる
    if ((await $.ui.panes()).some((pane) => pane.id === PANE_ID)) {
      await $.ui.close({ id: PANE_ID })
      return {}
    }
    await $.ui.open({ id: PANE_ID, title: '太鼓橋カメラ' })
    startRefresh($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>カメラ画像はターミナルでだけ表示できます</Text>
    }
    const { Box, Text, Raster, Image } = $.ui.resolve(e)
    const bodyColumns = Math.max(1, e.props.bodyColumns)
    const bodyRows = Math.max(1, e.props.scroll.bodyRows - 1)
    const status = <Text dimColor>{error ? `更新失敗: ${error}` : fetching ? '更新中...' : url}</Text>
    const pending = (
      <Box>
        <Text dimColor>{error ? `取得失敗: ${error}` : '取得中...'}</Text>
      </Box>
    )

    if (usesImage(e.viewport?.isFullscreen)) {
      if (wanted !== 'image') {
        wanted = 'image'
        void fetchPicture($)
      }
      if (!picture) return pending
      // Image は箱いっぱいに引き伸ばすので、セルの縦横比 (約 1:2) で元画像の比率に合う箱を選ぶ
      const ratio = picture.height / picture.width / 2
      let columns = Math.min(255, bodyColumns)
      let rows = Math.round(columns * ratio)
      if (rows > bodyRows) {
        rows = Math.min(255, bodyRows)
        columns = Math.max(1, Math.round(rows / ratio))
      }
      return (
        <Box flexDirection="column">
          <Image
            key="camera"
            source={{ png: picture.png }}
            columns={columns}
            rows={Math.max(1, rows)}
            alt="この端末では画像を表示できません"
          />
          {status}
        </Box>
      )
    }

    const columns = Math.min(512, bodyColumns)
    const rows = Math.min(256, bodyRows)
    // 初回表示やパネル幅の変化に追従して取り直す
    if (wanted === undefined || wanted === 'image' || wanted.columns !== columns || wanted.rows !== rows) {
      wanted = { columns, rows }
      void fetchFrame($, columns, rows)
    }
    if (!frame) return pending
    return (
      <Box flexDirection="column">
        <Raster key="camera" columns={frame.columns} rows={frame.rows} cells={frame.cells} />
        {status}
      </Box>
    )
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE_ID) stopRefresh()
    return next(e)
  })
}
