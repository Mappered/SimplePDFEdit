import * as pdfjsLib from './vendor/pdf.min.mjs'
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs'

const $ = s => document.querySelector(s)
const originalEl = $('#original'), modifiedEl = $('#modified'), statusEl = $('#status'), pageInfo = $('#pageInfo'), editCountEl = $('#editCount')
let originalBytes = null, modifiedBytes = null, editCount = 0, zoom = Number($('#zoom').value)
const origState = { t: 0 }, modState = { t: 0 }
const b64ToBytes = b => { const x = atob(b), o = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) o[i] = x.charCodeAt(i); return o }
const setStatus = s => { statusEl.textContent = s }
const showErr = e => setStatus('Error: ' + (e?.message || e))

const PAGE_GAP = 14   // .page bottom margin, see style.css

// pdf.js transfers the bytes it is given to its worker, which detaches that buffer on
// this side. Every render must therefore get its own copy, otherwise the next render
// (zooming, or applying another edit) throws "An ArrayBuffer is detached and could not
// be cloned" when the bytes are posted to the worker again.
const copyBytes = d => (d ? d.slice() : d)

// Zoom slider helpers: the value is snapped to the slider's step so the control and
// the rendered scale always agree.
function setZoom(value) {
  const slider = $('#zoom')
  const step = Number(slider.step) || 0.05
  const snapped = Math.min(Number(slider.max), Math.max(Number(slider.min), Math.floor(value / step) * step))
  zoom = Number(snapped.toFixed(2))
  slider.value = zoom
  return zoom
}

// Scale at which one whole page fits inside the pane, so an A4 page is fully visible
// as soon as a document is opened.
async function fitPageZoom(el, bytes) {
  const pdf = await pdfjsLib.getDocument({ data: copyBytes(bytes) }).promise
  try {
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 })
    const cs = getComputedStyle(el)
    const availW = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const availH = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - PAGE_GAP
    return Math.min(availW / vp.width, availH / vp.height)
  } finally {
    await pdf.destroy()
  }
}

async function renderPanel(el, data, interactive, st) {
  const t = ++st.t
  el.replaceChildren()
  if (!data) {
    el.classList.add('empty')
    el.textContent = interactive ? 'Open a PDF.' : 'Modified preview appears here.'
    if (interactive) pageInfo.textContent = 'No document'
    return
  }
  el.classList.remove('empty')
  const pdf = await pdfjsLib.getDocument({ data: copyBytes(data) }).promise
  if (t !== st.t) { await pdf.destroy(); return }
  if (interactive) pageInfo.textContent = `${pdf.numPages} page(s) • ${zoom.toFixed(2)}x`
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p), vp = page.getViewport({ scale: zoom })
    const div = document.createElement('div')
    div.className = 'page'
    div.style.width = `${vp.width}px`
    div.style.height = `${vp.height}px`
    const c = document.createElement('canvas')
    c.width = vp.width | 0
    c.height = vp.height | 0
    div.appendChild(c)
    el.appendChild(div)
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise
    if (t !== st.t) { await pdf.destroy(); return }
    if (!interactive) continue
    const items = []
    for (const it of (await page.getTextContent()).items) {
      if (!it.str?.trim()) continue
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform)
      items.push({ tx, h: Math.max(6, Math.hypot(tx[0], tx[1])), w: Math.max(4, it.width * zoom), str: it.str })
    }
    items.sort((a, b) => b.tx[5] - a.tx[5] || a.tx[4] - b.tx[4])
    const lines = []
    for (const it of items) {
      const iw1 = it.tx[4] + it.w
      const ln = lines.find(l => Math.abs(l.y - it.tx[5]) <= 0.5 * Math.max(l.h, it.h) && Math.min(l.x1, iw1) - Math.max(l.x0, it.tx[4]) > -0.5 * Math.min(l.h, it.h))
      if (ln) { ln.items.push(it); ln.x0 = Math.min(ln.x0, it.tx[4]); ln.x1 = Math.max(ln.x1, iw1); ln.h = Math.max(ln.h, it.h) }
      else lines.push({ y: it.tx[5], h: it.h, items: [it], x0: it.tx[4], x1: iw1 })
    }
    for (const ln of lines) {
      const text = ln.items.slice().sort((a, b) => a.tx[4] - b.tx[4]).map(s2 => s2.str).join(' ')
      const sp = document.createElement('span')
      sp.className = 'text-hit'
      sp.textContent = text
      sp.title = text
      Object.assign(sp.style, { left: `${ln.x0}px`, top: `${ln.y - ln.h}px`, width: `${Math.max(4, ln.x1 - ln.x0)}px`, height: `${ln.h}px`, fontSize: `${ln.h}px` })
      sp.onclick = () => onText(p - 1, text)
      div.appendChild(sp)
    }
  }
  await pdf.destroy()
}

