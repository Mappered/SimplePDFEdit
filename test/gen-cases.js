// Writes the stream-replace case PDFs into the test folder.
//   node test/gen-cases.js
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const latin1 = s => Buffer.from(s, 'latin1')

// Minimal PDF with one content stream per page. `lengthMode` 'indirect' mimics
// what qpdf --qdf emits: /Length 12 0 R pointing at a separate integer object.
function buildPdf(pageContents, { filter = null, lengthMode = 'direct' } = {}) {
  const objs = {}
  let next = 0
  const alloc = () => ++next
  const catalog = alloc()
  const pages = alloc()
  const font = alloc()
  const pageIds = pageContents.map(() => alloc())
  const contentIds = pageContents.map(() => alloc())

  objs[catalog] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objs[pages] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  objs[font] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  const lengthObjs = []
  pageContents.forEach((content, i) => {
    let lengthRef = String(content.length)
    if (lengthMode === 'indirect') {
      const id = alloc()
      lengthObjs.push([id, content.length])
      lengthRef = `${id} 0 R`
    }
    objs[pageIds[i]] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`
    objs[contentIds[i]] = `<< /Length ${lengthRef}${filter ? ` /Filter /${filter}` : ''} >>\nstream\n${content.toString('latin1')}\nendstream`
  })
  for (const [id, len] of lengthObjs) objs[id] = String(len)

  let out = '%PDF-1.4\n'
  const offs = []
  for (let i = 1; i <= next; i++) {
    offs[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${next + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= next; i++) out += `${String(offs[i]).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${next + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return latin1(out)
}

const PLAIN = 'BT /F1 12 Tf 72 720 Td (Hello World) Tj ET'

const CASES = [
  { file: 'case-indirect-length.pdf', bytes: () => buildPdf([latin1(PLAIN)], { lengthMode: 'indirect' }) },
  { file: 'case-flate-indirect.pdf', bytes: () => buildPdf([zlib.deflateSync(latin1(PLAIN))], { lengthMode: 'indirect', filter: 'FlateDecode' }) },
  { file: 'case-split-text.pdf', bytes: () => buildPdf([latin1('BT /F1 12 Tf 72 720 Td [(Hel) -20 (lo Wor) 10 (ld)] TJ ET')]) },
  { file: 'case-stray-delimiters.pdf', bytes: () => buildPdf([latin1('BT (Visible) Tj ET ) > << >> \x00\xff')]) },
  { file: 'case-image-stream.pdf', bytes: () => buildPdf([Buffer.concat([latin1('\xff\xd8\x29\x3e\x00'), Buffer.alloc(300, 0x29)])], { filter: 'DCTDecode', lengthMode: 'indirect' }) },
  { file: 'case-broken-flate.pdf', bytes: () => buildPdf([latin1('Hello World )))')], { filter: 'FlateDecode', lengthMode: 'indirect' }) },
  { file: 'case-ambiguous.pdf', bytes: () => buildPdf([latin1('BT (Hello World) Tj ET\nBT (Hello World) Tj ET')]) },
  { file: 'case-multi-page.pdf', bytes: () => buildPdf([latin1('BT (Page one text) Tj ET'), latin1('BT (Page two text) Tj ET')], { lengthMode: 'indirect' }) }
]

function writeCases(dir = __dirname) {
  for (const c of CASES) fs.writeFileSync(path.join(dir, c.file), c.bytes())
}

if (require.main === module) {
  writeCases()
  console.log(`wrote ${CASES.length} case PDFs to ${__dirname}`)
}

module.exports = { buildPdf, CASES, writeCases }
