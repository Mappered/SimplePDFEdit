// Entry point for the Electron test app:  runtime\electron.exe test [--web|--menu]
//   (no flag)  desktop renderer test (zoom, scroll, edits)
//   --web      the web build, served over local HTTP
//   --menu     the real app main process: window chrome checks
const suite = process.argv.includes('--web') ? './web-app.test.js'
  : process.argv.includes('--menu') ? './menu-bar.test.js'
    : './zoom-render.test.js'
require(suite)