// Both panes show the same pages, so scrolling either one moves the other by the
// same relative amount. The lock keeps the mirrored scroll from echoing back.
const panes = [originalEl, modifiedEl]
let syncingScroll = false

function mirrorScroll(from, to) {
  const axis = (pos, size, client) => {
    const value = Math.round((from[pos] / Math.max(1, from[size] - from[client])) * Math.max(1, to[size] - to[client]))
    if (to[pos] !== value) to[pos] = value
  }
  axis('scrollTop', 'scrollHeight', 'clientHeight')
  axis('scrollLeft', 'scrollWidth', 'clientWidth')
}

for (const el of panes) {
  const other = el === originalEl ? modifiedEl : originalEl
  el.addEventListener('scroll', () => {
    if (syncingScroll) return
    syncingScroll = true
    mirrorScroll(el, other)
    requestAnimationFrame(() => { syncingScroll = false })
  }, { passive: true })
}

function ask(text) {
  return new Promise(res => {
    const d = $('#editDialog')
    $('#editPrompt').textContent = `Replace stream text: "${text}"`
    $('#replacement').value = text
    $('#replacement').select()
    d.returnValue = 'cancel'
    d.showModal()
    $('#replacement').focus()
    d.onclose = () => res(d.returnValue === 'ok' ? $('#replacement').value : null)
  })
}

async function onText(pageIndex, text) {
  if (!originalBytes) return
  const rep = await ask(text)
  if (rep === null || rep === text) return
  setStatus('Applying stream edit...')
  const r = await window.api.applyTextEdit({ pageIndex, text, replacement: rep })
  if (!r.ok || !r.dataBase64) {
    setStatus('Edit refused: ' + ((r.warnings || []).join(' ') || 'unknown'))
    return
  }
  modifiedBytes = b64ToBytes(r.dataBase64)
  editCount = r.editCount
  editCountEl.textContent = `${editCount} edit(s)`
  $('#saveBtn').disabled = false
  $('#resetBtn').disabled = false
  setStatus(r.warnings.length ? 'Applied with warning: ' + r.warnings.join(' ') : 'Applied stream edit.')
  await renderPanel(modifiedEl, modifiedBytes, false, modState)
}

async function loadPdf(r) {
  if (r.error) { setStatus('Failed to open: ' + r.error); return }
  if (r.canceled || !r.dataBase64) return
  originalBytes = b64ToBytes(r.dataBase64)
  // The right pane starts as a preview of the untouched document, so both sides show
  // the same pages until an edit replaces it.
  modifiedBytes = originalBytes
  editCount = 0
  editCountEl.textContent = '0 edits'
  $('#saveBtn').disabled = true
  $('#resetBtn').disabled = false
  setStatus('Opened ' + r.name)
  setZoom(await fitPageZoom(originalEl, originalBytes))
  await Promise.all([renderPanel(originalEl, originalBytes, true, origState), renderPanel(modifiedEl, modifiedBytes, false, modState)])
}

$('#openBtn').onclick = async () => { try { await loadPdf(await window.api.openPdf()) } catch (e) { showErr(e) } }
$('#saveBtn').onclick = async () => { try { const r = await window.api.saveAs(); if (!r.canceled && r.path) setStatus('Saved: ' + r.path) } catch (e) { showErr(e) } }
$('#resetBtn').onclick = async () => { try { await loadPdf(await window.api.reset()) } catch (e) { showErr(e) } }
$('#zoom').oninput = async () => {
  try {
    zoom = Number($('#zoom').value)
    await Promise.all([renderPanel(originalEl, originalBytes, true, origState), renderPanel(modifiedEl, modifiedBytes, false, modState)])
  } catch (e) { showErr(e) }
}
window.addEventListener('error', e => showErr(e.message))
window.addEventListener('unhandledrejection', e => showErr(e.reason))
if (!window.api) setStatus('Error: preload bridge not available (window.api missing).')
else window.api.onOpened(loadPdf)
