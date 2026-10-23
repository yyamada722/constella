// pptx-preview (1.0.7) の描画バグを postinstall で直す。配布物は minify 済みの
// 単一ファイルなので、目印の文字列を置換する。冪等（適用済みなら何もしない）で、
// 目印が見つからない（＝ライブラリ更新でコードが変わった）ときは失敗させて気付けるようにする。
//
//  1. 図形の「枠線なし」(<a:ln><a:noFill/>) を無視し、テーマの lnRef 枠線を描いてしまう
//  2. 画像の背景塗り (<p:pic> の spPr/solidFill) を描かない
//  3. 画像の透明度 (<a:blip><a:alphaModFix amt>) を描かない
//     → 2+3 の組み合わせ（紺地に透明度85%のテクスチャを重ねた帯など）が白く抜ける
//  4. カギ線/曲線コネクタの曲がり位置 (adj1) を幅でなく max(幅,高さ) 基準で計算する
//  5. 空の段落を段落末の文字サイズ (endParaRPr sz) でなく既定 18px で描く
//     → 小さな文字の図形で文字ブロックが伸び、中央揃えだと枠の上下にはみ出す
//  6. 固定ポイントの行間 (<a:lnSpc><a:spcPts>) を無視する（固定行間でも段落ごとに余白を足して下へはみ出す）
//  7. 表セルの「塗りなし」(<a:tcPr><a:noFill/>) を無視し、表スタイルの帯色で塗る
//  8. 画像サイズを width/height 属性で指定するため、アプリ側の CSS リセット
//     (Tailwind preflight: img{max-width:100%;height:auto}) に潰されて切り抜き (srcRect) が崩れる
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'node_modules', 'pptx-preview', 'dist', 'pptx-preview.es.js')
const MARK = '/*constella-patched*/'

