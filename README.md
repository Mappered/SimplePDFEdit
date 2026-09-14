# SimplePDFEdit

A small Windows PDF text editor that edits the text *inside* a PDF's content stream
instead of re-drawing the page. Click a line on the left, type a replacement, and the
right pane previews the result before you save it.

The desktop app is called **PDF Stream Editor**; it ships as a single
`PDFStreamEditor.exe` and also runs in a browser (see [Web version](#web-version)).

## Features

- Two panes side by side: the original and the modified document, with synced scrolling
- Zoom that fits a whole page (A4 or whatever the document uses) as soon as you open it
- Click any rendered text line to replace that text in the PDF stream
- Edits are applied through `qpdf`: normalize → patch the stream → rewrite the file,
  so the output is a properly structured PDF
- Save As, Reset, and a live edit counter
- Runs as one self-contained exe: no installer, no Node, no runtime to install
- Optional command line file argument, and you can drop a PDF onto the exe

## Download

Builds are produced by GitHub Actions:

- **Releases**: push a `v*` tag and the exe is attached to the release.
- **Any other build**: open the latest *Build Windows exe* run under
  [Actions](https://github.com/Mappered/SimplePDFEdit/actions) and download the
  `PDFStreamEditor-exe` artifact.

The first launch unpacks the app to `%LOCALAPPDATA%\PDFStreamEditor` (about a second)
and starts it from there; later launches reuse that folder. To uninstall, delete it.
If something goes wrong on launch, the log is at
`%TEMP%\pdfstream-editor-launch.log`.

## Usage

```
PDFStreamEditor.exe                        start with an empty window
PDFStreamEditor.exe "C:\Docs\Report.pdf"   open that file straight away
```

1. Open a PDF (button, command line, or drag and drop).
2. Click the line you want to change in the **Original** pane.
3. Type the replacement and press *Apply stream edit*.
4. Check the **Modified** pane, then *Save modified as…*.

## Web version

The same viewer and editor also runs as a static site (no install, works on any
platform):

**https://mappered.github.io/SimplePDFEdit/**

Open or drop a PDF, edit exactly like the desktop app, and the result downloads as
`name (edited).pdf`. The browser build has no `qpdf`, so it edits the file directly and
repairs a classic cross-reference table in place after the change. It is therefore a
bit more limited than the desktop build (see below).

## Limitations

This is a byte-level stream editor, not a layout engine, and it is honest about it:

- Text is replaced where it sits in the content stream, so the surrounding layout and
  fonts are untouched. Replacements longer than the original text can overlap
  neighbouring content.
- Only text stored as a literal string (`(...) Tj`, `[...] TJ`) in an uncompressed or
  Flate-compressed content stream can be edited. PDFs that use embedded subset fonts
  with glyph ids (the text in the stream is not readable text), object streams, or
  image-only pages are refused rather than guessed at.
- A match must be unique in the document; ambiguous matches are refused so the wrong
  occurrence is never changed silently.
- The desktop build writes byte-perfect output via `qpdf`. The web build repairs classic
  xref tables itself and warns when a file uses an xref stream.

## Building from source

Requirements: Windows, PowerShell 5.1+, and a C# compiler — the .NET Framework one
(`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) or Visual Studio's Roslyn.

The Electron runtime and qpdf are **not** in this repository (Electron's `electron.exe`
alone is 235 MB, over GitHub's file limit), so fetch them once:

```powershell
# Electron runtime (version pinned by .github/workflows/build-exe.yml)
Invoke-WebRequest https://github.com/electron/electron/releases/download/v44.3.0/electron-v44.3.0-win32-x64.zip -OutFile electron.zip
Expand-Archive electron.zip -DestinationPath runtime -Force
Remove-Item electron.zip

# qpdf
Invoke-WebRequest https://github.com/qpdf/qpdf/releases/download/v12.4.1/qpdf-12.4.1-msvc64.zip -OutFile qpdf.zip
Expand-Archive qpdf.zip -DestinationPath qpdf-tmp -Force
New-Item -ItemType Directory -Force tools\qpdf | Out-Null
Copy-Item (Get-ChildItem qpdf-tmp -Recurse -Filter qpdf.exe | Select-Object -First 1).Directory.FullName\* tools\qpdf -Recurse -Force
Remove-Item qpdf-tmp -Recurse -Force
```

Then build:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1        # -> dist\PDFStreamEditor.exe
powershell -ExecutionPolicy Bypass -File make-web.ps1     # -> web\ (static site)
powershell -ExecutionPolicy Bypass -File make-icon.ps1    # -> app\icon.ico + icon.png
```

In VS Code, `Ctrl+Shift+B` runs the build task. `build.ps1 -KeepStage` keeps the
intermediate staging folder, and `-Compression Fastest` trades size for build time.

## Tests

```powershell
tools\node\node.exe test\stream-replace.test.js     # editor engine, 12 cases
runtime\electron.exe test                           # desktop renderer (zoom, scroll, edits)
runtime\electron.exe test --web                     # the web build over local HTTP
```

The Electron tests drive the real UI in a hidden window: they open a PDF, zoom, apply
an edit, and check the result — the web test also captures the downloaded file. If your
shell has `ELECTRON_RUN_AS_NODE=1` set, clear it first, otherwise `electron.exe` behaves
like plain Node.

## Project layout

| Path | What it is |
| --- | --- |
| `app/` | Electron app: `main.js` (windows, dialogs, files), `preload.js` (bridge), `renderer/` (UI, pdf.js), `streamReplace.js` (the edit engine) |
| `tools/launcher/Launcher.cs` | the C# starter that is compiled into the single-file exe (unpacks the payload, starts the app, forwards arguments) |
| `build.ps1` | stages the app + runtime + qpdf, compresses them, and compiles `dist\PDFStreamEditor.exe` with the icon attached |
| `make-web.ps1` | assembles `web/` from `app/renderer` for GitHub Pages |
| `make-icon.ps1` | draws `app/icon.ico` (PDF page + pencil) |
| `web/` | browser build: `web-api.js` (browser stand-in for the preload bridge), `engine.js` (browser port of the edit engine) |
| `test/` | engine regression suite and the Electron UI tests |
| `.github/workflows/` | `pages.yml` (deploy `web/`) and `build-exe.yml` (build the exe, release on tags) |

## How it works

1. The PDF is parsed just enough to find every stream (`spans()`), and each stream's
   dictionary tells whether it is text or an image and how it is compressed.
2. Content streams are tokenized and text-showing groups (`Tj` / `TJ`) are reassembled,
   so a match can span several strings and hex strings are handled too.
3. Exactly one match must be found. The replacement is written back into the stream,
   `/Length` is corrected, and the file is rebuilt.
4. Desktop: `qpdf --qdf` normalizes the file first and `qpdf` finalizes the result, so
   the cross-reference data is always correct. Web: the same engine runs in the browser
   with `CompressionStream`/`DecompressionStream` and repairs the xref table itself.

The exe packs `app/`, the Electron runtime and qpdf into one file as
`payload.zip`; its launcher unpacks that payload next to your user profile, starts the
app, and exits, so nothing stays resident but the app itself.
