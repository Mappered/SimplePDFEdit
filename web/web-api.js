// Browser stand-in for the Electron preload bridge: app.js talks to window.api and
// never knows whether it runs in the desktop app or in a browser tab.
import { replaceTextInPdfBuffer } from './engine.js'

const bytesToBase64 = bytes => {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  return btoa(out)
}
const base64ToBytes = text => {
  const raw = atob(text), out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
const setStatus = message => {
  const el = document.querySelector('#status')
  if (el) el.textContent = message
}

const session = { name: 'document.pdf', original: null, originalBase64: null, current: null, count: 0 }
let openedHandler = null

function openFile(file) {
  return file.arrayBuffer().then(buffer => {
    session.name = file.name || 'document.pdf'
    session.original = new Uint8Array(buffer)
    session.originalBase64 = bytesToBase64(session.original)
    session.current = session.original
    session.count = 0
  })
}

function payload() {
  return { canceled: false, path: session.name, name: session.name, dataBase64: session.originalBase64 }
}

window.api = {
  openPdf() {
    return new Promise(resolve => {
      const input = document.querySelector('#fileInput')
      input.value = ''
      const done = () => { input.removeEventListener('change', done); input.removeEventListener('cancel', onCancel) }
      const onCancel = () => { done(); resolve({ canceled: true }) }
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0]
        done()
        if (!file) { resolve({ canceled: true }); return }
        setStatus('Reading ' + file.name + '...')
        await openFile(file)
        resolve(payload())
      }, { once: true })
      input.addEventListener('cancel', onCancel, { once: true })
      input.click()
    })
  },

  onOpened(callback) { openedHandler = callback },

  async applyTextEdit(edit) {
    if (!session.current) return { ok: false, warnings: ['Open a PDF first.'], editCount: 0 }
    try {
      const r = await replaceTextInPdfBuffer(session.current, edit)
      if (r.replacements !== 1) return { ok: false, warnings: r.warnings, editCount: session.count }
      session.count += 1
      session.current = r.data
      return { ok: true, dataBase64: bytesToBase64(r.data), warnings: r.warnings, editCount: session.count, currentPath: session.name }
    } catch (err) {
      return { ok: false, warnings: ['Edit failed: ' + ((err && err.message) || err)], editCount: session.count }
    }
  },

  async reset() {
    if (!session.original) return { canceled: true }
    session.current = session.original
    session.count = 0
    return payload()
  },

  async saveAs() {
    if (!session.current) return { canceled: true }
    const name = session.name.replace(/\.pdf$/i, '') + (session.count ? ' (edited)' : '') + '.pdf'
    const url = URL.createObjectURL(new Blob([session.current], { type: 'application/pdf' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    return { canceled: false, path: name }
  }
}

// Dropping a PDF anywhere on the page opens it, like passing a file to the desktop exe.
document.addEventListener('dragover', e => { e.preventDefault() })
document.addEventListener('drop', async e => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
  if (!file) return
  e.preventDefault()
  setStatus('Reading ' + file.name + '...')
  await openFile(file)
  if (openedHandler) openedHandler(payload())
})

export { base64ToBytes }