const PATCHES = [
  {
    name: 'ln noFill → 枠線なし',
    from: 'o&&Object.assign(this.border,R(o,this.theme,this))',
    to: 'o&&(c(o,"a:noFill")?this.border={}:Object.assign(this.border,R(o,this.theme,this)))',
  },
  {
    name: 'pic: alphaModFix / 背景塗りを読む',
    from: 'h.userDrawn=!0,h.pptx=r,h.path=e;',
    to: 'h.userDrawn=!0,h.pptx=r,h.path=e;var __am=c(h.source,["p:blipFill","a:blip","a:alphaModFix","attrs","amt"]);null!=__am&&(h.alpha=parseInt(__am)/1e5);var __sf=c(h.source,["p:spPr","a:solidFill"]);__sf&&(h.bgFill=g(__sf,h.theme,h));',
  },
  {
    name: 'pic: 背景塗りを描く',
    from: 'd.style.setProperty("overflow","hidden"),r?(s=e.w/',
    to: 'd.style.setProperty("overflow","hidden"),t.bgFill&&d.style.setProperty("background",S(t.bgFill)),r?(s=e.w/',
  },
  {
    // OOXML の bentConnector3 / curvedConnector3 の adj1 は「幅」に対する比率だが、
    // pptx-preview は max(幅,高さ) を掛けるため、縦長のコネクタで曲がり位置が
    // 枠外へ飛び、線がスライドの下まで突き抜ける。
    name: 'bentConnector3: adj1 は幅基準',
    from: 'r=et("adj1",t,.5*Math.max(e.w,e.h)),n=["M 0,0"',
    to: 'r=et("adj1",t,.5*Math.max(e.w,e.h))/(Math.max(e.w,e.h)||1)*e.w,n=["M 0,0"',
  },
  {
    name: 'curvedConnector3: adj1 は幅基準',
    from: 'r=et("adj1",t,.5*Math.max(e.w,e.h)),n=["M0,0"',
    to: 'r=et("adj1",t,.5*Math.max(e.w,e.h))/(Math.max(e.w,e.h)||1)*e.w,n=["M0,0"',
  },
  {
    name: '空段落: endParaRPr の文字サイズを保持',
    from: 'var s=e.inheritProps,h=e.inheritRProps,l=e.props,p=e.rows',
    to: 'var __ep=e.endParaRProps||{},s=e.inheritProps,h=e.inheritRProps,l=e.props,p=e.rows',
  },
  {
    name: '空段落: 行の高さに endParaRPr を使う',
    from: 'return(a||h.size||18)*i',
    to: 'return(a||(!p.length&&__ep.size)||h.size||18)*i',
  },
  {
    name: '空段落: スペーサーにも同じ文字サイズ',
    from: 'L.innerHTML="&nbsp;",L.style.fontSize=h.size+"px"',
    to: 'L.innerHTML="&nbsp;",L.style.fontSize=u()+"px"',
  },
  {
    name: '行間 spcPts を読む',
    from: 'c(t,["a:lnSpc","a:spcPct","attrs","val"])&&(e.lineHeight=parseInt(t["a:lnSpc"]["a:spcPct"].attrs.val)/1e5)',
    to: 'c(t,["a:lnSpc","a:spcPct","attrs","val"])&&(e.lineHeight=parseInt(t["a:lnSpc"]["a:spcPct"].attrs.val)/1e5),c(t,["a:lnSpc","a:spcPts","attrs","val"])&&(e.lineHeightPx=v(parseInt(t["a:lnSpc"]["a:spcPts"].attrs.val)))',
    count: 3, // 段落パーサが3クラスに重複している
  },
  {
    name: '行間 spcPts を描く',
    from: 'w.style.lineHeight=b+""',
    to: 'w.style.lineHeight=d.lineHeightPx?d.lineHeightPx+"px":b+""',
  },
  {
    // 固定行間なら段落余白は足さない。それ以外の余白（単一行間 ≒ 1.2 倍の不足分）も
    // 整数に切り捨てない — 小さな空段落（4pt 等）が多いと 0px に落ちて上へ詰まる。
    name: '段落の上余白: 固定行間は 0、それ以外は切り捨てない',
    from: 'f.style.margin="".concat(Math.floor(.2*u()),"px  0 0 0")',
    to: 'f.style.margin="".concat(d.lineHeightPx?0:.2*u(),"px  0 0 0")',
  },
  {
    name: 'pic: 画像サイズをインライン style で固定',
    from: 'u.src=n,u.width=s,u.height=h,',
    to: 'u.src=n,u.style.setProperty("width",s+"px"),u.style.setProperty("height",h+"px"),u.style.setProperty("max-width","none"),',
  },
  {
    name: '表セル noFill → 塗りなし',
    from: 'var l=c(t,["a:tcPr","a:solidFill"]);l&&(i.props.background=g(l,this.theme,this.ctx));',
    to: 'var l=c(t,["a:tcPr","a:solidFill"]);l&&(i.props.background=g(l,this.theme,this.ctx));!l&&c(t,["a:tcPr","a:noFill"])&&(i.props.background={type:"none"});',
  },
  {
    name: 'pic: 透明度を描く',
    from: 'u.style.setProperty("position","absolute"),u.style.setProperty("left",l+"px")',
    to: 'u.style.setProperty("position","absolute"),null!=t.alpha&&u.style.setProperty("opacity",String(t.alpha)),u.style.setProperty("left",l+"px")',
  },
]

if (!existsSync(file)) {
  console.log('[patch-pptx-preview] pptx-preview が未インストールのためスキップ')
  process.exit(0)
}
let src = readFileSync(file, 'utf8')
if (src.startsWith(MARK)) {
  console.log('[patch-pptx-preview] 適用済み')
  process.exit(0)
}
for (const p of PATCHES) {
  const want = p.count ?? 1
  const n = src.split(p.from).length - 1
  if (n !== want) {
    console.error(`[patch-pptx-preview] 目印が ${n} 箇所（期待 ${want}）: ${p.name} — pptx-preview の版が変わった可能性`)
    process.exit(1)
  }
  src = src.split(p.from).join(p.to)
}
writeFileSync(file, MARK + src)
console.log(`[patch-pptx-preview] ${PATCHES.length} 件適用`)
