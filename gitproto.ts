// Git smart HTTP: info/refs (v0 + v2), upload-pack (v2 + v0), receive-pack (v0).
// Handlers take the raw request body and return {status, contentType, body}.

import {
  ZERO_OID, decodePktLines, hashObject, isObjectId, parseTag, pktLine, pktLines,
  readPack, writePack, PKT_DELIM, PKT_FLUSH, type GitObject,
} from './gitcore.ts';
import { fastForwardOk, getRepo, planFetch, putObject, type Repo } from './store.ts';

export interface GitResponse { status: number; contentType: string; body: Buffer; }

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
}
function badRequest(msg: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: msg }) + '\n') };
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

function peeledOid(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  let target = parseTag(obj.data).object;
  let guard = 0;
  while (guard++ < 10) {
    const t = repo.objects.get(target);
    if (!t || t.type !== 'tag') break;
    target = parseTag(t.data).object;
  }
  return target;
}

// ---------------------------------------------------------------- info/refs

function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (service === 'git-upload-pack') {
    return `side-band-64k thin-pack ofs-delta shallow multi_ack ${symref} agent=forge/1.0`;
  }
  return `report-status side-band-64k delete-refs ofs-delta ${symref} agent=forge/1.0`;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(repo, service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = head ? `${head} HEAD\0${caps}\n` : `${ZERO_OID} HEAD\0${caps}\n`;
    parts.push(pktLine(headLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'server-option\n',
  ];
  return Buffer.concat([pktLine(lines[0]!), ...lines.slice(1).map((l) => pktLine(l)), PKT_FLUSH]);
}

export function infoRefs(owner: string, repoName: string, service: string, gitProtocol: string | undefined): GitResponse {
  const repo = getRepo(owner, repoName);
  if (!repo) return notFound();
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  if (service !== 'git-upload-pack') return notFound();
  if (gitProtocol === 'version=2') {
    return { status: 200, contentType: UPLOAD_AD, body: v2Advertisement() };
  }
  return { status: 200, contentType: UPLOAD_AD, body: v0Advertisement(repo, 'git-upload-pack') };
}

// ---------------------------------------------------------------- upload-pack v2

interface V2FetchArgs {
  wants: string[]; haves: string[]; shallow: string[]; depth?: number;
  deepenSince?: number; deepenNot: string[]; filter?: string;
}

function parseV2Request(body: Buffer): { command: string; args: Map<string, string[]>; lines: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let command = '';
  const args = new Map<string, string[]>();
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (!inArgs) {
      const m = /^command=(\S+)\n?$/.exec(text.trim());
      if (m) command = m[1]!;
      continue;
    }
    lines.push(text);
    const trimmed = text.replace(/\n$/, '');
    const sp = trimmed.indexOf(' ');
    const key = sp < 0 ? trimmed : trimmed.slice(0, sp);
    const val = sp < 0 ? '' : trimmed.slice(sp + 1);
    if (!args.has(key)) args.set(key, []);
    args.get(key)!.push(val);
  }
  return { command, args, lines };
}

function sidebandChunk(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const data = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), data]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  }
  return Buffer.concat(parts);
}

function emptyPack(): Buffer { return writePack([]); }

