// Runs the web build the way GitHub Pages would: over HTTP, in a browser tab.
//   runtime\electron.exe test
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const WEB_DIR = path.join(__dirname, '..', 'web')
const PDF = fs.readFileSync(path.join(__dirname, 'smoke.pdf'))
const PAGE_WIDTH = 612
const DOWNLOAD = path.join(process.env.TEMP || __dirname, 'web-build-output.pdf')
const TIMEOUT_MS = 60000

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json'
}

app.disableHardwareAcceleration()

const sleep = ms => new Promise(r => setTimeout(r, ms))
const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function serve(dir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html'
    const file = path.join(dir, rel)
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function waitFor(win, expr, label) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`(() => { try { return !!(${expr}) } catch { return false } })()`)) return
    await sleep(100)
  }
  throw new Error('timed out waiting for ' + label)
}

async function main() {
  const server = await serve(WEB_DIR)
  const url = `http://127.0.0.1:${server.address().port}/index.html`

  const downloads = []
  session.defaultSession.on('will-download', (_e, item) => {
    const target = DOWNLOAD
    item.setSavePath(target)
    item.once('done', () => downloads.push(target))
  })

  const win = new BrowserWindow({ show: false, width: 1200, height: 900 })
  const pageErrors = []
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) pageErrors.push(message) })
  await win.loadURL(url)
  await waitFor(win, `document.querySelector('#openBtn')`, 'page load')
  check('page loads over plain http', true, url)

  const bootstrap = await win.webContents.executeJavaScript(`(() => ({
    api: typeof window.api,
    engine: typeof window.api === 'object' && 'applyTextEdit' in window.api,
    mjs: performance.getEntriesByType('resource').filter(r => r.name.includes('/vendor/')).map(r => r.name.split('/').pop())
  }))()`)
  check('browser api bridge is installed', bootstrap.api === 'object' && bootstrap.engine, JSON.stringify(bootstrap))

  // Drop a file on the page, exactly like dragging a PDF onto the window.
  await win.webContents.executeJavaScript(`(() => {
    const bytes = Uint8Array.from(atob('${PDF.toString('base64')}'), c => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'smoke.pdf', { type: 'application/pdf' }))
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dt })
    document.dispatchEvent(event)
  })()`)
  await waitFor(win, `document.querySelector('#original canvas') && document.querySelector('#modified canvas')`, 'render of both panes')
  const opened = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('#original')
    const cs = getComputedStyle(pane)
    const c = pane.querySelector('canvas')
    return {
      status: document.querySelector('#status').textContent,
      zoom: Number(document.querySelector('#zoom').value),
      fits: c.width <= pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 1
         && c.height <= pane.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) + 1
    }
  })()`)
  check('dropped document opens', /^Opened smoke\.pdf/.test(opened.status), opened.status)
  check('page fits the pane like the desktop build', opened.fits, JSON.stringify(opened))

  // Apply an edit that makes the stream longer, so the cross-reference repair is exercised.
  await waitFor(win, `document.querySelector('#original .text-hit')`, 'clickable text layer')
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const span = document.querySelector('#original .text-hit')
    if (!span) return 'no text layer'
    span.click()
    document.querySelector('#replacement').value = 'Hello Web World'
    document.querySelector('#editDialog').close('ok')
    return 'clicked: ' + span.textContent
  })()`)
  check('clicked a rendered text line', clicked.startsWith('clicked:'), clicked)
  await waitFor(win, `/^(Applied|Edit refused)/.test(document.querySelector('#status').textContent)`, 'edit result')
  const editStatus = await win.webContents.executeJavaScript(`document.querySelector('#status').textContent`)
  check('edit applied in the browser', /^Applied/.test(editStatus), editStatus)

  await waitFor(win, `!document.querySelector('#saveBtn').disabled`, 'save enabled')
  await win.webContents.executeJavaScript(`document.querySelector('#saveBtn').click()`)
  const deadline = Date.now() + TIMEOUT_MS
  while (!downloads.length && Date.now() < deadline) await sleep(100)
  check('modified pdf downloads', downloads.length > 0 && fs.existsSync(DOWNLOAD), DOWNLOAD)
  if (fs.existsSync(DOWNLOAD)) {
    const out = fs.readFileSync(DOWNLOAD)
    check('downloaded file contains the replacement', out.toString('latin1').includes('Hello Web World'), `${out.length} bytes`)
  }
  if (pageErrors.length) console.log('     page console errors: ' + pageErrors.join(' | '))

  win.destroy()
  server.close()
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (err) {
    failures.push(err.message)
    console.log('FAIL ' + err.message)
  }
  console.log(failures.length ? `\n${failures.length} failing` : '\nall passing')
  app.exit(failures.length ? 1 : 0)
})
