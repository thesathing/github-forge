// Pure git object/pack/pkt-line helpers. No project imports, no I/O, stdlib only.
// Every function here is deterministic: same bytes in, same bytes out.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { readonly type: GitObjectType; readonly data: Buffer; }

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(v: string): boolean { return HEX40.test(v); }

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}

export interface TreeEntry { readonly mode: string; readonly name: string; readonly oid: string; }

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    const nul = buf.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > buf.length) throw new Error('bad tree');
    entries.push({ mode: buf.subarray(off, sp).toString('ascii'), name: buf.subarray(sp + 1, nul).toString('utf8'), oid: buf.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { readonly tree: string; readonly parents: string[]; readonly author: string; readonly committer: string; readonly message: string; }

export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView { readonly object: string; readonly type: GitObjectType; readonly tag: string; readonly tagger: string; readonly message: string; }

export function parseTag(data: Uint8Array): TagView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const headers = new Map<string, string>();
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '', type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------- pkt-line

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLines(items: readonly (string | Uint8Array | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const out: GitPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------- packfile

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuf = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const d = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let off = 0;
  const readSize = (): number => {
    let value = 0; let shift = 0;
    for (;;) {
      const byte = d[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuf.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < d.length) {
    const op = d[off++];
    if (op & 0x80) {
      let copyOff = 0; let copySize = 0; let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) { if (op & (1 << bit)) copyOff += d[off++] * 2 ** shift; shift += 8; }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) { if (op & (1 << bit)) copySize += d[off++] * 2 ** shift; shift += 8; }
      if (copySize === 0) copySize = 0x10000;
      baseBuf.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      d.copy(out, written, off, off + n);
      off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackRead { readonly objects: Map<string, GitObject>; readonly count: number; }

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA. */
export function readPack(pack: Uint8Array, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const header = readVarintSize(buf, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buf, off);
      off = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error(`unknown pack type ${typeCode}`);
    const inflated = inflateAt(buf, off, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const byOid = new Map<string, number>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done) return done;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType; let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type; data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!) !== undefined ? raw[byOid.get(entry.baseOid!)!] : undefined;
      if (baseEntry) { const base = resolve(baseEntry); type = base.type; data = applyDelta(base.data, entry.data); }
      else {
        const ext = resolveBase?.(entry.baseOid!);
        if (!ext) throw new Error(`ref-delta base ${entry.baseOid} missing`);
        type = ext.type; data = applyDelta(ext.data, entry.data);
      }
    } else { type = CODE_TYPE[entry.typeCode]; data = entry.data; }
    const oid = hashObject(type, data);
    const r = { type, data, oid };
    resolved.set(entry.offset, r);
    byOid.set(oid, raw.indexOf(entry));
    resolving.delete(entry.offset);
    return r;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { objects, count };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) { bytes.push(first | 0x80); first = remaining & 0x7f; remaining = Math.floor(remaining / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Cache of zlib-deflated object bytes, keyed by oid. The clone workload sends the
 *  same objects to 50 concurrent clients; deflating once instead of 50x is a large
 *  win. Bounded FIFO eviction keeps memory in check. */
const deflateCache = new Map<string, Buffer>();
const DEFLATE_CACHE_MAX = 4096;
function deflateCached(oid: string, data: Buffer): Buffer {
  const hit = deflateCache.get(oid);
  if (hit !== undefined) return hit;
  const out = deflateSync(data);
  if (deflateCache.size >= DEFLATE_CACHE_MAX) {
    const first = deflateCache.keys().next();
    if (!first.done) deflateCache.delete(first.value);
  }
  deflateCache.set(oid, out);
  return out;
}

/** Build a plain-object packfile (no deltas). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    // GitObject carries no oid (the map key is the oid); derive it from content —
    // the cache key is then correct by construction.
    parts.push(deflateCached(hashObject(o.type, o.data), o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function packChecksumOk(pack: Uint8Array): boolean {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 20) return false;
  const actual = buf.subarray(buf.length - 20).toString('hex');
  return actual === createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
}

// ---------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Objects reachable from `roots`. `maxCommitDepth`: generations of commits to include
 * (Infinity = all). Returns the set and, when depth-limited, the shallow boundary commits
 * (included commits at depth maxCommitDepth-1 that have parents).
 */
export function reachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  maxCommitDepth = Infinity,
): { objects: Set<string>; shallow: string[] } {
  const seen = new Set<string>();
  const shallow: string[] = [];
  // queue of [oid, commitDepth]; tags resolve without consuming depth.
  const queue: Array<[string, number]> = [];
  for (const r of roots) if (isObjectId(r)) queue.push([r, 0]);
  while (queue.length) {
    const [oid, depth] = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue; // caller validates tips exist; missing base = skip
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      seen.add(c.tree);
      const treeObj = lookup(c.tree);
      if (treeObj) collectTree(treeObj.data, lookup, seen);
      if (depth + 1 < maxCommitDepth) {
        for (const p of c.parents) queue.push([p, depth + 1]);
      } else if (c.parents.length) {
        shallow.push(oid);
      }
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      queue.push([t.object, depth]);
    } else if (obj.type === 'tree') {
      collectTree(obj.data, lookup, seen);
    }
  }
  return { objects: seen, shallow };
}

function collectTree(data: Buffer, lookup: ObjectLookup, seen: Set<string>): void {
  for (const e of parseTree(data)) {
    if (e.mode === '160000') continue;
    if (seen.has(e.oid)) continue;
    const obj = lookup(e.oid);
    if (!obj) continue;
    seen.add(e.oid);
    if (obj.type === 'tree') collectTree(obj.data, lookup, seen);
  }
}

/** Full closure (all generations) of `roots`. */
export function closure(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  return reachable(roots, lookup, Infinity).objects;
}

/** Is `ancestor` reachable from `tip` (commit ancestry)? */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
    else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
  }
  return false;
}

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(treeOid: string, lookup: ObjectLookup, out = new Map<string, { oid: string; mode: string }>(), prefix = ''): Map<string, { oid: string; mode: string }> {
  const obj = lookup(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(e.oid, lookup, out, path);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Build trees from a flat file map; returns the root tree oid. `put` stores new objects. */
export function buildTreeFromFiles(
  files: ReadonlyMap<string, { oid: string; mode: string }>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const name = segs[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segs[segs.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, oid: e.oid, name });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', oid: build(child), name });
    return put('tree', buildTree(entries));
  };
  return build(root);
}
