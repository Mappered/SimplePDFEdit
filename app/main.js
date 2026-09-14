const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { replaceTextInPdfBuffer } = require('./streamReplace')

const session = { original: null, current: null, dir: '', count: 0 }
const b64 = b => b.toString('base64')

function openSession(filePath) {
  session.original = session.current = filePath
  session.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-stream-editor-'))
  session.count = 0
  return { canceled: false, path: session.original, name: path.basename(session.original), dataBase64: b64(fs.readFileSync(session.original)) }
}

function cliPdfArg() {
  const args = process.defaultApp ? process.argv.slice(2) : process.argv.slice(1)
  const a = args.find(a => !a.startsWith('--') && a.toLowerCase().endsWith('.pdf'))
  if (!a) return null
  const abs = path.resolve(a)
  return fs.existsSync(abs) ? abs : null
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 700,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  const cli = cliPdfArg()
  if (cli) win.webContents.once('did-finish-load', () => {
    try { win.webContents.send('pdf:opened', openSession(cli)) }
    catch (err) { console.error('Failed to open CLI pdf:', err) }
  })
}

ipcMain.handle('pdf:open', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PDF files', extensions: ['pdf'] }] })
  if (r.canceled || !r.filePaths[0]) return { canceled: true }
  return openSession(r.filePaths[0])
})

ipcMain.handle('pdf:apply-text-edit', async (_e, edit) => {
  if (!session.current) return { ok: false, warnings: ['Open a PDF first.'], editCount: 0 }
  let result
  try {
    result = replaceTextInPdfBuffer(fs.readFileSync(session.current), edit)
  } catch (err) {
    // Never let an internal failure surface as an opaque "Error invoking remote method".
    const detail = (err && err.stack) || String(err)
    console.error('apply-text-edit failed:', detail)
    try { fs.writeFileSync(path.join(session.dir, 'last-edit-error.log'), detail) } catch {}
    return { ok: false, warnings: [`Edit failed: ${(err && err.message) || err}`], editCount: session.count }
  }
  if (result.replacements !== 1) return { ok: false, warnings: result.warnings, editCount: session.count }
  session.count += 1
  const next = path.join(session.dir, `edit-${String(session.count).padStart(3, '0')}.pdf`)
  fs.writeFileSync(next, result.data)
  session.current = next
  return { ok: true, dataBase64: b64(result.data), warnings: result.warnings, editCount: session.count, currentPath: next }
})

ipcMain.handle('pdf:reset', async () => {
  if (!session.original) return { canceled: true }
  session.current = session.original; session.count = 0
  return { canceled: false, path: session.original, name: path.basename(session.original), dataBase64: b64(fs.readFileSync(session.original)) }
})

ipcMain.handle('pdf:save-as', async () => {
  if (!session.current) return { canceled: true }
  const r = await dialog.showSaveDialog({ defaultPath: session.original || 'modified.pdf', filters: [{ name: 'PDF files', extensions: ['pdf'] }] })
  if (r.canceled || !r.filePath) return { canceled: true }
  fs.copyFileSync(session.current, r.filePath)
  return { canceled: false, path: r.filePath }
})

app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
