const fs = require('fs')
const objs = []
objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>'
objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
// Two columns, items emitted in interleaved content order (left1, right1, left2, right2),
// plus a tight-leading pair of 20pt lines 8 units apart.
const stream =
  'BT /F1 12 Tf 72 720 Td (Left column first line) Tj ET\n' +
  'BT /F2 20 Tf 320 720 Td (RIGHT BIG HEADING) Tj ET\n' +
  'BT /F1 12 Tf 72 690 Td (Left column second line) Tj ET\n' +
  'BT /F2 20 Tf 320 650 Td (Right big second line) Tj ET\n' +
  'BT /F2 20 Tf 72 560 Td (Tight one) Tj ET\n' +
  'BT /F2 20 Tf 72 552 Td (Tight two) Tj ET'
objs[6] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
let out = '%PDF-1.4\n', offs = [0]
for (let i = 1; i <= 6; i++) { offs[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n` }
const xref = out.length
out += `xref\n0 7\n0000000000 65535 f \n`
for (let i = 1; i <= 6; i++) out += `${String(offs[i]).padStart(10, '0')} 00000 n \n`
out += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync('test/lines.pdf', out)
console.log('wrote test/lines.pdf', out.length, 'bytes')
