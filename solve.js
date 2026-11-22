// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Written from the kit's README + vendor code semantics, reimplemented for speed:
// streaming Markdown over the line array (no token objects), bulk-segment inline
// parsing (no per-character escape), ASCII fast paths for slugify, per-case slug
// caching, and a template interpreter that pushes into one shared output array.
// No network, no randomness, no clock; deterministic; nothing kept between cases.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
export function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// Slugify, exactly as the reference: NFKD, drop combining marks, A-Z lowered,
// each run of non [a-z0-9] one '-', none at either end, cut to 64 (trailing '-'
// at the cut dropped), 'untitled' when empty. ASCII fast path avoids normalize
// and regex entirely; non-ASCII input takes the reference algorithm verbatim.
const MARK_RE = /\p{M}/gu;
export function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(MARK_RE, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  // ASCII: build into a small array, join once.
  const buf = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) { gap = buf.length > 0; continue; }
    if (gap) buf.push(45);
    gap = false;
    buf.push(keep);
  }
  let out = String.fromCharCode.apply(null, buf);
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---- front matter (operates on the source's line array; body starts at `bodyFrom`) ----
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

// Parse front matter from `lines`; returns { data, bodyFrom } or { error }.
// Mirrors the reference exactly, including error strings and check order.
export function parseFrontMatterLines(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyFrom: close + 1 };
}

// ---- Markdown (direct rendering over lines[from..to); no token objects) ----

// trim spaces/tabs at both ends (reference trimLine)
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}
// Fence open: ``` + lang chars + spaces/tabs only; returns lang or null.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(start, i);
  while (i < line.length) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
// Heading: 1-6 '#', >=1 space/tab, non-empty text after trailing trim; returns {depth,text} or null.
function headingOf(line) {
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0) return null;
  // 7 or more '#' is not a heading: only when 6 were counted and a 7th follows.
  if (n === 6 && line.charCodeAt(6) === 35) return null;
  let i = n;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let e = line.length;
  while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === i) return null;
  return { depth: n, text: line.slice(i, e) };
}
function isHR(line) {
  const a = line.charCodeAt(0), b = line.charCodeAt(1), c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) { const ch = line.charCodeAt(i); if (ch !== 32 && ch !== 9) return false; }
  return true;
}
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

// ---- inline ----
const ESCAPABLE = '\\` *_[]()#+-.!>';
function isEscapable(ch) { return ESCAPABLE.indexOf(ch) !== -1; }

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}
const WS_RE = /\s/;

