// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit
// format (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits). It reads a patch
// in one of the four formats, finds the lines each edit names at the first of
// three matching tiers, and writes every change or none, printing what it
// changed or why it failed. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, in order, for the `R old -> new` output lines. */
  readonly moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  endsWith: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', endsWith: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const endsWith = text.endsWith(br);
  if (endsWith) lines.pop();
  return { lines, br, endsWith };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.endsWith ? m.br : '');
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 5: matching lines -------------------------------------------

/** Spaces and tabs at the end of a line. */
function trimTrail(s: string): string {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(0, e);
}

/** Spaces and tabs at both ends of a line. */
function trimBoth(s: string): string {
  let b = 0;
  while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b += 1;
  let e = s.length;
  while (e > b && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(b, e);
}

/** The leading spaces and tabs of a line. */
function leadingWS(s: string): string {
  let e = 0;
  while (e < s.length && (s[e] === ' ' || s[e] === '\t')) e += 1;
  return s.slice(0, e);
}

/** Is a line empty or only spaces and tabs? */
function onlyWS(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** Do two lines match at a tier: 0 exact, 1 trailing-insensitive, 2 both-ends-insensitive. */
function lineAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Positions where O occurs in lines at a tier, at or after `from`; end-anchored only when asked. */
function occurrences(lines: string[], o: string[], tier: number, from: number, endAnchored: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (endAnchored && i + o.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineAt(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, endAnchored = false): { tier: number; positions: number[] } {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from, endAnchored);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return { tier: 0, positions: [] };
}

/** The first line at or after `from` equal to one line, at the first tier where one is. */
function findSingleLine(lines: string[], want: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineAt(lines[i]!, want, t)) return i;
    }
  }
  return null;
}

/** One line of O: a context line or a line being removed. */
interface OldLine {
  ctx: boolean;
  text: string;
}

/** One line of N: a context line (written as the file's own line) or a fresh line. */
interface NewLine {
  ctx: boolean;
  text: string;
  /** For a context line, its index inside O. */
  oIndex: number;
}

/**
 * The lines N writes in place of O's occurrence at `start`: context lines come
 * from the file itself, fresh lines are re-indented at tier 2 (P, the leading
 * whitespace of O's first line, replaced by F, that of the file's first
 * matched line).
 */
