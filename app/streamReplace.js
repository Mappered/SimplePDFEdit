const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

function qpdfCmd() {
  const local = path.join(__dirname, '..', 'tools', 'qpdf', 'qpdf.exe')
  if (fs.existsSync(local)) return local
  const env = process.env.QPDF_PATH
  if (env) return env
  const probe = spawnSync('qpdf.exe', ['--version'], { encoding: 'utf8' })
  return (!probe.error && probe.status === 0) ? 'qpdf.exe' : null
}

function runQpdf(args) {
  const cmd = qpdfCmd()
  if (!cmd) return { ok: false, stderr: 'qpdf.exe not found' }
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) return { ok: false, stdout: r.stdout, stderr: r.error.message }
  // qpdf exits 3 when the operation completed but warnings were issued.
  return { ok: r.status === 0 || r.status === 3, stdout: r.stdout, stderr: r.stderr }
}

// `/Length` may be an indirect reference (`/Length 12 0 R`), which is exactly what
// qpdf --qdf emits. Resolve it against the length object further down the file.
function indirectLength(s, num, gen) {
  const m = new RegExp('(?:^|[\\r\\n])' + num + '\\s+' + gen + '\\s+obj\\b').exec(s)
  if (!m) return null
  const body = s.slice(m.index + m[0].length, m.index + m[0].length + 128)
  const im = /^\s*(\d+)\s*endobj/.exec(body)
  return im ? Number(im[1]) : null
}

function declaredLength(dictText, s) {
  const m = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dictText)
  if (!m) return null
  if (m[2] !== undefined) return indirectLength(s, Number(m[1]), Number(m[2]))
  return Number(m[1])
}

// Filters we cannot decode, or that hold image data rather than text.
const OPAQUE_FILTERS = ['/DCTDecode', '/JPXDecode', '/CCITTFaxDecode', '/JBIG2Decode', '/LZWDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/RunLengthDecode', '/Crypt']

function isOpaqueStream(dictText) {
  if (/\/Subtype\s*\/Image\b/.test(dictText)) return true
  return OPAQUE_FILTERS.some(f => dictText.includes(f))
}

function spans(buf) {
  const s = buf.toString('latin1')
  const re = /(^|\n)(\d+)\s+(\d+)\s+obj\b/g
  const out = []
  let m
  while ((m = re.exec(s))) {
    const start = m.index + (m[1] ? 1 : 0)
    const endObj = s.indexOf('endobj', re.lastIndex)
    if (endObj < 0) continue
    const end = endObj + 6
    const sk = s.indexOf('stream', re.lastIndex)
    if (sk < 0 || sk > end) continue
    let bs = sk + 6
    if (s[bs] === '\r') bs++
    if (s[bs] === '\n') bs++
    const es = s.indexOf('endstream', bs)
    if (es < 0 || es > end) continue
    const dict = buf.subarray(start, sk)
    const len = declaredLength(dict.toString('latin1'), s)
    let be = es
    if (len !== null && len >= 0 && bs + len <= es) be = bs + len
    else while (be > bs && (s[be - 1] === '\n' || s[be - 1] === '\r')) be--
    out.push({ start, end, dict, raw: buf.subarray(bs, be) })
  }
  return out
}

function decode(dict, raw) {
  if (dict.includes('/FlateDecode')) { try { return zlib.inflateSync(raw) } catch { return null } }
  return raw
}
function encode(dict, data) { return dict.includes('/FlateDecode') ? zlib.deflateSync(data) : data }
function replaceLength(dict, len) {
  const t = dict.toString('latin1')
  return Buffer.from(/\/Length\s+\d+/.test(t) ? t.replace(/\/Length\s+\d+(?:\s+\d+\s+R)?/, `/Length ${len}`) : t.replace(/<<\s*/, `<< /Length ${len} `), 'latin1')
}

const DELIMS = ' \t\r\n\f()<>[]{}/%'
function isDelim(c) { return DELIMS.includes(c) }
// Safety valve: pathological input must not turn into an unbounded token list.
const MAX_TOKENS = 5e6

