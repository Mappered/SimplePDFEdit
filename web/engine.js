// Browser port of app/streamReplace.js - the same scan/replace logic, with the Flate
// filter handled by the platform's CompressionStream/DecompressionStream instead of
// Node's zlib. There is no qpdf here, so the file is edited as-is: the cross-reference
// table of a classic (PDF <= 1.4 style) file is repaired in place, anything else is
// reported in the warnings.

// Minimal stand-in for the parts of Node's Buffer this code uses, so the scanning and
// rewriting logic could be ported unchanged.
class ByteBuf extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === 'string') {
      if (encoding && encoding !== 'latin1') throw new Error('only latin1 is supported')
      const out = new ByteBuf(value.length)
      for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
      return out
    }
    if (value instanceof Uint8Array) return new ByteBuf(value)
    if (Array.isArray(value)) return new ByteBuf(value)
    throw new Error('unsupported input for Buffer.from')
  }

  static concat(list) {
    let total = 0
    for (const part of list) total += part.length
    const out = new ByteBuf(total)
    let at = 0
    for (const part of list) { out.set(part, at); at += part.length }
    return out
  }

  toString(encoding) {
    if (encoding && encoding !== 'latin1') throw new Error('only latin1 is supported')
    const chunk = 0x8000
    if (this.length <= chunk) return String.fromCharCode.apply(null, this)
    let out = ''
    for (let i = 0; i < this.length; i += chunk) out += String.fromCharCode.apply(null, this.subarray(i, i + chunk))
    return out
  }

  includes(needle) { return this.toString('latin1').includes(needle) }

  indexOf(needle, from = 0) {
    const n = needle.length
    if (!n) return from < this.length ? from : -1
    for (let i = Math.max(0, from); i <= this.length - n; i++) {
      let j = 0
      while (j < n && this[i + j] === needle[j]) j++
      if (j === n) return i
    }
    return -1
  }

  write(text, offset, length) {
    for (let i = 0; i < length; i++) this[offset + i] = text.charCodeAt(i) & 0xff
    return length
  }
}

const Buffer = ByteBuf
const latin1 = b => b.toString('latin1')

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return Buffer.from(new Uint8Array(await new Response(stream).arrayBuffer()))
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decode(dict, raw) {
  if (dict.includes('/FlateDecode')) {
    try { return await inflate(raw) } catch { return null }
  }
  return raw
}

const encode = (dict, data) => (dict.includes('/FlateDecode') ? deflate(data) : data)

// Filters we cannot decode, or that hold image data rather than text.
const OPAQUE_FILTERS = ['/DCTDecode', '/JPXDecode', '/CCITTFaxDecode', '/JBIG2Decode', '/LZWDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/RunLengthDecode', '/Crypt']

function isOpaqueStream(dictText) {
  if (/\/Subtype\s*\/Image\b/.test(dictText)) return true
  return OPAQUE_FILTERS.some(f => dictText.includes(f))
}

// `/Length` may be an indirect reference (`/Length 12 0 R`).
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

function spans(buf) {
  const s = latin1(buf)
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
    const len = declaredLength(latin1(dict), s)
    let be = es
    if (len !== null && len >= 0 && bs + len <= es) be = bs + len
    else while (be > bs && (s[be - 1] === '\n' || s[be - 1] === '\r')) be--
    out.push({ start, end, dict, raw: buf.subarray(bs, be) })
  }
  return out
}

function replaceLength(dict, len) {
  const t = latin1(dict)
  return Buffer.from(/\/Length\s+\d+/.test(t) ? t.replace(/\/Length\s+\d+(?:\s+\d+\s+R)?/, `/Length ${len}`) : t.replace(/<<\s*/, `<< /Length ${len} `), 'latin1')
}

const DELIMS = ' \t\r\n\f()<>[]{}/%'
const isDelim = c => DELIMS.includes(c)
const MAX_TOKENS = 5e6

function tokenize(data) {
  const s = latin1(data)
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
            while (k < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') { i++; oct += s[i]; k++ }
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
    if (i === start) { i++; continue }
    toks.push({ type: 'word', start, end: i })
  }
  return toks
}