function buildNewLines(fileLines: string[], start: number, o: OldLine[], n: NewLine[], tier: number): string[] {
  const p = o.length > 0 ? leadingWS(o[0]!.text) : '';
  const f = start < fileLines.length ? leadingWS(fileLines[start]!) : '';
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx) {
      out.push(fileLines[start + item.oIndex]!);
    } else {
      let t = item.text;
      if (tier === 2 && t !== '' && !onlyWS(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

// ---- Section 6: unified diffs --------------------------------------------

/** One line of a unified hunk's body. */
interface HunkLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  /** The patch line as written, so a trailing ` ` line is not trimmed as an empty one. */
  raw: string;
}

interface Hunk {
  /** Old start line, 1-based (A in `@@ -A[,B] +C[,D] @@`). */
  a: number;
  body: HunkLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path a `--- ` or `+++ ` header line names: after the four characters, up to the first tab, spaces removed. */
function pathFromHeader(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** A leading `a/` or `b/` is removed from a `---`/`+++` path. */
function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface SectionScratch {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** Resolve a section's paths: the `---`/`+++` pair wins over rename lines, which win over `diff --git`. */
function resolveSection(s: SectionScratch): Section {
  const pick = (pair: string | null, rename: string | null, git: string | null): string | null => {
    const raw = pair ?? rename ?? git;
    if (raw === null || raw === '/dev/null') return null;
    return pair !== null ? stripPrefix(raw) : raw;
  };
  return {
    oldPath: pick(s.pairOld, s.renameFrom, s.gitOld),
    newPath: pick(s.pairNew, s.renameTo, s.gitNew),
    isCreate: s.isCreate,
    isDelete: s.isDelete,
    hunks: s.hunks,
  };
}

/** Trim the empty lines at the end of a hunk's body and work out its `\` markers. */
function finishHunk(h: Hunk): void {
  while (h.body.length > 0 && h.body[h.body.length - 1]!.raw === '') h.body.pop();
  let lastCtxOrNew = -1;
  let lastNew = -1;
  for (let j = 0; j < h.body.length; j += 1) {
    const k = h.body[j]!.kind;
    if (k === 'ctx' || k === 'new') lastCtxOrNew = j;
    if (k === 'new') lastNew = j;
  }
  h.noEol = lastCtxOrNew >= 0 && h.body[lastCtxOrNew + 1] !== undefined && h.body[lastCtxOrNew + 1]!.kind === 'mark';
  h.noEolPlus = lastNew >= 0 && h.body[lastNew + 1] !== undefined && h.body[lastNew + 1]!.kind === 'mark';
}

/** A hunk's O (context and `-` lines) and N (context and `+` lines), in body order. */
function hunkOldNew(h: Hunk): { o: OldLine[]; n: NewLine[] } {
  const o: OldLine[] = [];
  const n: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      o.push({ ctx: true, text: b.text });
      n.push({ ctx: true, text: b.text, oIndex: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push({ ctx: false, text: b.text });
    } else if (b.kind === 'new') {
      n.push({ ctx: false, text: b.text, oIndex: -1 });
    }
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file's text; `path` names the file on a failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const m = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkOldNew(h);
    const oTexts = o.map((x) => x.text);
    if (o.length === 0) {
      const at = Math.min(h.a + d, m.lines.length);
      const atEnd = at === m.lines.length;
      const ins = n.map((x) => x.text);
      m.lines.splice(at, 0, ...ins);
      if (atEnd) m.endsWith = !h.noEol;
      d += n.length;
      continue;
    }
    const { tier, positions } = findTier(m.lines, oTexts, strict);
    if (positions.length === 0) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + o.length === m.lines.length;
    const replaced = buildNewLines(m.lines, best, o, n, tier);
    m.lines.splice(best, o.length, ...replaced);
    if (runsToEnd) m.endsWith = !h.noEol;
    d += n.length - o.length;
  }
  return joinFile(m);
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = newP === null || sec.isDelete;
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const b of h.body) {
          if (b.kind === 'new') {
            plus.push(b.text);
            hasPlus = true;
          }
        }
        if (hasPlus) noEol = h.noEolPlus;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const old = oldP!;
    const nw = newP!;
    if (old !== nw) {
      const before = tree.get(old);
      if (before === null) throw new Fail('missing', old);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const out = applyHunks(before, sec.hunks, strict, old);
      tree.now.set(old, null);
      tree.now.set(nw, out);
      tree.moves.push({ from: old, to: nw });
      return;
    }
    const before = tree.get(old);
    if (before === null) throw new Fail('missing', old);
    tree.now.set(old, applyHunks(before, sec.hunks, strict, old));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let s: SectionScratch | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;

  const closeHunk = (): void => {
    if (hunk !== null && s !== null) {
      finishHunk(hunk);
      s.hunks.push(hunk);
      hunk = null;
    }
  };
  const closeSection = (): void => {
    closeHunk();
    if (s !== null) {
      sections.push(resolveSection(s));
      s = null;
    }
    inHeader = false;
  };
  const isBodyLine = (l: string): boolean =>
    l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      // A `--- ` line followed by a `+++ ` line ends the body and starts a section.
      if (line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) {
        closeHunk();
        continue;
      }
      if (isBodyLine(line)) {
        const kind = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'mark';
        hunk.body.push({ kind, text: kind === 'mark' || line === '' ? line : line.slice(1), raw: line });
        i += 1;
        continue;
      }
      closeHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeSection();
      s = { gitOld: m[1]!, gitNew: m[2]!, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = pathFromHeader(line);
        const newP = pathFromHeader(next);
        if (s !== null && inHeader) {
          s.pairOld = oldP;
          s.pairNew = newP;
        } else {
          closeSection();
          s = { gitOld: null, gitNew: null, pairOld: oldP, pairNew: newP, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (s !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (s === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [], noEol: false, noEolPlus: false };
      inHeader = false;
      i += 1;
      continue;
    }
    if (s !== null && inHeader) {
      if (line.startsWith('rename from ')) s.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) s.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) s.isCreate = true;
      else if (line.startsWith('deleted file mode')) s.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  closeSection();
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ------------------------------------

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before the SEARCH line, after the previous
    // block's REPLACE line, that is not blank and does not start with fences.
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let j = searchIdx + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const eqIdx = j;
    j += 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const repIdx = j;
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eqIdx), newLines: lines.slice(eqIdx + 1, repIdx) });
    prevPath = path;
    prevReplaceEnd = repIdx;
    i = repIdx + 1;
  }
  return blocks.map((b) => {
    const oldItems: OldLine[] = b.oldLines.map((t) => ({ ctx: false, text: t }));
    const newItems: NewLine[] = b.newLines.map((t) => ({ ctx: false, text: t, oIndex: -1 }));
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const m = splitFile(before);
      const { tier, positions } = findTier(m.lines, b.oldLines, strict);
      if (positions.length === 0) throw new Fail('no-match', b.path);
      if (positions.length > 1) throw new Fail('ambiguous', b.path);
      const at = positions[0]!;
      const replaced = buildNewLines(m.lines, at, oldItems, newItems, tier);
      m.lines.splice(at, b.oldLines.length, ...replaced);
      tree.now.set(b.path, joinFile(m));
    };
  });
}

// ---- Section 8: V4A patches ----------------------------------------------

interface V4aChunk {
  /** Null anchor: no `@@` line. */
  anchor: string | null;
  body: string[];
  /** A `*** End of File` line ended this chunk. */
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Raw lines of the section (blank lines at its end already removed), each with its patch line number. */
  raw: Array<{ text: string; num: number }>;
  /** The patch line number of the section's start line. */
  line: number;
}

/** Is a line a body line of an Update chunk: ` `, `-`, `+`, or empty? */
function isV4aBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i += 1;
    const raw: Array<{ text: string; num: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, num: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push({ kind, path, raw, line: startLine });
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

/** A chunk's O (context and `-` lines) and N (context and `+` lines), in body order. */
function v4aChunkOldNew(body: string[]): { o: OldLine[]; n: NewLine[] } {
  const o: OldLine[] = [];
  const n: NewLine[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      o.push({ ctx: true, text: l.slice(1) });
      n.push({ ctx: true, text: l.slice(1), oIndex: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push({ ctx: false, text: l.slice(1) });
    } else if (l.startsWith('+')) {
      n.push({ ctx: false, text: l.slice(1), oIndex: -1 });
    } else {
      // An empty line is an empty context line.
      o.push({ ctx: true, text: '' });
      n.push({ ctx: true, text: '', oIndex: o.length - 1 });
    }
  }
  return { o, n };
}

function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, num } of sec.raw) {
      if (text.startsWith('+')) fileLines.push(text.slice(1));
      else if (text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${num}`);
    }
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    for (const { num } of sec.raw) throw new Exit2(`error: parse ${num}`);
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  // Update File: an optional `*** Move to:` first line, then chunks.
  let moveTo: string | null = null;
  let idx = 0;
  if (sec.raw.length > 0 && sec.raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = sec.raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let firstChunk = true;
  for (; idx < sec.raw.length; idx += 1) {
    const { text, num } = sec.raw[idx]!;
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: text.slice(2).trim(), body: [], eof: false };
      firstChunk = false;
    } else if (text.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      firstChunk = false;
    } else if (isV4aBodyLine(text)) {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${num}`);
        cur = { anchor: null, body: [], eof: false };
        firstChunk = false;
      }
      cur.body.push(text);
    } else {
      throw new Exit2(`error: parse ${num}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const at = findSingleLine(m.lines, chunk.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const { o, n } = v4aChunkOldNew(chunk.body);
      const oTexts = o.map((x) => x.text);
      if (o.length === 0) {
        const at = chunk.eof ? m.lines.length : cursor;
        const ins = n.map((x) => x.text);
        m.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const { tier, positions } = findTier(m.lines, oTexts, strict, cursor, chunk.eof);
      if (positions.length === 0) throw new Fail('no-match', sec.path);
      const at = positions[0]!;
      const replaced = buildNewLines(m.lines, at, o, n, tier);
      m.lines.splice(at, o.length, ...replaced);
      cursor = at + replaced.length;
    }
    const out = joinFile(m);
    if (moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ from: sec.path, to: moveTo });
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

// ---- Section 10: order, atomicity, output --------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per path whose state changed, in byte order of the paths; a move
  // prints `R old -> new` (sorted by the new path) instead of its D and A lines.
  const rows: Array<{ key: string; line: string }> = [];
  const noD = new Set<string>();
  const noA = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      noD.add(m.from);
      noA.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && noA.has(p)) continue;
    if (now === null && noD.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