// Tokenize a decoded content stream; literal/hex strings carry decoded content (latin1).
function tokenize(data) {
  const s = data.toString('latin1')
  const n = s.length
  const toks = []
  let i = 0
  while (i < n) {
    if (toks.length > MAX_TOKENS) return null
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f') { i++; continue }
    if (c === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue }
    if (c === '(') {
      const start = i; i++; let depth = 1, content = '', esc = false
      while (i < n && depth > 0) {
        const d = s[i]
        if (esc) {
          if (d >= '0' && d <= '7') {
            let oct = d, k = 1
            while (k < 3 && s[i + 1] >= '0' && s[i + 1] <= '7' && s[i + 1] <= '7') { i++; oct += s[i]; k++ }
            content += String.fromCharCode(parseInt(oct, 8) & 0xff)
          } else if (d === 'n') content += '\n'
          else if (d === 'r') content += '\r'
          else if (d === 't') content += '\t'
          else content += d
          esc = false; i++
        } else if (d === '\\') { esc = true; i++ }
        else if (d === '(') { depth++; content += d; i++ }
        else if (d === ')') { depth--; if (depth) content += d; i++ }
        else { content += d; i++ }
      }
      toks.push({ type: 'str', start, end: i, content })
      continue
    }
    if (c === '<') {
      if (s[i + 1] === '<') { toks.push({ type: 'op', val: '<<' }); i += 2; continue }
      const start = i; i++
      let h = ''
      while (i < n && s[i] !== '>') { if (!' \t\r\n\f'.includes(s[i])) h += s[i]; i++ }
      if (s[i] === '>') i++
      if (h.length % 2) h += '0'
      let content = ''
      for (let k = 0; k + 1 < h.length; k += 2) content += String.fromCharCode(parseInt(h.substr(k, 2), 16) & 0xff)
      toks.push({ type: 'hex', start, end: i, content })
      continue
    }
    if (c === '>' && s[i + 1] === '>') { toks.push({ type: 'op', val: '>>' }); i += 2; continue }
    if (c === '[' || c === ']') { toks.push({ type: 'op', val: c }); i++; continue }
    if (c === '/') {
      const start = i; i++
      while (i < n && !isDelim(s[i])) i++
      toks.push({ type: 'name', start, end: i })
      continue
    }
    const start = i
    while (i < n && !isDelim(s[i])) i++
    // A delimiter no branch above recognises (a stray ')' or a lone '>'): consume it,
    // otherwise `i` never advances and this loop runs until the process dies.
    if (i === start) { i++; continue }
    toks.push({ type: 'word', start, end: i })
  }
  return toks
}

// Text-showing groups: strings inside a [...] TJ array, or the string operand of a single Tj.
function textGroups(data) {
  const s = data.toString('latin1')
  const toks = tokenize(data)
  if (!toks) return []
  const groups = []
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.type === 'op' && t.val === '[') {
      const strs = []
      let j = k + 1
      while (j < toks.length && !(toks[j].type === 'op' && toks[j].val === ']')) {
        if (toks[j].type === 'str' || toks[j].type === 'hex') strs.push(toks[j])
        j++
      }
      const op = toks[j + 1]
      if (strs.length && op && op.type === 'word' && s.slice(op.start, op.end) === 'TJ') { groups.push(strs); k = j + 1 }
    } else if (t.type === 'word' && s.slice(t.start, t.end) === 'Tj') {
      for (let j = k - 1; j >= 0; j--) {
        const p = toks[j]
        if (p.type === 'str' || p.type === 'hex') { groups.push([p]); break }
        if (p.type === 'word' || p.type === 'name') break
      }
    }
  }
  return groups.map(strs => {
    let visible = ''
    const map = []
    strs.forEach((st, si) => {
      st.contentStart = visible.length
      for (let ci = 0; ci < st.content.length; ci++) { map[visible.length] = si; visible += st.content[ci] }
    })
    return { strs, visible, map }
  })
}

function encLiteral(content) { return content.replace(/([\\()])/g, '\\$1') }
function encHex(content) {
  let h = ''
  for (let k = 0; k < content.length; k++) h += content.charCodeAt(k).toString(16).padStart(2, '0')
  return h
}

// Rebuild stream bytes with the whole replacement placed at match start (first covering string),
// covered chars removed from subsequent strings, other strings untouched.
function applySplit(data, group, ms, me, repl) {
  const s = data.toString('latin1')
  const { strs, map } = group
  const firstSi = map[ms]
  const pieces = []
  let pos = 0
  for (let si = 0; si < strs.length; si++) {
    const st = strs[si]
    if (st.end < pos) continue
    pieces.push(s.slice(pos, st.start))
    let content = st.content
    const vs = st.contentStart
    const ve = vs + st.content.length
    if (me > vs && ms < ve) {
      let keep = ''
      if (ms > vs) keep += content.slice(0, ms - vs)
      if (si === firstSi) keep += repl
      if (me < ve) keep += content.slice(me - vs)
      content = keep
    }
    pieces.push(st.type === 'hex' ? '<' + encHex(content) + '>' : '(' + encLiteral(content) + ')')
    pos = st.end
  }
  pieces.push(s.slice(pos))
  return Buffer.from(pieces.join(''), 'latin1')
}

