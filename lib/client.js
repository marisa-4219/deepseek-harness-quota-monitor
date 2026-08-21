/**
 * deepseek-harness-quota-monitor — client half (browser bundle).
 *
 * Two surfaces:
 *   - `sidebar.footer.action` (id `quota-monitor`): rounded quota card above
 *     the settings button. Renders per provider: balance amount or window
 *     progress bars, plus DSH-local "today used".
 *   - `settings.section` (id `quota-monitor-settings`, label 额度监控): the
 *     provider configuration form, mirroring the product's Models settings
 *     page structure (row cards + inline editors).
 *
 * CJS factory bundle: the browser module loader loads this file as a classic
 * script, and the script must register itself via `window.__ModuleLoader__.load`
 * ({ id, factory }) — mirroring the tsdown output of shipped client packages.
 * The factory receives the loader's `require`; React comes from require('react').
 */
window.__ModuleLoader__.load({
	id: 'deepseek-harness-quota-monitor',
	factory: (require) => {
		'use strict'
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const { useState, useEffect, useRef, useCallback } = React
		const h = React.createElement
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		const Modal = primitives.Modal
		const Button = primitives.Button
		const Toast = primitives.Toast

		// ---------------------------------------------------------------------
		// theme tokens (neutral fallbacks; light/dark safe)
		// ---------------------------------------------------------------------

		const TOK = {
		  border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
		  text2: 'var(--dsw-alias-label-secondary, rgba(128,128,128,.85))',
		  text3: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.65))',
		  green: 'var(--dsw-alias-state-success-primary, #22c55e)',
		  amber: 'var(--dsw-alias-state-warn-label, #f59e0b)',
		  red: 'var(--dsw-alias-state-error-primary, #ef4444)',
		}

		const S = {
		  dot: { flex: 'none', width: 6, height: 6, borderRadius: '50%' },
		  mini: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: TOK.text2, whiteSpace: 'nowrap' },
		}

		// ---------------------------------------------------------------------
		// stylesheet (injected once; the HMR driver removes data-plugin tags).
		// The settings classes reuse the Models page's exact visual parameters
		// (card/editor/field/input/button shapes and tokens).
		// ---------------------------------------------------------------------

		const WIDGET_CSS = `
.qm-card{box-sizing:border-box;border-radius:12px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.06));padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary, inherit);text-align:left;cursor:pointer;width:100%;min-width:0;flex:1;transition:background .15s ease,border-color .15s ease}
.qm-card:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.09))}
.qm-card:active{transform:scale(.995)}
.qm-card:focus-visible{outline:2px solid var(--dsw-alias-border-l3, rgba(128,128,128,.5));outline-offset:2px;border-radius:12px}
.qm-provider{display:flex;flex-direction:column;gap:5px;min-width:0}
.qm-provider + .qm-provider{border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.15));padding-top:8px}
.qm-head{display:flex;align-items:baseline;gap:6px;min-width:0}
.qm-name{font-weight:500;font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.qm-value{margin-left:auto;font-weight:600;font-size:13px;line-height:18px;font-variant-numeric:tabular-nums;letter-spacing:.1px;white-space:nowrap;flex:none;font-family:var(--ds-font-family-code, ui-monospace,'SF Mono',Consolas,'Courier New',monospace)}
.qm-sub{color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.65));font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.qm-err{color:var(--dsw-alias-state-error-primary, #ef4444);font-size:11px;line-height:16px;word-break:break-all}
.qm-wrow{display:flex;align-items:center;gap:8px;font-size:11px;line-height:18px;font-family:var(--ds-font-family-code, ui-monospace,'SF Mono',Consolas,'Courier New',monospace)}
.qm-wlabel{flex:none;width:22px;color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.65));font-variant-numeric:tabular-nums}
.qm-wtrack{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));overflow:hidden;min-width:30px}
.qm-wfill{height:100%;border-radius:2px}
.qm-wtext{flex:none;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.85));font-variant-numeric:tabular-nums;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.qm-card{transition:none}.qm-card:active{transform:none}}
/* ---- settings section: Models-page visual language ---- */
.qm-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.qm-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.qm-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.qm-rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}
.qm-rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}
.qm-rowHead{align-items:center;gap:10px;display:flex}
.qm-rowIdentity{align-items:center;gap:6px;min-width:0;display:inline-flex}
.qm-rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qm-rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.qm-credDot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}
.qm-credDotC{background:var(--dsw-alias-state-success-primary)}
.qm-credDotM{background:var(--dsw-alias-state-error-primary)}
.qm-rowActions{align-items:center;gap:8px;margin-left:auto;display:inline-flex}
.qm-rowDisabled{opacity:.55}
.qm-btnPrimary,.qm-btnSecondary,.qm-btnAdd{box-sizing:border-box;height:36px;font:inherit;cursor:pointer;border:none;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;font-family:inherit}
.qm-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.qm-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.qm-btnSecondary,.qm-btnAdd{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:0 0}
.qm-btnSecondary:hover:not(:disabled),.qm-btnAdd:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.qm-btnDanger{box-sizing:border-box;height:36px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;border-radius:18px;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;font-family:inherit}
.qm-btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.qm-rowActions .qm-btnSecondary,.qm-rowActions .qm-btnDanger{border-radius:14px;height:28px;padding:0 10px;font-size:12px;line-height:18px}
/* enable/disable toggle: borderless on both states; the "disable" action
   carries the danger tint, "enable" stays neutral */
.qm-toggleBtn{box-sizing:border-box;height:28px;border-radius:14px;padding:0 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.85));background:0 0;border:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit}
.qm-toggleBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.qm-toggleBtn:disabled{opacity:.6;cursor:default}
.qm-toggleOff{color:var(--dsw-alias-state-error-primary, #ef4444)}
.qm-toggleOff:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.qm-btnPrimary:disabled,.qm-btnSecondary:disabled,.qm-btnDanger:disabled,.qm-btnAdd:disabled{opacity:.4;cursor:default}
.qm-btnPrimary:focus-visible,.qm-btnSecondary:focus-visible,.qm-btnDanger:focus-visible,.qm-btnAdd:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
.qm-editor{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}
.qm-editorHeader{align-items:baseline;gap:8px;display:flex}
.qm-editorTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.qm-editorRoute{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.qm-field{flex-direction:column;gap:6px;display:flex;min-width:0}
.qm-fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}
.qm-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px;font-family:inherit}
select.qm-input{cursor:pointer;max-width:240px}
.qm-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.qm-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.qm-input:disabled{opacity:.6;cursor:default}
.qm-textarea{min-height:72px;padding:6px 10px;resize:vertical;font-family:var(--ds-font-family-code, ui-monospace,Consolas,monospace)}
.qm-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.qm-editorActions{justify-content:flex-end;gap:8px;display:flex;align-items:center}
.qm-addBlock{flex-direction:column;gap:12px;display:flex}
.qm-addActions{flex-wrap:nowrap;gap:10px;display:flex;align-items:center}
.qm-btnAdd{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;flex:1 1 0;gap:6px;min-width:180px;height:44px}
.qm-addCard{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;list-style:none;display:flex}
.qm-addCard .qm-editor{background:0 0;padding:0}
.qm-divider{height:1px;background:var(--dsw-alias-border-l2, rgba(128,128,128,.22));margin:16px 0}
.qm-saved{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}
.qm-fail{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
.qm-row{display:flex;align-items:center;gap:8px;min-width:0}
.qm-grow{flex:1;min-width:0}
.qm-w80{width:80px;flex:none}
.qm-w110{width:110px;flex:none}
.qm-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.qm-addActionBtn{flex:none;min-width:0}
@media (width<=560px){.qm-grid3{grid-template-columns:1fr}}
.qm-windowGrid{display:grid;grid-template-columns:64px 92px 92px 1fr auto;gap:6px;align-items:center}
.qm-windowHead{display:grid;grid-template-columns:64px 92px 92px 1fr auto;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.qm-checkRow{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px}
.qm-checkRow input{margin:0}
/* ---- today-used meter (ContextMeter panel language) ---- */
.qm-today{display:flex;flex-direction:column;gap:0}
.qm-todayHead{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:18px}
.qm-todayLabel{color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.65))}
.qm-todayMain{color:var(--dsw-alias-label-primary, inherit);font-weight:500;font-family:var(--ds-font-family-code, ui-monospace,Consolas,monospace);font-variant-numeric:tabular-nums;font-size:12px}
.qm-todayCost{margin-left:auto;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.85));font-family:var(--ds-font-family-code, ui-monospace,Consolas,monospace);font-variant-numeric:tabular-nums}
.qm-todayBar{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));border-radius:999px;gap:1px;height:4px;margin:6px 0 8px;display:flex;overflow:hidden}
.qm-todaySeg{background:var(--meter-tint, var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}
.qm-todayRows{display:flex;flex-direction:column;gap:2px}
.qm-todayRow{justify-content:space-between;align-items:center;gap:12px;padding:1px 0;display:flex;font-size:11px;line-height:16px}
.qm-todayRowKey{color:var(--dsw-alias-label-secondary, rgba(128,128,128,.85));display:inline-flex;align-items:center;gap:6px;min-width:0}
.qm-todaySwatch{background:var(--meter-tint);border-radius:2px;width:8px;height:8px;flex:none}
.qm-todayRowVal{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary, inherit);font-family:var(--ds-font-family-code, ui-monospace,Consolas,monospace);white-space:nowrap}
.qm-todayPct{color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.65));font-family:var(--ds-font-family-code, ui-monospace,Consolas,monospace);font-size:10px;margin-left:6px}
.qm-tintInput{--meter-tint:var(--dsw-static-neutral-bluish-400, #7c93b8)}
.qm-tintOutput{--meter-tint:#a78bfa}
.qm-tintCache{--meter-tint:var(--dsw-static-blue-450, #4f8ef7)}
.qm-deleteDialog{width:min(480px,100%)}
/* ---- today flip card (opacity-based faces; rotateY for the 3D look) ----
   backface-visibility proved unreliable here (back face leaked through before
   any click, front went blank after flipping), so visibility is driven by
   opacity + pointer-events instead; the 3D rotation stays for the visual. */
.qm-flip{perspective:600px}
.qm-flipInner{transition:transform .45s ease;transform-style:preserve-3d}
.qm-flipInner.flipped{transform:rotateY(180deg)}
.qm-flipFaces{display:grid}
.qm-flipFace{grid-area:1/1;border-radius:6px;cursor:pointer;padding:3px 6px;margin:-3px -6px;transition:background .15s ease,opacity .2s ease;opacity:1}
.qm-flipFace:hover{background:rgba(0,0,0,.16)}
.qm-flipBack{transform:rotateY(180deg);display:flex;flex-direction:column;gap:2px;opacity:0;pointer-events:none}
.qm-flipInner.flipped .qm-flipFace{opacity:0;pointer-events:none}
.qm-flipInner.flipped .qm-flipBack{opacity:1;pointer-events:auto}
.qm-spark{width:100%;height:52px;display:block;shape-rendering:geometricPrecision}
.qm-sparkBox{display:flex;flex-direction:column;gap:2px}
.qm-sparkLegend{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.qm-sparkHead{display:flex;align-items:baseline;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))}
.qm-sparkHead b{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.85));font-family:var(--ds-font-family-code, ui-monospace,Consolas,monospace);font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.qm-flipInner{transition:none}}
/* dark theme: module surfaces sit two notches closer to the page background
   (bluish-875 vs the product default bluish-800); inputs drop one more notch
   (bluish-900) so the inset hierarchy survives the darker cards */
body[data-ds-dark-theme] .qm-card,
body[data-ds-dark-theme] .qm-editor,
body[data-ds-dark-theme] .qm-addCard{background:var(--dsw-alias-bg-layer-1)}
body[data-ds-dark-theme] .qm-input{background:var(--dsw-static-neutral-bluish-900)}
/* dark theme: the sidebar card drops its border (the glassy edge reads
   louder than the surface tone on dark backgrounds); light theme keeps it */
body[data-ds-dark-theme] .qm-card{border:0}
`

		function ensureWidgetCss() {
		  if (typeof document === 'undefined') return
		  const tagId = 'deepseek-harness-quota-monitor/widget.css'
		  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
		  const tag = document.createElement('style')
		  tag.dataset.plugin = 'deepseek-harness-quota-monitor'
		  tag.dataset.pluginCss = tagId
		  tag.textContent = WIDGET_CSS
		  document.head.appendChild(tag)
		}

		// ---------------------------------------------------------------------
		// formatting helpers
		// ---------------------------------------------------------------------

		function fmt(n) {
		  if (n == null || Number.isNaN(n)) return '—'
		  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
		  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
		  return String(Math.round(n))
		}

		function fmtMoney(v) {
		  if (v == null || Number.isNaN(v)) return ''
		  return v < 0.01 ? v.toFixed(3) : v.toFixed(2)
		}

		/** Currency code -> display symbol; unknown codes render verbatim. */
		function currencySymbol(code) {
		  if (!code) return '¥'
		  const map = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$' }
		  return map[code.toUpperCase()] ?? `${code} `
		}

		/** Hourly chart for the flip card's back face: input / output / cache
		* lines on one shared Y axis, scaled to the P98 of all samples so a lone
		* spike can't flatten the day; color-only legend plus the peak figure.
		* Rendered 1:1 at the container's pixel size with monotone-cubic
		* smoothing, gradient strokes and an end dot per line. */
		let sparkSeq = 0
		function Sparkline({ series }) {
		  const boxRef = useRef(null)
		  const [width, setWidth] = useState(220)
		  useEffect(() => {
		    const el = boxRef.current
		    if (!el) return
		    const update = () => setWidth(Math.max(40, Math.round(el.clientWidth)))
		    update()
		    const ro = new ResizeObserver(update)
		    ro.observe(el)
		    return () => ro.disconnect()
		  }, [])
		  const H = 52
		  const PAD = 4
		  const n = series.length
		  const step = n > 1 ? (width - PAD * 2) / (n - 1) : 0
		  // one shared Y axis scaled to the P98 of all samples: a single spike
		  // must not flatten the rest of the day into the bottom 10% (the true
		  // peak is still reported as a figure in the footer). Values above the
		  // cap clip to the top edge instead of stretching the whole chart.
		  const all = series.flatMap((b) => [b.i, b.o, b.c])
		  const maxAll = Math.max(...all, 1)
		  let scaleMax = maxAll
		  {
		    const pos = all.filter((v) => v > 0)
		    if (pos.length >= 8) {
		      const sorted = pos.slice().sort((a, b) => a - b)
		      const p98 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))]
		      scaleMax = Math.max(p98, maxAll * 0.4)
		    }
		  }
		  const yOf = (v) => H - PAD - (Math.min(v, scaleMax) / scaleMax) * (H - PAD * 2)
		  const mk = (key) => series.map((b, i) => [PAD + i * step, yOf(b[key])])
		  // monotone cubic Hermite (Fritsch–Carlson): spline-smooth but never
		  // overshoots the data, so spikes stay spikes instead of ringing.
		  const mono = (pts) => {
		    const len = pts.length
		    if (len < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
		    const dx = [], dy = [], slope = []
		    for (let i = 0; i < len - 1; i++) {
		      dx[i] = pts[i + 1][0] - pts[i][0] || 1e-6
		      dy[i] = pts[i + 1][1] - pts[i][1]
		      slope[i] = dy[i] / dx[i]
		    }
		    const tang = []
		    tang[0] = slope[0]
		    tang[len - 1] = slope[len - 2]
		    for (let i = 1; i < len - 1; i++) {
		      if (slope[i - 1] * slope[i] <= 0) tang[i] = 0
		      else {
		        const sum = dx[i - 1] + dx[i]
		        tang[i] = sum !== 0 ? (3 * sum) / ((sum + dx[i]) / slope[i - 1] + (sum + dx[i - 1]) / slope[i]) : 0
		      }
		    }
		    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
		    for (let i = 0; i < len - 1; i++) {
		      const p0 = pts[i], p1 = pts[i + 1], dxi = dx[i]
		      const c1x = p0[0] + dxi / 3
		      const c1y = p0[1] + (tang[i] * dxi) / 3
		      const c2x = p1[0] - dxi / 3
		      const c2y = p1[1] - (tang[i + 1] * dxi) / 3
		      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)}`
		    }
		    return d
		  }
		  const peakTotal = Math.max(...series.map((b) => b.t), 0)
		  const LINES = [
		    { key: 'i', stroke: 'var(--dsw-static-neutral-bluish-400, #7c93b8)', label: '输入' },
		    { key: 'o', stroke: '#a78bfa', label: '输出' },
		    { key: 'c', stroke: 'var(--dsw-static-blue-450, #4f8ef7)', label: '缓存' },
		  ]
		  const uid = `qm-spark-${++sparkSeq}`
		  return h('div', { className: 'qm-sparkBox', ref: boxRef },
		    h('div', { className: 'qm-sparkHead' },
		      h('span', null, '今日用量 · 每小时'),
		      h('span', { style: { marginLeft: 'auto' } }, '点击返回')),
		    h('div', { className: 'qm-sparkHead' },
		      ...LINES.map((l) => h('span', { key: l.key, className: 'qm-sparkLegend' },
		        h('span', { style: { width: 6, height: 6, borderRadius: 2, background: l.stroke, flex: 'none' }, 'aria-hidden': true }),
		        l.label))),
		    h('svg', { className: 'qm-spark', viewBox: `0 0 ${width} ${H}`, width: '100%', height: H, 'aria-hidden': true },
		      h('defs', null,
		        ...LINES.map((l) => h('linearGradient', { key: l.key, id: `${uid}-${l.key}`, x1: 0, y1: 0, x2: 1, y2: 0 },
		          h('stop', { offset: '0%', stopColor: l.stroke, stopOpacity: 0.4 }),
		          h('stop', { offset: '100%', stopColor: l.stroke, stopOpacity: 1 })))),
		      ...LINES.map((l) => h('path', { key: l.key, d: mono(mk(l.key)), fill: 'none', stroke: `url(#${uid}-${l.key})`, strokeWidth: '2', strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' })),
		      ...LINES.map((l) => {
		        const pts = mk(l.key)
		        const last = pts[pts.length - 1]
		        return h('circle', { key: `dot-${l.key}`, cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: 2.5, fill: l.stroke })
		      })),
		    h('div', { className: 'qm-sparkHead' },
		      h('span', { style: { marginLeft: 'auto' } }, `峰值 ${fmt(peakTotal)}`)))
		}

		/** Today-used meter, following the product's ContextMeter panel language:
		* headline (label + main figure + right-aligned cost), a segmented round
		* bar (input/output/cache share), then swatch legend rows. Clicking flips
		* to the hourly token chart (transparent-black hover, 3D flip). */
		function TodayBlock({ t }) {
		  const [flipped, setFlipped] = useState(false)
		  const input = t.input ?? 0
		  const output = t.output ?? 0
		  const cache = t.cacheRead ?? 0
		  const total = input + output + cache
		  const prompt = input + cache
		  const pct = prompt > 0 ? (cache / prompt) * 100 : null
		  const hasBreakdown = t.input !== undefined || t.cacheRead !== undefined
		  const hasChart = Array.isArray(t.series)
		  const segments = hasBreakdown ? [
		    { key: 'in', cls: 'qm-tintInput', w: total > 0 ? (input / total) * 100 : 0 },
		    { key: 'out', cls: 'qm-tintOutput', w: total > 0 ? (output / total) * 100 : 0 },
		    { key: 'cache', cls: 'qm-tintCache', w: total > 0 ? (cache / total) * 100 : 0 },
		  ].filter((s) => s.w > 0) : null
		  const row = (cls, label, value, pctText) => h('div', { className: 'qm-todayRow' },
		    h('span', { className: 'qm-todayRowKey' },
		      h('span', { className: `qm-todaySwatch ${cls}`, 'aria-hidden': true }),
		      label),
		    h('span', { className: 'qm-todayRowVal' }, value),
		    pctText ? h('span', { className: 'qm-todayPct' }, pctText) : null)
		  const toggle = (e) => { if (hasChart) { e.stopPropagation(); setFlipped(!flipped) } }
		  const front = h('div', { className: 'qm-flipFace', onClick: toggle, title: todayTitle(t) },
		    h('div', { className: 'qm-todayHead' },
		      h('span', { className: 'qm-todayLabel' }, '今日已用'),
		      h('span', { className: 'qm-todayMain' }, `${fmt(t.tokens ?? total)} tok`),
		      t.cost != null ? h('span', { className: 'qm-todayCost' }, `${currencySymbol(t.currency)}${fmtMoney(t.cost)}`) : null),
		    segments ? h('div', { className: 'qm-todayBar' },
		      segments.map((s) => h('div', { key: s.key, className: `qm-todaySeg ${s.cls}`, style: { width: `${s.w}%` } }))) : null,
		    hasBreakdown
		      ? h('div', { className: 'qm-todayRows' },
		          row('qm-tintInput', '输入', fmt(input)),
		          row('qm-tintOutput', '输出', fmt(output)),
		          row('qm-tintCache', '缓存', fmt(cache), pct != null ? `${pct.toFixed(3)}%` : null))
		      : null)
		  const back = hasChart
		    ? h('div', { className: 'qm-flipFace qm-flipBack', onClick: toggle },
		        h(Sparkline, { series: t.series }))
		    : null
		  return h('div', { className: 'qm-flip' },
		    h('div', { className: `qm-flipInner${flipped ? ' flipped' : ''}` },
		      h('div', { className: 'qm-flipFaces' }, front, back)))
		}

		/** Tooltip detail: cache ratio + per-model breakdown + cost note. */
		function todayTitle(t) {
		  const lines = []
		  if (t.cost != null) lines.push('金额 = 供应商 usage 返回（无则不显示）')
		  if (t.cacheRatio != null) lines.push(`缓存命中占比 ${(t.cacheRatio * 100).toFixed(3)}%`)
		  if (t.byModel && t.byModel.length) {
		    for (const m of t.byModel) {
		      lines.push(`${m.model}: ${fmt(m.tokens)} tok · ${currencySymbol(t.currency)}${fmtMoney(m.cost)}`)
		    }
		  }
		  return lines.length ? lines.join('\n') : undefined
		}

		function ratioColor(used, limit) {
		  if (!limit) return TOK.green
		  const r = used / limit
		  return r >= 0.9 ? TOK.red : r >= 0.7 ? TOK.amber : TOK.green
		}

		function percentColor(p) {
		  if (p == null) return TOK.green
		  return p >= 90 ? TOK.red : p >= 70 ? TOK.amber : TOK.green
		}

		/** Short relative reset time, e.g. "2h" / "42m". */
		function relTime(iso) {
		  if (!iso) return null
		  const t = new Date(iso).getTime()
		  if (Number.isNaN(t)) return null
		  const ms = t - Date.now()
		  if (ms <= 0) return '重置中'
		  if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))}m`
		  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`
		  return `${Math.round(ms / 86400000)}d`
		}

		function statusColor(snap) {
		  if (snap.error) return TOK.red
		  if (snap.kind === 'balance') {
		    const b = snap.balance
		    if (!b) return TOK.amber
		    if (b.available === false) return TOK.red
		    const total = Number(b.total)
		    if (Number.isFinite(total) && total <= (snap.lowBalanceThreshold ?? 20)) return TOK.amber
		    return TOK.green
		  }
		  if (snap.kind === 'windows') {
		    const tight = snap.windows.find((w) =>
		      (w.percent != null && w.percent >= 70) ||
		      (w.limitTokens && w.usedTokens / w.limitTokens >= 0.7) ||
		      (w.limitMoney != null && w.limitMoney > 0 && w.usedMoney / w.limitMoney >= 0.7))
		    if (!tight) return TOK.green
		    const p = tight.percent != null ? tight.percent
		      : tight.limitMoney != null && tight.limitMoney > 0 ? (tight.usedMoney / tight.limitMoney) * 100
		        : (tight.usedTokens / tight.limitTokens) * 100
		    return p >= 90 ? TOK.red : TOK.amber
		  }
		  return TOK.text3
		}

		// ---------------------------------------------------------------------
		// sidebar widget
		// ---------------------------------------------------------------------

		/** Right-side headline value: remaining balance, tightest window
		* percentage, or nothing for error/unsupported snapshots. */
		function headValue(snap) {
		  if (snap.error) return ''
		  if (snap.kind === 'balance') {
		    const b = snap.balance
		    const v = b ? (b.remaining ?? b.total) : undefined
		    if (!b) return ''
		    const multiplier = typeof snap.rateMultiplier === 'number' && Number.isFinite(snap.rateMultiplier)
		      ? ` · x${Math.round(snap.rateMultiplier * 100) / 100}`
		      : ''
		    return `${b.currency ?? '¥'} ${v ?? '—'}${multiplier}`
		  }
		  if (snap.kind === 'windows') {
		    const rows = snap.windows || []
		    let tight = null
		    let tightP = null
		    for (const w of rows) {
		      const p = w.percent != null ? w.percent
		        : w.limitMoney != null && w.limitMoney > 0 ? (w.usedMoney / w.limitMoney) * 100
		          : w.limitTokens ? (w.usedTokens / w.limitTokens) * 100
		            : null
		      if (p != null && (tightP == null || p > tightP)) { tight = w; tightP = p }
		    }
		    if (tight && tight.percent != null) return `${tight.percent}%`
		    if (tight && tight.limitMoney != null) return `${fmtMoney(tight.usedMoney)}/${fmtMoney(tight.limitMoney)}`
		    if (tight && tight.limitTokens) return `${fmt(tight.usedTokens)}/${fmt(tight.limitTokens)}`
		    return ''
		  }
		  return ''
		}

		function WindowRow({ w, currency }) {
		  let bar = null
		  let text = ''
		  let title = `${w.seconds}s 窗口`
		  if (w.percent != null) {
		    const rel = relTime(w.resetsAt)
		    bar = h('div', { className: 'qm-wtrack' },
		      h('div', { className: 'qm-wfill', style: { width: `${Math.min(100, w.percent).toFixed(1)}%`, background: percentColor(w.percent) } }))
		    text = `${w.percent}%${rel ? ` · ${rel}` : ''}`
		    if (w.resetsAt) title = `重置于 ${new Date(w.resetsAt).toLocaleString()}`
		  } else if (w.limitMoney != null && w.usedMoney != null) {
		    const ratio = w.limitMoney > 0 ? w.usedMoney / w.limitMoney : 0
		    bar = h('div', { className: 'qm-wtrack' },
		      h('div', { className: 'qm-wfill', style: { width: `${Math.min(100, ratio * 100).toFixed(1)}%`, background: ratioColor(w.usedMoney, w.limitMoney) } }))
		    text = `${currencySymbol(currency)}${fmtMoney(w.usedMoney)} / ${currencySymbol(currency)}${fmtMoney(w.limitMoney)}`
		  } else if (w.limitTokens) {
		    bar = h('div', { className: 'qm-wtrack' },
		      h('div', { className: 'qm-wfill', style: { width: `${Math.min(100, (w.usedTokens / w.limitTokens) * 100).toFixed(1)}%`, background: ratioColor(w.usedTokens, w.limitTokens) } }))
		    text = `${fmt(w.usedTokens)} / ${fmt(w.limitTokens)} tok`
		  } else {
		    text = `${fmt(w.usedTokens)} tok`
		  }
		  return h('div', { className: 'qm-wrow' },
		    h('span', { className: 'qm-wlabel', title }, w.label),
		    bar,
		    h('span', { className: 'qm-wtext' }, text))
		}

		function ProviderBlock({ snap }) {
		  // content clicks (usage info, flip card) must not bubble up to the
		  // card button's refresh handler — that made every info click trigger
		  // the whole-card refresh animation
		  const stop = (e) => e.stopPropagation()
		  const head = h('div', { className: 'qm-head' },
		    h('span', { style: { ...S.dot, background: statusColor(snap) } }),
		    h('span', { className: 'qm-name', title: snap.provider }, snap.provider),
		    h('span', { className: 'qm-value' }, headValue(snap)))
		  const today = snap.todayUsed ? h(TodayBlock, { t: snap.todayUsed }) : null
		  if (snap.error) {
		    const msg = snap.error === 'no-key'
		      ? '未配置 API Key（设置 → 额度监控）'
		      : snap.error === 'no-url'
		        ? '未配置查询地址'
		        : `查询失败（${snap.error}）`
		    return h('div', { className: 'qm-provider', onClick: stop },
		      head,
		      h('div', { className: 'qm-err' }, msg))
		  }
		  if (snap.kind === 'balance') {
		    const b = snap.balance
		    const sym = currencySymbol(b && b.currency)
		    const used = b && b.used != null
		      ? h('div', { className: 'qm-sub' }, `已用 ${sym}${fmtMoney(Number(b.used))}${b.total != null ? ` / 总额 ${sym}${fmtMoney(Number(b.total))}` : ''}`)
		      : null
		    return h('div', { className: 'qm-provider', onClick: stop }, head, used, today)
		  }
		  if (snap.kind === 'windows') {
		    return h('div', { className: 'qm-provider', onClick: stop },
		      head,
		      ...(snap.windows || []).map((w) => h(WindowRow, { key: w.label, w, currency: snap.currency })),
		      today)
		  }
		  return h('div', { className: 'qm-provider', onClick: stop },
		    head,
		    h('div', { className: 'qm-err' }, '不支持的额度类型'))
		}

		function QuotaWidget(props) {
		  const wide = props.wide !== false
		  const [snapshots, setSnapshots] = useState(null)
		  const [error, setError] = useState(null)
		  const [toast, setToast] = useState(null) // { seq, text } — manual refresh feedback

		  const load = useCallback(async () => {
		    try {
		      const res = await fetch('/api/quota-monitor', { cache: 'no-store' })
		      if (!res.ok) throw new Error(`HTTP ${res.status}`)
		      const data = await res.json()
		      const list = Array.isArray(data) ? data : []
		      setSnapshots(list)
		      setError(null)
		      return { ok: true, count: list.length }
		    } catch (e) {
		      setError(String((e && e.message) ?? e))
		      return { ok: false }
		    }
		  }, [])

		  useEffect(() => {
		    load()
		    const t = setInterval(load, 5 * 60 * 1000)
		    widgetRefresh = load
		    return () => { clearInterval(t); if (widgetRefresh === load) widgetRefresh = null }
		  }, [load])

		  // manual refresh only: auto-refresh (setInterval) and config-change
		  // refreshes (widgetRefresh) keep calling load() directly, so no toast.
		  // Toast shows only when there is something to say: data refreshed, or
		  // the refresh failed; an empty result stays quiet.
		  const manualRefresh = useCallback(async () => {
		    const result = await load()
		    if (result.ok && result.count > 0) {
		      setToast((t) => ({ seq: (t?.seq ?? 0) + 1, text: '额度已刷新' }))
		    } else if (!result.ok) {
		      setToast((t) => ({ seq: (t?.seq ?? 0) + 1, text: '刷新失败' }))
		    }
		  }, [load])

		  const card = (title, ...children) =>
		    h('button', {
		      className: 'qm-card', type: 'button', title,
		      onClick: manualRefresh,
		      onKeyDown: (e) => { if (e.key === 'Enter') manualRefresh() },
		    }, ...children)

		  // transient top-center banner, centered on the viewport (no anchor);
		  // keyed by seq so repeated clicks restart the cycle
		  const toastEl = toast
		    ? h(Toast, { key: toast.seq, text: toast.text, onDone: () => setToast((t) => (t && t.seq === toast.seq ? null : t)) })
		    : null

		  if (!wide) {
		    const snap = snapshots && snapshots[0]
		    const content = !snap
		      ? error ? '—' : '…'
		      : snap.error
		        ? '!'
		        : snap.kind === 'balance'
		          ? `${snap.balance ? `${snap.balance.currency ?? '¥'} ${(snap.balance.remaining ?? snap.balance.total) ?? '—'}${typeof snap.rateMultiplier === 'number' && Number.isFinite(snap.rateMultiplier) ? ` · x${Math.round(snap.rateMultiplier * 100) / 100}` : ''}` : '—'}`
		          : snap.kind === 'windows'
		            ? (() => {
		                const rows = snap.windows || []
		                const tight = rows
		                  .map((w) => {
		                    const p = w.percent != null ? w.percent
		                      : w.limitMoney != null && w.limitMoney > 0 ? (w.usedMoney / w.limitMoney) * 100
		                        : w.limitTokens ? (w.usedTokens / w.limitTokens) * 100
		                          : null
		                    return { w, p }
		                  })
		                  .filter((x) => x.p != null)
		                  .sort((a, b) => b.p - a.p)[0]
		                if (tight) {
		                  if (tight.w.percent != null) return `${tight.w.label} ${tight.w.percent}%`
		                  if (tight.w.limitMoney != null) return `${tight.w.label} ${fmtMoney(tight.w.usedMoney)}/${fmtMoney(tight.w.limitMoney)}`
		                  return `${tight.w.label} ${fmt(tight.w.usedTokens)}/${fmt(tight.w.limitTokens)}`
		                }
		                return rows[0] ? `${rows[0].label} ${fmt(rows[0].usedTokens)}tok` : '—'
		              })()
		            : '—'
		    const color = snap ? statusColor(snap) : TOK.text3
		    return h(React.Fragment, null,
		      card('额度监控（点击刷新）',
		        h('span', { style: { ...S.dot, background: color } }),
		        h('span', { style: S.mini }, content)),
		      toastEl)
		  }

		  return h(React.Fragment, null,
		    card('额度监控（点击刷新）',
		      error ? h('div', { className: 'qm-err' }, `无法连接：${error}`) : null,
		      ...(snapshots || []).map((snap) => h(ProviderBlock, { key: snap.provider, snap })),
		      (snapshots && snapshots.length === 0 && !error) ? h('div', { className: 'qm-sub' }, '暂无数据') : null),
		    toastEl)
		}

		// ---------------------------------------------------------------------
		// settings section (Models-page structure)
		// ---------------------------------------------------------------------

		const EMPTY_PROVIDER = { kind: 'windows', url: '', apiKeyEnv: '', parse: undefined, windows: undefined, lowBalanceThreshold: undefined }
		const BUILTIN_OPTIONS = ['', 'deepseek-balance', 'opencode-go-usage', 'generic-balance', 'generic-percent-windows', 'new-api-self', 'sub2api-usage', 'sub2api-platform-quotas']

		function cleanJson(value) {
		  if (value === undefined || value === null) return undefined
		  if (Array.isArray(value)) return value.map(cleanJson).filter((v) => v !== undefined)
		  if (typeof value === 'object') {
		    const out = {}
		    for (const [k, v] of Object.entries(value)) {
		      const c = cleanJson(v)
		      if (c !== undefined) out[k] = c
		    }
		    return out
		  }
		  return value
		}

		let QUOTA_API = null // set from the plugin ctx in apply()
		let widgetRefresh = null // QuotaWidget's load(); QuotaSettings fires it after config changes

		function QuotaSettings() {
		  const api = QUOTA_API
		  const [view, setView] = useState(null)
		  const [creds, setCreds] = useState({})
		  const [keyDrafts, setKeyDrafts] = useState({})
		  const [presets, setPresets] = useState(null)
		  const [systemProviders, setSystemProviders] = useState([])
		  const [addKey, setAddKey] = useState('')
		  const [baseKeys, setBaseKeys] = useState(new Set())
		  const [userKeys, setUserKeys] = useState(new Set())
		  const [autoProviders, setAutoProviders] = useState([]) // read-only auto-discovered
		  const [newWindow, setNewWindow] = useState({ label: '', seconds: '', limitTokens: '' })
		  const [newName, setNewName] = useState('')
		  const [newKind, setNewKind] = useState('windows')
		  const [busy, setBusy] = useState(false)
		  const [saved, setSaved] = useState(false)
		  const [failure, setFailure] = useState(null)
		  const [editing, setEditing] = useState(null) // provider with open editor
		  const [addOpen, setAddOpen] = useState(false)
		  const [declaring, setDeclaring] = useState(false)
		  const [deleteTarget, setDeleteTarget] = useState(null) // product Modal confirm
		  const [deleting, setDeleting] = useState(false)
		  const CUSTOM_KEY = '__custom__'

		  const load = useCallback(async () => {
		    if (!api) return
		    try {
		      const res = await fetch('/api/quota-monitor/settings', { cache: 'no-store' })
		      const out = await res.json().catch(() => ({}))
		      if (!res.ok || out.error) throw new Error(out.error || out.message || `HTTP ${res.status}`)
		      const value = out.value || { providers: {}, lowBalanceThreshold: 20, refreshMs: 300000 }
		      setView({
		        providers: value.providers || {},
		        lowBalanceThreshold: value.lowBalanceThreshold ?? 20,
		        refreshMs: value.refreshMs ?? 300000,
		        autoDiscover: value.autoDiscover !== false,
		        disabledProviders: value.disabledProviders || {},
		      })
		      const layerKeys = (layer) => {
		        const p = layer && layer.providers
		        return p && typeof p === 'object' ? new Set(Object.keys(p)) : new Set()
		      }
		      setBaseKeys(layerKeys(out.base))
		      setUserKeys(layerKeys(out.user))
		      setAutoProviders(Array.isArray(out.autoProviders) ? out.autoProviders : [])
		      const refs = [...new Set(Object.values(value.providers || {}).map((p) => p.apiKeyEnv).filter(Boolean))]
		      let credsMap = {}
		      if (refs.length) {
		        const c = await api.credentials.describe({ refs })
		        if (c.result.ok) credsMap = c.result.value.credentials || {}
		      }
		      setCreds(credsMap)
		    } catch (e) {
		      setFailure(String((e && e.message) ?? e))
		    }
		  }, [api])

		  useEffect(() => { load() }, [load])

		  useEffect(() => {
		    let alive = true
		    fetch('/api/quota-monitor/presets', { cache: 'no-store' })
		      .then((r) => r.ok ? r.json() : null)
		      .then((data) => {
		        if (!alive || !data) return
		        setPresets(data.presets || {})
		        setSystemProviders(Array.isArray(data.systemProviders) ? data.systemProviders : [])
		      })
		      .catch(() => {})
		    return () => { alive = false }
		  }, [])

		  if (!api || !view) {
		    return h('div', { className: 'qm-section' },
		      h('h3', { className: 'qm-title' }, '额度监控'),
		      h('p', { className: 'qm-intro' }, failure ? `加载失败：${failure}` : '加载中…'))
		  }

		  const patchGlobal = (patch) => { setSaved(false); setView((v) => ({ ...v, ...patch })) }
		  const patchProvider = (name, patch) => {
		    setSaved(false)
		    setView((v) => ({ ...v, providers: { ...v.providers, [name]: { ...v.providers[name], ...patch } } }))
		  }
		  const patchWindow = (name, i, patch) => {
		    setSaved(false)
		    setView((v) => {
		      const wins = [...((v.providers[name] && v.providers[name].windows) || [])]
		      wins[i] = { ...wins[i], ...patch }
		      return { ...v, providers: { ...v.providers, [name]: { ...v.providers[name], windows: wins } } }
		    })
		  }
		  const removeWindow = (name, i) => {
		    setSaved(false)
		    setView((v) => {
		      const wins = [...((v.providers[name] && v.providers[name].windows) || [])]
		      wins.splice(i, 1)
		      return { ...v, providers: { ...v.providers, [name]: { ...v.providers[name], windows: wins } } }
		    })
		  }
		  const addWindow = (name) => {
		    const seconds = Number(newWindow.seconds)
		    if (!newWindow.label.trim() || !Number.isFinite(seconds) || seconds <= 0) return
		    setSaved(false)
		    const limitTokens = newWindow.limitTokens.trim() ? Number(newWindow.limitTokens) : undefined
		    setView((v) => {
		      const wins = [...((v.providers[name] && v.providers[name].windows) || [])]
		      wins.push({ label: newWindow.label.trim(), seconds, limitTokens: Number.isFinite(limitTokens) ? limitTokens : undefined })
		      return { ...v, providers: { ...v.providers, [name]: { ...v.providers[name], windows: wins } } }
		    })
		    setNewWindow({ label: '', seconds: '', limitTokens: '' })
		  }
		  const addCustom = () => {
		    const name = newName.trim()
		    if (!name || view.providers[name]) return
		    setSaved(false)
		    setView((v) => ({ ...v, providers: { ...v.providers, [name]: { ...EMPTY_PROVIDER, kind: newKind } } }))
		    setNewName('')
		    setDeclaring(false)
		    setEditing(name)
		  }
		  /** Add by selection: config key = provider id, preset fills everything. */
		  const addSelected = () => {
		    const id = addKey
		    const p = presets && presets[id]
		    if (!id || view.providers[id]) return
		    setSaved(false)
		    setView((v) => ({
		      ...v,
		      providers: {
		        ...v.providers,
		        [id]: p
		          ? { kind: p.kind, url: p.url, apiKeyEnv: p.apiKeyEnv, parse: p.parse, currency: p.currency }
		          : { ...EMPTY_PROVIDER, currency: 'CNY' },
		      },
		    }))
		    setAddKey('')
		    setAddOpen(false)
		    setEditing(id)
		  }
		  /** Execute the deletion after the product Modal confirms. */
		  const confirmDelete = async () => {
		    const name = deleteTarget
		    if (!name) return
		    const fromProfile = baseKeys.has(name) && !userKeys.has(name)
		    setDeleting(true)
		    setSaved(false)
		    setFailure(null)
		    if (fromProfile) {
		      setBusy(true)
		      try {
		        const res = await fetch('/api/quota-monitor/settings', {
		          method: 'POST',
		          headers: { 'content-type': 'application/json' },
		          body: JSON.stringify({ action: 'remove-provider', provider: name }),
		        })
		        const out = await res.json().catch(() => ({}))
		        if (!res.ok || out.ok === false) throw new Error(out.message || `HTTP ${res.status}`)
		        setView((v) => {
		          const providers = { ...v.providers }
		          delete providers[name]
		          return { ...v, providers }
		        })
		        setBaseKeys((s) => { const n = new Set(s); n.delete(name); return n })
		        setEditing(null)
		        setSaved(true)
		        setFailure(out.restartRequired === true ? '已从 profile 配置移除（重启后完全生效）' : '已从 profile 配置移除（热重载生效）')
		        if (widgetRefresh) widgetRefresh()
		      } catch (e) {
		        setFailure(String((e && e.message) ?? e))
		      } finally {
		        setBusy(false)
		        setDeleting(false)
		        setDeleteTarget(null)
		      }
		      return
		    }
		    // user-layer providers: confirm, then remove locally AND persist
		    // immediately — no batch save needed for deletions
		    setBusy(true)
		    try {
		      const res = await fetch('/api/quota-monitor/settings', {
		        method: 'POST',
		        headers: { 'content-type': 'application/json' },
		        body: JSON.stringify({ ops: [{ op: 'unset', path: ['providers', name] }] }),
		      })
		      const out = await res.json().catch(() => ({}))
		      if (!res.ok || out.ok === false) throw new Error(out.message || `HTTP ${res.status}`)
		      setView((v) => {
		        const providers = { ...v.providers }
		        delete providers[name]
		        return { ...v, providers }
		      })
		      setUserKeys((s) => { const n = new Set(s); n.delete(name); return n })
		      setEditing(null)
		      setSaved(true)
		      setFailure(null)
		      if (widgetRefresh) widgetRefresh()
		    } catch (e) {
		      setFailure(`移除失败：${(e && e.message) ?? e}`)
		    } finally {
		      setBusy(false)
		      setDeleting(false)
		      setDeleteTarget(null)
		    }
		  }
		  const saveKey = async (name) => {
		    const p = view.providers[name]
		    const ref = (p.apiKeyEnv || '').trim()
		    const value = (keyDrafts[name] || '').trim()
		    if (!ref || !value) return
		    setBusy(true)
		    try {
		      const r = await api.credentials.set({ ref, value })
		      if (!r.result.ok) throw new Error(r.result.error.message)
		      setKeyDrafts((d) => ({ ...d, [name]: '' }))
		      setCreds((c) => ({ ...c, [ref]: { configured: true } }))
		      // no global "已保存": only the credential changed, not the config
		    } catch (e) {
		      setFailure(String((e && e.message) ?? e))
		    } finally {
		      setBusy(false)
		    }
		  }
		  const clearKey = async (name) => {
		    const ref = (view.providers[name].apiKeyEnv || '').trim()
		    if (!ref) return
		    setBusy(true)
		    try {
		      const r = await api.credentials.unset({ ref })
		      if (!r.result.ok) throw new Error(r.result.error.message)
		      setCreds((c) => { const n = { ...c }; delete n[ref]; return n })
		    } catch (e) {
		      setFailure(String((e && e.message) ?? e))
		    } finally {
		      setBusy(false)
		    }
		  }
		  /** Enable/disable one provider (auto-discovered or manual) immediately. */
		  const toggleDisabled = async (name, disabled) => {
		    setBusy(true)
		    setSaved(false)
		    setFailure(null)
		    try {
		      const ops = disabled
		        ? [{ op: 'set', path: ['disabledProviders', name], value: true }]
		        : [{ op: 'unset', path: ['disabledProviders', name] }]
		      const res = await fetch('/api/quota-monitor/settings', {
		        method: 'POST',
		        headers: { 'content-type': 'application/json' },
		        body: JSON.stringify({ ops }),
		      })
		      const out = await res.json().catch(() => ({}))
		      if (!res.ok || out.ok === false) throw new Error(out.message || `HTTP ${res.status}`)
		      setView((v) => {
		        const d = { ...v.disabledProviders }
		        if (disabled) d[name] = true
		        else delete d[name]
		        return { ...v, disabledProviders: d }
		      })
		      // auto-discovered rows render their state from the autoProviders
		      // list, so keep it in sync or the toggle button would not reflect
		      // the change
		      setAutoProviders((list) => list.map((p) => (p.provider === name ? { ...p, disabled } : p)))
		      if (widgetRefresh) widgetRefresh()
		    } catch (e) {
		      setFailure(String((e && e.message) ?? e))
		    } finally {
		      setBusy(false)
		    }
		  }
		  const save = async () => {
		    setBusy(true)
		    setSaved(false)
		    setFailure(null)
		    try {
		      const providers = {}
		      for (const [name, p] of Object.entries(view.providers)) {
		        const kind = p.kind || 'windows'
		        providers[name] = cleanJson({
		          kind,
		          ...(p.url ? { url: p.url.trim() } : {}),
		          ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv.trim() } : {}),
		          ...(p.currency ? { currency: p.currency.trim().toUpperCase() } : {}),
		          ...(p.auth && p.auth !== 'bearer' ? { auth: p.auth } : {}),
		          ...(p.platform ? { platform: p.platform.trim() } : {}),
		          ...(p.headers && Object.keys(p.headers).length ? { headers: cleanJson(p.headers) } : {}),
		          ...(p.parse && (p.parse.builtin || p.parse.source || p.parse.file) ? { parse: cleanJson(p.parse) } : {}),
		          ...(kind === 'windows' && p.windows && p.windows.length ? { windows: cleanJson(p.windows) } : {}),
		          ...(kind === 'balance' && p.lowBalanceThreshold !== undefined && p.lowBalanceThreshold !== '' ? { lowBalanceThreshold: Number(p.lowBalanceThreshold) } : {}),
		        })
		      }
		      const ops = [
		        { op: 'set', path: ['providers'], value: providers },
		        { op: 'set', path: ['lowBalanceThreshold'], value: Number(view.lowBalanceThreshold) || 0 },
		        { op: 'set', path: ['refreshMs'], value: Number(view.refreshMs) || 300000 },
		        { op: 'set', path: ['autoDiscover'], value: view.autoDiscover !== false },
		        { op: 'set', path: ['disabledProviders'], value: view.disabledProviders || {} },
		      ]
		      const res = await fetch('/api/quota-monitor/settings', {
		        method: 'POST',
		        headers: { 'content-type': 'application/json' },
		        body: JSON.stringify({ ops }),
		      })
		      const out = await res.json().catch(() => ({}))
		      if (!res.ok || out.ok === false) throw new Error(out.message || `HTTP ${res.status}`)
		      setSaved(true)
		      if (widgetRefresh) widgetRefresh()
		      return true
		    } catch (e) {
		      setFailure(String((e && e.message) ?? e))
		      return false
		    } finally {
		      setBusy(false)
		    }
		  }

		  // ---- render helpers ----
		  const input = (props) => h('input', { className: 'qm-input', ...props })
		  const fld = (label, body, hint) => h('div', { className: 'qm-field' },
		    h('span', { className: 'qm-fieldLabel' }, label),
		    body,
		    hint ? h('p', { className: 'qm-hint' }, hint) : null)

		  const globalWin = (view.windows && view.windows.length) ? view.windows : [{ label: '5h', seconds: 18000 }, { label: '7d', seconds: 604800 }, { label: '1m', seconds: 2592000 }]

		  /** The inline editor for one provider (Models-page editor card). */
		  const providerEditor = (name, opts) => {
		    const p = view.providers[name]
		    const cred = p.apiKeyEnv ? creds[p.apiKeyEnv] : undefined
		    const wins = (p.windows && p.windows.length) ? p.windows : globalWin
		    const kindLabel = (p.kind || 'windows') === 'balance' ? '余额' : '限额'
		    return h('div', { className: 'qm-editor' },
		      opts && opts.hideHeader ? null : h('div', { className: 'qm-editorHeader' },
		        h('span', { className: 'qm-editorTitle' }, `${kindLabel}额度配置`),
		        h('span', { className: 'qm-editorRoute' }, name)),
		      h('div', { className: 'qm-grid3' },
		        fld('额度类型', h('select', { className: 'qm-input', value: p.kind || 'windows', onChange: (e) => patchProvider(name, { kind: e.target.value }) },
		          h('option', { value: 'balance' }, '余额（查询 API）'),
		          h('option', { value: 'windows' }, '限额（本地用量统计）'))),
		        fld('认证方式', h('select', { className: 'qm-input', value: p.auth || 'bearer', onChange: (e) => patchProvider(name, { auth: e.target.value }) },
		          h('option', { value: 'bearer' }, 'Bearer'),
		          h('option', { value: 'raw' }, '原样')), 'Bearer 前缀 / 原样发送（如 new-api）'),
		        fld('币种', input({ type: 'text', placeholder: 'CNY/USD', value: p.currency || '', onChange: (e) => patchProvider(name, { currency: e.target.value }) }), '金额显示单位')),
		      fld('查询地址', input({ type: 'text', placeholder: 'https://api.deepseek.com/user/balance', value: p.url || '', onChange: (e) => patchProvider(name, { url: e.target.value }) })),
		      fld('API Key',
		        h('div', { className: 'qm-row' },
		          input({ className: 'qm-input qm-grow', type: 'text', placeholder: '凭据引用名，如 DEEPSEEK_API_KEY', value: p.apiKeyEnv || '', onChange: (e) => patchProvider(name, { apiKeyEnv: e.target.value }) })),
		        h('div', { className: 'qm-row' },
		          input({ className: 'qm-input qm-grow', type: 'password', placeholder: cred ? '已配置，输入新值覆盖' : '输入 API Key', value: keyDrafts[name] || '', onChange: (e) => setKeyDrafts((d) => ({ ...d, [name]: e.target.value })) }),
		          h('button', { type: 'button', className: 'qm-btnSecondary', disabled: busy, onClick: () => saveKey(name) }, '保存'),
		          cred ? h('button', { type: 'button', className: 'qm-btnDanger', disabled: busy, onClick: () => clearKey(name) }, '清除') : null)),
		      fld('JS 解析器（内置 / 脚本文件 / 粘贴代码）',
		        h('select', { className: 'qm-input', value: (p.parse && p.parse.builtin) || '', onChange: (e) => patchProvider(name, { parse: { ...(p.parse || {}), builtin: e.target.value } }) },
		          BUILTIN_OPTIONS.map((b) => h('option', { key: b, value: b }, b ? b : '（无内置）'))),
		        input({ type: 'text', placeholder: '脚本文件路径，如 C:/quota/opencode-go.js（默认导出函数）', value: (p.parse && p.parse.file) || '', onChange: (e) => patchProvider(name, { parse: { ...(p.parse || {}), file: e.target.value } }) }),
		        h('textarea', { className: 'qm-input qm-textarea', placeholder: '粘贴解析函数，如 (raw) => ({ kind: "windows", windows: raw.map(w => ({ label: w.period, limitTokens: w.limit })) })', value: (p.parse && p.parse.source) || '', onChange: (e) => patchProvider(name, { parse: { ...(p.parse || {}), source: e.target.value } }) })),
		      fld('平台', input({ type: 'text', placeholder: '多平台网关选择，如 claude / openai / gemini', value: p.platform || '', onChange: (e) => patchProvider(name, { platform: e.target.value }) }), 'sub2api 等网关的平台选择（留空取默认）'),
		      p.kind === 'windows'
		        ? fld('限额窗口',
		            h('div', { className: 'qm-field' },
		              h('div', { className: 'qm-windowHead' }, h('span', null, '标签'), h('span', null, '秒'), h('span', null, '限额(tok)'), h('span', null, '示例'), h('span', null, '')),
		              ...wins.map((w, i) => h('div', { key: i, className: 'qm-windowGrid' },
		                input({ value: w.label, onChange: (e) => patchWindow(name, i, { label: e.target.value }) }),
		                input({ value: w.seconds, type: 'number', onChange: (e) => patchWindow(name, i, { seconds: Number(e.target.value) }) }),
		                input({ value: w.limitTokens ?? '', type: 'number', placeholder: '不限', onChange: (e) => patchWindow(name, i, { limitTokens: e.target.value === '' ? undefined : Number(e.target.value) }) }),
		                h('span', { className: 'qm-hint' }, fmtHint(w)),
		                h('button', { type: 'button', className: 'qm-btnDanger', style: { borderRadius: 8, height: 28, padding: '0 8px' }, onClick: () => removeWindow(name, i) }, '✕'))),
		              h('div', { className: 'qm-windowGrid' },
		                input({ placeholder: '5h', value: newWindow.label, onChange: (e) => setNewWindow((w) => ({ ...w, label: e.target.value })) }),
		                input({ placeholder: '18000', type: 'number', value: newWindow.seconds, onChange: (e) => setNewWindow((w) => ({ ...w, seconds: e.target.value })) }),
		                input({ placeholder: '限额 tok', type: 'number', value: newWindow.limitTokens, onChange: (e) => setNewWindow((w) => ({ ...w, limitTokens: e.target.value })) }),
		                h('span', null),
		                h('button', { type: 'button', className: 'qm-btnSecondary', onClick: () => addWindow(name) }, '添加窗口'))))
		        : null,
		      p.kind === 'balance'
		        ? fld('低额阈值', input({ className: 'qm-input qm-w80', type: 'number', placeholder: String(view.lowBalanceThreshold), title: '低于此值卡片转警示色（留空继承全局）', value: p.lowBalanceThreshold ?? '', onChange: (e) => patchProvider(name, { lowBalanceThreshold: e.target.value === '' ? undefined : Number(e.target.value) }) }))
		        : null,
		      h('div', { className: 'qm-editorActions' },
		        h('button', { type: 'button', className: 'qm-btnPrimary', disabled: busy, onClick: async () => { if (await save()) setEditing(null) } }, '保存并关闭'),
		        h('button', { type: 'button', className: 'qm-btnSecondary', disabled: busy, onClick: () => setEditing(null) }, '取消')))
		  }

		  const providerNames = Object.keys(view.providers)
		  const rows = providerNames.map((name) => {
		    const p = view.providers[name]
		    const cred = p.apiKeyEnv ? creds[p.apiKeyEnv] : undefined
		    const fromProfile = baseKeys.has(name) && !userKeys.has(name)
		    const disabled = !!view.disabledProviders[name]
		    const open = editing === name
		    return h('li', { key: name, className: `qm-rowCard${disabled ? ' qm-rowDisabled' : ''}` },
		      h('div', { className: 'qm-rowHead' },
		        h('span', { className: 'qm-rowIdentity' },
		          h('span', { className: 'qm-rowName' }, name),
		          fromProfile ? h('span', { className: 'qm-rowTag' }, 'profile 配置') : null,
		          disabled ? h('span', { className: 'qm-rowTag' }, '已禁用') : null,
		          p.apiKeyEnv && cred
		            ? h('span', { className: 'qm-credDot qm-credDotC', role: 'img', title: '已配置' })
		            : p.apiKeyEnv
		              ? h('span', { className: 'qm-credDot qm-credDotM', role: 'img', title: '未配置' })
		              : null),
		        h('span', { className: 'qm-rowActions' },
		          h('button', { type: 'button', className: 'qm-btnSecondary', onClick: () => { setAddOpen(false); setDeclaring(false); setEditing(open ? null : name) } }, '编辑'),
		          h('button', {
		            type: 'button', className: 'qm-btnDanger', disabled: busy || deleting,
		            title: fromProfile ? '从配置中移除（profile 条目同步移除）' : '移除',
		            onClick: () => { setAddOpen(false); setDeclaring(false); setEditing(null); setDeleteTarget(name) },
		          }, '删除'),
		          h('button', {
		            type: 'button', className: `qm-toggleBtn${disabled ? '' : ' qm-toggleOff'}`, disabled: busy,
		            title: disabled ? '恢复监控此供应商' : '暂停监控此供应商（配置保留）',
		            onClick: () => toggleDisabled(name, !disabled),
		          }, disabled ? '启用' : '禁用'))),
		      open ? providerEditor(name) : null)
		  })

		  const addSelect = h('select', { className: 'qm-input', value: addKey, onChange: (e) => setAddKey(e.target.value) },
		    h('option', { value: '' }, '选择供应商…'),
		    systemProviders.length ? h('optgroup', { label: '系统内已注册' },
		      systemProviders.map((s) => h('option', { key: s.id, value: s.id }, `${s.name}（${s.id}）`))) : null,
		    h('optgroup', { label: '预设方案' },
		      Object.keys(presets || {})
		        .filter((k) => !systemProviders.some((s) => s.id === k))
		        .map((k) => h('option', { key: k, value: k }, `${presets[k].label}（${k}）`))),
		    h('option', { value: CUSTOM_KEY }, '自定义…'))

		  const autoRows = autoProviders.length
		    ? h('div', { key: 'auto-group' },
		        h('p', { className: 'qm-hint', style: { margin: '12px 0 0' } }, '自动监控（带预设的官方供应商；可单独禁用，关闭自动监控后不再显示）'),
		        h('ul', { className: 'qm-rows' },
		          ...autoProviders.map((p) => h('li', { key: p.provider, className: `qm-rowCard${p.disabled ? ' qm-rowDisabled' : ''}` },
		            h('div', { className: 'qm-rowHead' },
		              h('span', { className: 'qm-rowIdentity' },
		                h('span', { className: 'qm-rowName' }, p.name),
		                h('span', { className: 'qm-rowTag' }, '自动发现'),
		                p.disabled ? h('span', { className: 'qm-rowTag' }, '已禁用') : null),
		              h('span', { className: 'qm-rowActions' },
		                h('span', { className: 'qm-hint' }, `${p.kind === 'balance' ? '余额' : '限额'} · 预设自动查询`),
		                h('button', {
		                  type: 'button', className: `qm-toggleBtn${p.disabled ? '' : ' qm-toggleOff'}`, disabled: busy,
		                  title: p.disabled ? '恢复监控此供应商' : '暂停监控此供应商',
		                  onClick: () => toggleDisabled(p.provider, !p.disabled),
		                }, p.disabled ? '启用' : '禁用')))))))
		    : null

		  const addBlock = h('div', { className: 'qm-addBlock' },
		    h('div', { className: 'qm-addActions' },
		      h('button', { type: 'button', className: 'qm-btnAdd', onClick: () => { setAddOpen(!addOpen); setDeclaring(false) } }, addOpen ? '收起' : '＋ 添加供应商'),
		      h('button', { type: 'button', className: 'qm-btnSecondary qm-addActionBtn', onClick: () => { setDeclaring(!declaring); setAddOpen(false) } }, '自定义…')),
		    addOpen
		      ? h('div', { className: 'qm-addCard' },
		          fld('供应商', addSelect,
		            addKey === CUSTOM_KEY ? '自定义供应商在下方填写' : (addKey ? (presets && presets[addKey] ? presets[addKey].note : '系统供应商：本地流量自动归入此卡') : '优先选择系统内已注册的供应商，名称自动使用路由 id')),
		          addKey && addKey !== CUSTOM_KEY
		            ? h('div', { className: 'qm-editorActions' },
		                h('button', { type: 'button', className: 'qm-btnPrimary', disabled: !!view.providers[addKey], onClick: () => addSelected() }, '添加并配置'))
		            : addKey === CUSTOM_KEY
		              ? h('div', { className: 'qm-field' },
		                  h('div', { className: 'qm-row' },
		                    input({ className: 'qm-input qm-grow', type: 'text', placeholder: '供应商名称（外部订阅账号等）', value: newName, onChange: (e) => setNewName(e.target.value) }),
		                    h('select', { className: 'qm-input qm-w110', value: newKind, onChange: (e) => setNewKind(e.target.value) },
		                      h('option', { value: 'windows' }, '限额型'),
		                      h('option', { value: 'balance' }, '余额型')),
		                    h('button', { type: 'button', className: 'qm-btnPrimary', disabled: !newName.trim() || !!view.providers[newName.trim()], onClick: () => addCustom() }, '创建')))
		              : null)
		      : null,
		    declaring
		      ? h('div', { className: 'qm-addCard' },
		          fld('自定义供应商', h('div', { className: 'qm-row' },
		            input({ className: 'qm-input qm-grow', type: 'text', placeholder: '供应商名称（外部订阅账号等）', value: newName, onChange: (e) => setNewName(e.target.value) }),
		            h('select', { className: 'qm-input qm-w110', value: newKind, onChange: (e) => setNewKind(e.target.value) },
		              h('option', { value: 'windows' }, '限额型'),
		              h('option', { value: 'balance' }, '余额型')),
		            h('button', { type: 'button', className: 'qm-btnPrimary', disabled: !newName.trim() || !!view.providers[newName.trim()], onClick: () => addCustom() }, '创建')),
		            '名称需与路由 id 一致才能关联本地流量'))
		      : null)

		  const globalCard = h('div', { className: 'qm-editor' },
		    h('div', { className: 'qm-editorHeader' },
		      h('span', { className: 'qm-editorTitle' }, '全局设置'),
		      h('span', { className: 'qm-editorRoute' }, '阈值 · 刷新 · 自动发现')),
		    h('label', { className: 'qm-checkRow' },
		      h('input', { type: 'checkbox', checked: view.autoDiscover !== false, onChange: (e) => patchGlobal({ autoDiscover: e.target.checked }) }),
		      '自动监控系统内已注册的 LLM 供应商'),
		    h('div', { className: 'qm-row' },
		      h('span', { className: 'qm-fieldLabel' }, '低额阈值'),
		      h('input', { className: 'qm-input qm-w80', type: 'number', value: view.lowBalanceThreshold, onChange: (e) => patchGlobal({ lowBalanceThreshold: e.target.value }) }),
		      h('span', { className: 'qm-fieldLabel' }, '刷新间隔(秒)'),
		      h('input', { className: 'qm-input qm-w80', type: 'number', value: view.refreshMs / 1000, onChange: (e) => patchGlobal({ refreshMs: Number(e.target.value) * 1000 }) })),
		    h('div', { className: 'qm-editorActions' },
		      h('button', { type: 'button', className: 'qm-btnPrimary', disabled: busy, onClick: () => save() }, '保存'),
		      saved ? h('p', { className: 'qm-saved' }, '已保存') : null,
		      failure ? h('p', { className: 'qm-fail' }, failure) : null))

		  const deleteDialog = deleteTarget !== null
		    ? h(Modal, {
		        open: true,
		        onClose: () => { if (!deleting) setDeleteTarget(null) },
		        title: `删除 ${deleteTarget}？`,
		        description: baseKeys.has(deleteTarget) && !userKeys.has(deleteTarget)
		          ? '该条目来自 profile 配置，删除会同步修改 cordis.patch.yml。'
		          : '删除后该供应商将不再监控。',
		        className: 'qm-deleteDialog',
		        footer: h(React.Fragment, null,
		          h(Button, { variant: 'outline', autoFocus: true, disabled: deleting, onClick: () => setDeleteTarget(null) }, '取消'),
		          h(Button, { variant: 'outline', disabled: deleting, onClick: () => confirmDelete() }, deleting ? '删除中…' : '删除')),
		      })
		    : null

		  return h('div', { className: 'qm-section' },
		    h('h3', { className: 'qm-title' }, '额度监控'),
		    h('p', { className: 'qm-intro' }, '监控各供应商额度：余额型走查询 API，限额型用本地用量统计。已注册的 LLM 供应商自动进入监控。'),
		    rows.length ? h('ul', { className: 'qm-rows' }, ...rows) : null,
		    autoRows,
		    addBlock,
		    h('div', { className: 'qm-divider', 'aria-hidden': true }),
		    globalCard,
		    deleteDialog)
		}

		function fmtHint(w) {
		  if (w.seconds === 5 * 3600) return '5 小时'
		  if (w.seconds === 7 * 86400) return '7 天'
		  if (w.seconds === 30 * 86400) return '1 个月'
		  if (w.seconds >= 86400) return `${Math.round(w.seconds / 86400)} 天`
		  if (w.seconds >= 3600) return `${Math.round(w.seconds / 3600)} 小时`
		  return `${w.seconds} 秒`
		}

		// ---------------------------------------------------------------------
		// plugin entry
		// ---------------------------------------------------------------------

		module.exports = {
		  inject: ['slots', 'connection'],
		  apply(ctx) {
		    QUOTA_API = ctx.get('connection')?.api ?? null
		    ensureWidgetCss()
		    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
		      { name: 'sidebar.footer.action', id: 'quota-monitor' },
		      QuotaWidget))
		    ctx.slots.inject('settings.section', () => ctx.slots.register(
		      { name: 'settings.section', id: 'quota-monitor-settings', label: '额度监控', order: 10 },
		      QuotaSettings))
		  },
		}
		return module.exports
	}
})