function fetchResponseV2(repo: Repo, args: V2FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = plan.objects.length ? writePack(plan.objects) : emptyPack();
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(pktLine('ready\n'));
  parts.push(PKT_DELIM);
  if (args.depth !== undefined || plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandChunk(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function lsRefsResponseV2(repo: Repo, prefixes: string[]): Buffer {
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (head === undefined && keep('HEAD')) {
    parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  } else if (head !== undefined && keep('HEAD')) {
    parts.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    const peeled = peeledOid(repo, ref.oid);
    parts.push(pktLine(peeled ? `${ref.oid} ${ref.name} peeled:${peeled}\n` : `${ref.oid} ${ref.name}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(owner: string, repoName: string, body: Buffer, gitProtocol: string | undefined): GitResponse {
  const repo = getRepo(owner, repoName);
  if (!repo) return notFound();
  try {
    if (gitProtocol === 'version=2') {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        const prefixes = args.get('ref-prefix') ?? [];
        return { status: 200, contentType: UPLOAD_RESULT, body: lsRefsResponseV2(repo, prefixes) };
      }
      if (command === 'fetch') {
        const fetchArgs: V2FetchArgs = {
          wants: args.get('want') ?? [],
          haves: args.get('have') ?? [],
          shallow: args.get('shallow') ?? [],
          depth: args.get('deepen')?.[0] ? Number(args.get('deepen')![0]) : undefined,
          deepenNot: args.get('deepen-not') ?? [],
          filter: args.get('filter')?.[0],
        };
        for (const w of fetchArgs.wants) if (!isObjectId(w)) return badRequest('bad want oid');
        return { status: 200, contentType: UPLOAD_RESULT, body: fetchResponseV2(repo, fetchArgs) };
      }
      return badRequest(`unknown v2 command ${JSON.stringify(command)}`);
    }
    // v0 fetch
    return fetchResponseV0(repo, body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'malformed request');
  }
}

function fetchResponseV0(repo: Repo, body: Buffer): GitResponse {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let features = '';
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { section += 1; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5);
        const sp = rest.indexOf(' ');
        if (sp < 0) wants.push(rest);
        else { wants.push(rest.slice(0, sp)); features = rest.slice(sp + 1); }
      } else if (text.startsWith('shallow ')) shallow.push(text.slice(8));
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7));
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5));
    }
  }
  void features;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = plan.objects.length ? writePack(plan.objects) : emptyPack();
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(sidebandChunk(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack v0

interface PushCommand { oldOid: string; newOid: string; ref: string; }

export function receivePack(owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = getRepo(owner, repoName);
  if (!repo) return notFound();
  const report = (unpackOk: boolean, unpackDetail: string, refs: { ref: string; ok: boolean; reason: string }[]): Buffer => {
    const inner: (string | 'flush')[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const r of refs) inner.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
    const innerBuf = pktLines(inner as never);
    const band = Buffer.concat([Buffer.from([1]), innerBuf]);
    return Buffer.concat([pktLine(band), PKT_FLUSH]);
  };
  try {
    // Split the pkt-line command list (up to the first flush) from the raw pack.
    let off = 0;
    const commands: PushCommand[] = [];
    let packStart = body.length;
    while (off + 4 <= body.length) {
      const head = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line in command list');
      const len = Number.parseInt(head, 16);
      if (len === 0) { packStart = off + 4; break; }
      if (len < 4 || off + len > body.length) throw new Error('truncated command');
      const line = body.subarray(off + 4, off + len).toString('utf8');
      const nul = line.indexOf('\0');
      const text = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
      const parts = text.split(' ');
      if (parts.length !== 3) throw new Error('bad push command');
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      off += len;
    }
    if (commands.length === 0) throw new Error('no push commands');
    const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
    const packBytes = body.subarray(packStart);
    if (hasUpdates) {
      if (packBytes.length === 0) {
        return { status: 200, contentType: RECEIVE_RESULT, body: report(false, 'unpacker error', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' }))) };
      }
      let parsed;
      try {
        parsed = readPack(packBytes, (oid) => repo.objects.get(oid));
      } catch (err) {
        return { status: 200, contentType: RECEIVE_RESULT, body: report(false, 'unpacker error', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' }))) };
      }
      // Validate every new tip is present and is a commit/tag.
      for (const c of commands) {
        if (c.newOid === ZERO_OID) continue;
        const obj = parsed.objects.get(c.newOid) ?? repo.objects.get(c.newOid);
        if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
          return { status: 200, contentType: RECEIVE_RESULT, body: report(false, 'unpacker error', commands.map((x) => ({ ref: x.ref, ok: false, reason: 'unpacker error' }))) };
        }
      }
      for (const [oid, obj] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
      void hashObject;
    }
    const results: { ref: string; ok: boolean; reason: string }[] = [];
    for (const c of commands) {
      if (!fastForwardOk(repo, c.ref, c.oldOid, c.newOid)) {
        results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (c.newOid === ZERO_OID) repo.refs.delete(c.ref);
      else repo.refs.set(c.ref, c.newOid);
      results.push({ ref: c.ref, ok: true, reason: '' });
    }
    return { status: 200, contentType: RECEIVE_RESULT, body: report(true, 'ok', results) };
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'malformed push');
  }
}

export type { GitObject };