// Text-showing groups: strings inside a [...] TJ array, or the string operand of a single Tj.
function textGroups(data) {
  const s = latin1(data)
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

const encLiteral = content => content.replace(/([\\()])/g, '\\$1')
function encHex(content) {
  let h = ''
  for (let k = 0; k < content.length; k++) h += content.charCodeAt(k).toString(16).padStart(2, '0')
  return h
}

function applySplit(data, group, ms, me, repl) {
  const s = latin1(data)
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

// Moves every cross-reference entry that points past the patched object, and the
// startxref value, so a classic xref table stays valid. Returns null when the file has
// no classic table (e.g. it uses an xref stream), which the caller reports as a warning.
function repairClassicXref(buf, patchStart, delta) {
  if (!delta) return buf
  const s = latin1(buf)
  const sx = s.lastIndexOf('startxref')
  if (sx < 0) return null
  const m = /startxref\s+(\d+)/.exec(s.slice(sx))
  if (!m) return null
  // The stored offset is the pre-edit one; the table itself moved by delta when the
  // patch sat before it in the file.
  const stored = Number(m[1])
  let xrefPos = -1
  for (const candidate of [stored + delta, stored]) {
    if (candidate > 0 && candidate < buf.length && s.slice(candidate, candidate + 4) === 'xref') { xrefPos = candidate; break }
  }
  if (xrefPos < 0) return null

  const out = Buffer.from(buf)
  let p = xrefPos + 4
  const isWs = c => c === ' ' || c === '\n' || c === '\r' || c === '\t'
  for (;;) {
    while (p < out.length && isWs(String.fromCharCode(out[p]))) p++
    if (s.slice(p, p + 7) === 'trailer') break
    const sub = /^(\d+)\s+(\d+)\s*/.exec(s.slice(p, p + 32))
    if (!sub) return null
    const count = Number(sub[2])
    p += sub[0].length
    for (let i = 0; i < count; i++) {
      const entry = s.slice(p, p + 20)
      const em = /^(\d{10})\s+(\d{5})\s+([nf])/.exec(entry)
      if (!em) return null
      const offset = Number(em[1])
      if (em[3] === 'n' && offset > patchStart) {
        const moved = String(offset + delta).padStart(10, '0')
        if (moved.length !== 10) return null
        out.write(moved, p, 10, 'latin1')
      }
      p += 20
    }
  }

  // Keep the byte length of the whole file by padding the new value with spaces.
  const digits = m[1]
  const valueStart = sx + m[0].length - digits.length
  const moved = String(xrefPos)
  if (moved.length > digits.length) return null
  out.write(' '.repeat(digits.length - moved.length) + moved, valueStart, digits.length, 'latin1')
  return out
}

export async function replaceTextInPdfBuffer(input, edit) {
  const warnings = []
  // The ported scanner works on ByteBuf, so make sure we own that type here.
  const working = Buffer.from(input)
  const needle = Buffer.from(edit.text, 'latin1')
  const repl = Buffer.from(edit.replacement, 'latin1')

  const all = []
  let skipped = 0
  for (const sp of spans(working)) {
    if (isOpaqueStream(latin1(sp.dict))) continue
    const data = await decode(sp.dict, sp.raw)
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
    const sdata = latin1(x.data)
    for (const g of groups) {
      let gi = 0
      while (true) {
        const idx = g.visible.indexOf(latin1(needle), gi)
        if (idx < 0) break
        gi = idx + Math.max(1, needle.length)
        const si0 = g.map[idx], si1 = g.map[idx + needle.length - 1]
        if (si0 === si1 && sdata.includes(latin1(needle), g.strs[si0].start)) continue
        total++; splitHit = { stream: i, group: g, at: idx }
      }
    }
  })
  if (total !== 1 || (hit < 0 && !splitHit)) {
    warnings.push(`Found ${total} literal/split occurrence(s) for ${JSON.stringify(edit.text)}. Refusing ambiguous/non-literal edit.`)
    return { data: input, replacements: 0, warnings }
  }

  let after
  if (hit >= 0) {
    const before = all[hit].data
    const at = before.indexOf(needle)
    after = Buffer.concat([before.subarray(0, at), repl, before.subarray(at + needle.length)])
  } else {
    const { stream, group, at } = splitHit
    after = applySplit(all[stream].data, group, at, at + needle.length, latin1(repl))
    hit = stream
  }

  const { sp } = all[hit]
  const raw = await encode(sp.dict, after)
  const dict = replaceLength(sp.dict, raw.length)
  const rebuilt = Buffer.concat([dict, Buffer.from('\nstream\n', 'latin1'), raw, Buffer.from('\nendstream\nendobj', 'latin1')])
  const modified = Buffer.concat([working.subarray(0, sp.start), rebuilt, working.subarray(sp.end)])

  const repaired = repairClassicXref(modified, sp.start, rebuilt.length - (sp.end - sp.start))
  if (!repaired) {
    warnings.push('Could not update the cross-reference table (the file uses an xref stream). Viewers that rebuild broken tables still open it; use the desktop build for a byte-perfect file.')
    return { data: modified, replacements: 1, warnings }
  }
  return { data: repaired, replacements: 1, warnings }
}