// Inline render into `out` (array). `link` resolves a link target to its href.
function inlineInto(s, link, out) {
  let i = 0;
  let seg = 0; // start of current plain segment (contains no escapable char: escaping is done in-loop)
  const flush = (end) => { if (end > seg) out.push(s.slice(seg, end)); };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isEscapable(s[i + 1])) {
      flush(i);
      // the reference escapes the escaped character too: '>' (the only escapable
      // char that needs it) becomes '&gt;', the rest pass through unchanged
      out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
      i += 2; seg = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1; seg = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          i = j + 2; seg = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), link, out);
        out.push('</em>');
        i = j + 1; seg = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = m + 1; seg = i;
      } else i++;
      continue;
    }
    if (c === '&') { flush(i); out.push('&amp;'); i++; seg = i; continue; }
    if (c === '<') { flush(i); out.push('&lt;'); i++; seg = i; continue; }
    if (c === '>') { flush(i); out.push('&gt;'); i++; seg = i; continue; }
    if (c === '"') { flush(i); out.push('&quot;'); i++; seg = i; continue; }
    if (c === "'") { flush(i); out.push('&#39;'); i++; seg = i; continue; }
    i++;
  }
  flush(s.length);
}
function inline(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

// Render body lines[start..end) to HTML; returns { html, toc, excerpt }.
function renderMarkdownLines(lines, from, to, link, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  while (i < to) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < to && !fenceClose(lines[i])) body.push(lines[i++]);
      i++; // skip close line, or past the end
      let code = '';
      if (body.length) {
        const parts = [];
        for (let q = 0; q < body.length; q++) { parts.push(escapeHtml(body[q])); parts.push('\n'); }
        code = parts.join('');
      }
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugCached(heading.text, slugCache), ids);
      const html = inline(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < to && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const b0 = line.charCodeAt(0);
    const isBullet = (b0 === 45 || b0 === 42) && line.charCodeAt(1) === 32;
    let ordered = null;
    if (!isBullet) {
      // ordered: 1-9 digits, '. '
      let d = 0;
      while (d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d > 0 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) ordered = line.slice(0, d);
    }
    if (isBullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < to) {
        const l = lines[i];
        let m = null;
        if (isOrdered) {
          let d = 0;
          while (d < 9 && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d > 0 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) m = l.slice(d + 2);
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          m = l.slice(2);
        }
        if (m !== null) { items.push([trimLine(m)]); i++; }
        else if (/^ {2,}\S/.test(l)) { items[items.length - 1].push(trimLine(l)); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered) !== 1 ? `<ol start="${Number(ordered)}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (let q = 0; q < items.length; q++) { parts.push('<li>', inline(items[q].join('\n'), link), '</li>\n'); }
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''));
      continue;
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < to && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length ? blocks.map((b) => `${b}\n`).join('') : '', toc, excerpt: excerpt ?? '' };
}

function slugCached(text, cache) {
  let s = cache.get(text);
  if (s === undefined) { s = slugify(text); cache.set(text, s); }
  return s;
}

// ---- templates ----
const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v, out) {
  if (typeof v === 'string') { out.push(v); return; }
  if (typeof v === 'number' || typeof v === 'boolean') { out.push(String(v)); return; }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (i) out.push(', ');
      textOf(v[i], out);
    }
    return;
  }
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Render `nodes` into `out` (array). Scope objects for `for` are created once
// per execution and mutated per iteration (rendering is synchronous).
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text': out.push(n.text); break;
      case 'var': {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') out.push(escapeHtml(v));
        else if (v !== undefined && v !== null && (typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v))) {
          const tmp = [];
          textOf(v, tmp);
          out.push(escapeHtml(tmp.join('')));
        }
        break;
      }
      case 'raw': textOf(lookup(scope, n.path), out); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const vars = Object.create(null);
        const loop = { index: 1, first: true, last: false, length: xs.length };
        vars[n.name] = undefined;
        vars.loop = loop;
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---- build pipeline ----
const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Words in lines[from..to): runs of non-whitespace. A '\n' join can never merge
// words across lines, so per-line counts sum exactly. ASCII lines use a charCode
// scan (ASCII whitespace is exactly 9-13 and 32); any line with a char >= 128
// falls back to the reference's /\S+/ count for that line.
const NON_ASCII_RE = /[^\x00-\x7F]/;
function countWordsLines(lines, from, to) {
  let total = 0;
  for (let li = from; li < to; li++) {
    const line = lines[li];
    if (NON_ASCII_RE.test(line)) {
      const m = line.match(/\S+/g);
      if (m !== null) total += m.length;
      continue;
    }
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      const ws = c === 32 || (c >= 9 && c <= 13);
      if (ws) inWord = false;
      else if (!inWord) { inWord = true; total++; }
    }
  }
  return total;
}

function resolvePathSegs(dirSegs, rel) {
  const parts = dirSegs.slice();
  let i = 0;
  while (i <= rel.length) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = rel.length;
    const seg = rel.slice(i, j);
    if (seg !== '' && seg !== '.') {
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
    i = j + 1;
    if (j === rel.length) break;
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) continue;
    return false;
  }
  return false;
}

export function run(input) {
  const slugCache = new Map();
  const slug = (t) => slugCached(t, slugCache);
  const templates = new Map();
  const report = [];
  const tmplNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tmplNames.length; i++) {
    const name = tmplNames[i];
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. sources, sorted by path in code-unit order
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter, in order, first failure reported
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatterLines(s.lines);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.bodyFrom = fm.bodyFrom;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources = kept;

  // 3. permalinks
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown + links
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dirSegs = dirOf(s.path) === '' ? [] : dirOf(s.path).split('/');
    const srcPath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePathSegs(dirSegs, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdownLines(s.lines, s.bodyFrom, s.lines.length, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // body string (for the word count) is the lines after the front matter
    s.words = countWordsLines(s.lines, s.bodyFrom, s.lines.length);
  }

  // 5. collections: posts newest first, equal dates by slug
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const sl = slug(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) { tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] }; bySlug.set(sl, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slug(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards (once per source) and page objects
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  for (const s of sources) {
    if (s.post) { s.card = cards.get(s); continue; }
    s.card = cardOf(s);
  }
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. layouts
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