function replaceTextInPdfBuffer(input, edit) {
  const warnings = []
  let working = input
  let normalized = null
  let workDir = null
  // The qpdf working files are only needed for the duration of this call.
  const done = result => {
    if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {} workDir = null }
    return result
  }
  const hasQpdf = !!qpdfCmd()
  if (!hasQpdf) warnings.push('qpdf.exe not found; only simple expanded PDFs may work.')
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-stream-edit-'))
    workDir = dir
    const inFile = path.join(dir, 'in.pdf'), qdf = path.join(dir, 'in.qdf')
    fs.writeFileSync(inFile, input)
    const n = runQpdf(['--qdf', '--object-streams=disable', inFile, qdf])
    if (n.ok && fs.existsSync(qdf)) { working = fs.readFileSync(qdf); normalized = qdf } else warnings.push('qpdf normalize failed: ' + (n.stderr || 'unknown'))
  }

  const needle = Buffer.from(edit.text, 'latin1')
  const repl = Buffer.from(edit.replacement, 'latin1')
  const all = []
  let skipped = 0
  for (const sp of spans(working)) {
    if (isOpaqueStream(sp.dict.toString('latin1'))) continue
    const data = decode(sp.dict, sp.raw)
    if (!data) { skipped++; continue }
    all.push({ sp, data })
  }
  if (skipped) warnings.push(`Skipped ${skipped} stream(s) that could not be decoded.`)
  let total = 0, hit = -1, splitHit = null
  all.forEach((x, i) => {
    let from = 0
    while (true) {
      const idx = x.data.indexOf(needle, from)
      if (idx < 0) break
      total++; hit = i; from = idx + Math.max(1, needle.length)
    }
    const groups = textGroups(x.data)
    const sdata = x.data.toString('latin1')
    for (const g of groups) {
      let gi = 0
      while (true) {
        const idx = g.visible.indexOf(needle.toString('latin1'), gi)
        if (idx < 0) break
        gi = idx + Math.max(1, needle.length)
        const si0 = g.map[idx], si1 = g.map[idx + needle.length - 1]
        // The plain literal path already owns matches contiguous in the raw bytes.
        if (si0 === si1 && sdata.includes(needle.toString('latin1'), g.strs[si0].start)) continue
        total++; splitHit = { stream: i, group: g, at: idx }
      }
    }
  })
  if (total !== 1 || (hit < 0 && !splitHit)) {
    warnings.push(`Found ${total} literal/split occurrence(s) for ${JSON.stringify(edit.text)}. Refusing ambiguous/non-literal edit.`)
    return done({ data: input, replacements: 0, warnings })
  }

  let after
  if (hit >= 0) {
    const before = all[hit].data
    const at = before.indexOf(needle)
    after = Buffer.concat([before.subarray(0, at), repl, before.subarray(at + needle.length)])
  } else {
    const { stream, group, at } = splitHit
    after = applySplit(all[stream].data, group, at, at + needle.length, repl.toString('latin1'))
    hit = stream
  }
  const { sp } = all[hit]
  const raw = encode(sp.dict, after)
  const dict = replaceLength(sp.dict, raw.length)
  const rebuilt = Buffer.concat([dict, Buffer.from('\nstream\n', 'latin1'), raw, Buffer.from('\nendstream\nendobj', 'latin1')])
  const modified = Buffer.concat([working.subarray(0, sp.start), rebuilt, working.subarray(sp.end)])

  if (hasQpdf && normalized) {
    const dir = path.dirname(normalized)
    const afterEdit = path.join(dir, 'after.qdf'), finalPdf = path.join(dir, 'final.pdf')
    fs.writeFileSync(afterEdit, modified)
    const f = runQpdf([afterEdit, finalPdf])
    if (f.ok && fs.existsSync(finalPdf)) return done({ data: fs.readFileSync(finalPdf), replacements: 1, warnings })
    warnings.push('qpdf finalize failed: ' + (f.stderr || 'unknown'))
  }
  return done({ data: modified, replacements: 1, warnings })
}

module.exports = { replaceTextInPdfBuffer, qpdfCmd }
