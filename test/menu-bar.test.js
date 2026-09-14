// Boots the real app main process and checks the window chrome.
//   runtime\electron.exe test --menu
const { app, BrowserWindow } = require('electron')

// The app registers its own whenReady handler; ours runs after it and inspects the
// window it created. The window is hidden as soon as we can to keep the run quiet.
require('../app/main.js')

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  const deadline = Date.now() + 30000
  let win = null
  while (!win && Date.now() < deadline) {
    win = BrowserWindow.getAllWindows()[0] || null
    if (!win) await sleep(50)
  }
  if (!win) {
    console.log('FAIL the app did not create a window')
    app.exit(1)
    return
  }
  win.hide()
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r))

  check('app window opens', true, `${win.getSize().join('x')}`)
  check('menu bar is hidden', win.isMenuBarVisible() === false, `isMenuBarVisible=${win.isMenuBarVisible()}`)
  check('menu bar can still be revealed with Alt', win.isMenuBarAutoHide() === true, `isMenuBarAutoHide=${win.isMenuBarAutoHide()}`)

  const title = await win.webContents.executeJavaScript(`document.title`)
  check('renderer loaded', /PDF/.test(title), title)

  win.destroy()
  console.log(failures.length ? `\n${failures.length} failing` : '\nall passing')
  app.exit(failures.length ? 1 : 0)
})
