// Zoom regression test: drives the real renderer and re-renders several times.
//   runtime\electron.exe test
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { replaceTextInPdfBuffer } = require('../app/streamReplace')

const APP_DIR = path.join(__dirname, '..', 'app')
const RENDERER = path.join(APP_DIR, 'renderer', 'index.html')
const PDF = fs.readFileSync(path.join(__dirname, 'smoke.pdf'))
const PAGE_WIDTH = 612 // smoke.pdf MediaBox width
const TIMEOUT_MS = 60000

app.disableHardwareAcceleration()

// Minimal stand-in for the app's pdf:apply-text-edit handler, using the real pipeline.
let currentBytes = PDF
ipcMain.handle('pdf:apply-text-edit', (_e, edit) => {
  const r = replaceTextInPdfBuffer(currentBytes, edit)
  if (r.replacements !== 1) return { ok: false, warnings: r.warnings, editCount: 0 }
  currentBytes = r.data
  return { ok: true, dataBase64: r.data.toString('base64'), warnings: r.warnings, editCount: 1 }
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(win, expr, label) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`(() => { try { return !!(${expr}) } catch { return false } })()`)) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

async function main() {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { preload: path.join(APP_DIR, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  await win.loadFile(RENDERER)

  // Control: show the failure mode we are guarding against. pdf.js transfers the
  // buffer it is given, so reusing the same bytes throws on the second call.
  const control = await win.webContents.executeJavaScript(`(async () => {
    const pdfjs = await import('./vendor/pdf.min.mjs')
    pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs'
    const raw = Uint8Array.from(atob('${PDF.toString('base64')}'), c => c.charCodeAt(0))
    await pdfjs.getDocument({ data: raw }).promise
    try { await pdfjs.getDocument({ data: raw }).promise; return 'no error' } catch (e) { return String(e && e.message || e) }
  })()`)
  check('control: reusing a transferred buffer fails', /detached/i.test(control), control)

  win.webContents.send('pdf:opened', { canceled: false, path: 'smoke.pdf', name: 'smoke.pdf', dataBase64: PDF.toString('base64') })
  await waitFor(win, `document.querySelector('#original canvas') && document.querySelector('#modified canvas')`, 'first render of both panes')
  const fit = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('#original')
    const cs = getComputedStyle(pane)
    const c = pane.querySelector('canvas')
    return {
      zoom: Number(document.querySelector('#zoom').value),
      canvas: [c.width, c.height],
      avail: [
        pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        pane.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 14
      ],
      modified: [document.querySelector('#modified canvas').width, document.querySelector('#modified canvas').height]
    }
  })()`)
  check('open: whole page fits the pane', fit.canvas[0] <= fit.avail[0] + 1 && fit.canvas[1] <= fit.avail[1] + 1, JSON.stringify(fit))
  check('open: zoom was lowered from the 1.25 default to fit', fit.zoom < 1.25, `zoom=${fit.zoom}`)
  check('open: both panes use the same scale', fit.canvas[0] === fit.modified[0] && fit.canvas[1] === fit.modified[1], JSON.stringify(fit))
  const previewState = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('#modified')
    return { canvases: el.querySelectorAll('canvas').length, empty: el.classList.contains('empty'), saveDisabled: document.querySelector('#saveBtn').disabled }
  })()`)
  check('open: right pane previews the document', previewState.canvases === 1 && !previewState.empty && previewState.saveDisabled, JSON.stringify(previewState))

  for (const z of [2, 2.4, 1, 1.6]) {
    await win.webContents.executeJavaScript(`(() => { const el = document.querySelector('#zoom'); el.value = '${z}'; el.dispatchEvent(new Event('input')) })()`)
    await waitFor(win, `document.querySelector('#original canvas') && document.querySelector('#original canvas').width === ${(PAGE_WIDTH * z) | 0}`, `render at ${z}x`)
    const status = await win.webContents.executeJavaScript(`document.querySelector('#status').textContent`)
    check(`zoom ${z}x re-renders cleanly`, !/^Error:/.test(status), status)
  }

  // Apply an edit through the real dialog, then zoom: the modified pane re-renders
  // from its own buffer, which used to be detached the same way.
  await waitFor(win, `document.querySelector('#original .text-hit')`, 'clickable text layer')
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const span = document.querySelector('#original .text-hit')
    if (!span) return 'no .text-hit spans'
    span.click()
    document.querySelector('#replacement').value = 'Hello There'
    document.querySelector('#editDialog').close('ok')
    return 'clicked: ' + span.textContent
  })()`)
  check('clicked a rendered text line', clicked.startsWith('clicked:'), clicked)
  await waitFor(win, `/^(Applied|Edit refused)/.test(document.querySelector('#status').textContent)`, 'edit result')
  const editStatus = await win.webContents.executeJavaScript(`document.querySelector('#status').textContent`)
  check('edit applied', /^Applied/.test(editStatus), editStatus)

  await win.webContents.executeJavaScript(`(() => { const el = document.querySelector('#zoom'); el.value = '1.8'; el.dispatchEvent(new Event('input')) })()`)
  await waitFor(win, `document.querySelector('#modified canvas') && document.querySelector('#modified canvas').width === ${(PAGE_WIDTH * 1.8) | 0}`, 'modified render at 1.8x')
  const afterZoom = await win.webContents.executeJavaScript(`document.querySelector('#status').textContent`)
  check('zoom after an edit re-renders both panes cleanly', !/^Error:/.test(afterZoom), afterZoom)

  // Both panes now hold the same page, so scrolling either must move the other.
  const scrollSync = await win.webContents.executeJavaScript(`(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const a = document.querySelector('#original'), b = document.querySelector('#modified')
    const out = { rangeY: a.scrollHeight - a.clientHeight, rangeY2: b.scrollHeight - b.clientHeight, rangeX: a.scrollWidth - a.clientWidth }
    a.scrollTop = 200
    a.scrollLeft = 40
    await frame()
    out.afterScrollLeftPane = { a: a.scrollTop, b: b.scrollTop, ax: a.scrollLeft, bx: b.scrollLeft }
    b.scrollTop = 500
    b.scrollLeft = 90
    await frame()
    out.afterScrollRightPane = { a: a.scrollTop, b: b.scrollTop, ax: a.scrollLeft, bx: b.scrollLeft }
    return out
  })()`)
  check('panes are scrollable at 1.8x', scrollSync.rangeY > 0 && scrollSync.rangeX > 0, JSON.stringify(scrollSync))
  check('scrolling the left pane scrolls the right pane', scrollSync.afterScrollLeftPane.b === scrollSync.afterScrollLeftPane.a && scrollSync.afterScrollLeftPane.bx === scrollSync.afterScrollLeftPane.ax, JSON.stringify(scrollSync.afterScrollLeftPane))
  check('scrolling the right pane scrolls the left pane', scrollSync.afterScrollRightPane.a === scrollSync.afterScrollRightPane.b && scrollSync.afterScrollRightPane.ax === scrollSync.afterScrollRightPane.bx, JSON.stringify(scrollSync.afterScrollRightPane))

  win.destroy()
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (err) {
    failures.push(err.message)
    console.log(`FAIL ${err.message}`)
  }
  console.log(failures.length ? `\n${failures.length} failing` : '\nall passing')
  app.exit(failures.length ? 1 : 0)
})
