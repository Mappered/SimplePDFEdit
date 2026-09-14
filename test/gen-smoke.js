const fs = require('fs')
const objs = []
objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
const stream = 'BT /F1 24 Tf 72 720 Td (Hello World) Tj ET\nBT /F1 12 Tf 0 -40 Td (Second line of text) Tj ET'
objs[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
let out = '%PDF-1.4\n', offs = [0]
for (let i = 1; i <= 5; i++) { offs[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n` }
const xref = out.length
out += `xref\n0 6\n0000000000 65535 f \n`
for (let i = 1; i <= 5; i++) out += `${String(offs[i]).padStart(10, '0')} 00000 n \n`
out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
fs.writeFileSync('test/smoke.pdf', out)
console.log('wrote test/smoke.pdf', out.length, 'bytes')
