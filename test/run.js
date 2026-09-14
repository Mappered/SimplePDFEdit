// Entry point for the Electron test app:  runtime\electron.exe test [--web]
// Without arguments it runs the desktop renderer test, --web runs the web build test.
require(process.argv.includes('--web') ? './web-app.test.js' : './zoom-render.test.js')
