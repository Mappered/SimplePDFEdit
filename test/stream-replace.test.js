// Regression tests for app/streamReplace.js.
// Every case runs against a PDF file in this folder (see gen-cases.js).
//   node test/stream-replace.test.js
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { replaceTextInPdfBuffer } = require('../app/streamReplace')
const { CASES, writeCases } = require('./gen-cases')

const TEST_DIR = __dirname
const STALL_LIMIT_MS = 5000

writeCases(TEST_DIR)

const pdfPath = file => path.join(TEST_DIR, file)
const read = file => fs.readFileSync(pdfPath(file))

function apply(file, text, replacement) {
  const input = read(file)
  const t0 = Date.now()
  const r = replaceTextInPdfBuffer(input, { pageIndex: 0, text, replacement })
  return { ...r, input, ms: Date.now() - t0, output: r.data.toString('latin1') }
}

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}\n     ${err.message}`)
  }
}

// --- the PDFs already in this folder -------------------------------------

check('smoke.pdf: literal edit', () => {
  const r = apply('smoke.pdf', 'Hello World', 'Hello There')
  assert.strictEqual(r.replacements, 1, r.warnings.join(' '))
  assert.ok(r.output.includes('(Hello There) Tj'))
  assert.ok(!r.output.includes('(Hello World) Tj'))
})

check('smoke-valid.pdf: literal edit', () => {
  const r = apply('smoke-valid.pdf', 'Hello World', 'Hello PDF')
  assert.strictEqual(r.replacements, 1, r.warnings.join(' '))
  assert.ok(r.output.includes('(Hello PDF) Tj'))
})

check('lines.pdf: literal edit of a later line', () => {
  const r = apply('lines.pdf', 'Tight one', 'Tight 1')
  assert.strictEqual(r.replacements, 1, r.warnings.join(' '))
  assert.ok(r.output.includes('(Tight 1) Tj'))
  assert.ok(r.output.includes('(Tight two) Tj'), 'untouched line must survive')
})

// --- generated case PDFs --------------------------------------------------

check('case-indirect-length.pdf: qpdf-style /Length N 0 R', () => {
  const r = apply('case-indirect-length.pdf', 'Hello World', 'Hello There')
  assert.strictEqual(r.replacements, 1, r.warnings.join(' '))
  assert.ok(r.output.includes('(Hello There) Tj'))
  assert.ok(!/\d+ 0 R\s*>>\s*\nstream/.test(r.output), 'stale indirect length reference')
  const m = /\/Length (\d+)/.exec(r.output)
  assert.ok(m && Number(m[1]) > 10, `rewritten /Length should be a byte count, got ${m && m[1]}`)
})

check('case-flate-indirect.pdf: compressed stream stays compressed', () => {
  const r = apply('case-flate-indirect.pdf', 'Hello World', 'Goodbye')
  assert.strictEqual(r.replacements, 1, r.warnings.join(' '))
  assert.ok(!r.output.includes('(Goodbye)'), 'replacement must be written through the filter')
})

check('case-split-text.pdf: text split across strings in one TJ array', () => {
  const r = apply('case-split-text.pdf', 'Hello World', 'Hi')
  assert.strictEqual(r.replacements, 1, r.warnings.join(' '))
  assert.ok(r.output.includes('(Hi)'))
  assert.ok(!r.output.includes('lo Wor'), 'covered split text left behind')
})

check('case-stray-delimiters.pdf: stray ) and lone > do not stall', () => {
  const r = apply('case-stray-delimiters.pdf', 'Visible', 'Shown')
  assert.strictEqual(r.replacements, 1, r.warnings.join(' '))
  assert.ok(r.ms < STALL_LIMIT_MS, `took ${r.ms}ms`)
})

check('case-image-stream.pdf: image streams are skipped untouched', () => {
  const r = apply('case-image-stream.pdf', 'Hello World', 'Hello There')
  assert.strictEqual(r.replacements, 0)
  assert.ok(r.data.equals(r.input), 'file must be returned untouched')
})

check('case-broken-flate.pdf: undecodable stream is skipped, not matched', () => {
  const r = apply('case-broken-flate.pdf', 'Hello World', 'x')
  assert.strictEqual(r.replacements, 0)
  assert.ok(r.warnings.some(w => /could not be decoded/.test(w)), r.warnings.join(' '))
})

check('case-ambiguous.pdf: ambiguous text is refused', () => {
  const r = apply('case-ambiguous.pdf', 'Hello World', 'Hello There')
  assert.strictEqual(r.replacements, 0)
  assert.ok(r.warnings.some(w => /Refusing ambiguous/.test(w)), r.warnings.join(' '))
})

check('case-multi-page.pdf: only the page holding the text changes', () => {
  const r = apply('case-multi-page.pdf', 'Page two text', 'Page TWO text')
  assert.strictEqual(r.replacements, 1, r.warnings.join(' '))
  assert.ok(r.output.includes('(Page TWO text) Tj'))
  assert.ok(r.output.includes('(Page one text) Tj'), 'other page must survive')
})

// --- folder-wide safety net ----------------------------------------------

check('every PDF in the test folder completes an edit pass', () => {
  const files = fs.readdirSync(TEST_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).sort()
  assert.ok(files.length >= 3 + CASES.length, `expected the fixtures to be present, found ${files.length}`)
  for (const file of files) {
    const r = apply(file, 'zzz-not-present-in-any-fixture', 'x')
    assert.strictEqual(r.replacements, 0, `${file} unexpectedly matched`)
    assert.ok(r.ms < STALL_LIMIT_MS, `${file} took ${r.ms}ms`)
  }
  console.log(`     (${files.length} files: ${files.join(', ')})`)
})

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exitCode = failures ? 1 : 0
