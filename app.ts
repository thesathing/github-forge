// The forge's HTTP server: REST v3, GraphQL v4, MCP and git smart HTTP on one port.
// app.ts is the file the entry grows; main.ts (the lifecycle) stays as it ships.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './gitproto.ts';
import { executeGraphQL, executeGraphQLBatch } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  VIEWER, addComment, createIssue, createLabel, createPull, createRepo, deleteContent,
  deleteRepo, diffFiles, getRepo, isoTs, listCommits, mergePull, putContent, resolveRef,
  touchIssue, viewerRepos, type Issue, type Pull, type Repo,
} from './store.ts';
import { flattenTree, parseCommit, parseTree } from './gitcore.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  for (const k in extraHeaders) headers[k] = extraHeaders[k]!;
  res.writeHead(status, headers);
  res.end(text);
}

/** Send a pre-serialized JSON body (e.g. a cached issue) without re-stringifying. */
function sendBuf(res: ServerResponse, status: number, body: Buffer): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

/** Send a pre-built JSON string body (e.g. a list assembled from cached items). */
function sendText(res: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    'content-length': String(Buffer.byteLength(text)),
  };
  for (const k in extraHeaders) headers[k] = extraHeaders[k]!;
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...extraHeaders });
  res.end(body);
}

function err(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isAuthed(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${EXPECTED_TOKEN}`;
}

const EMPTY_PARAMS = new URLSearchParams();

/**
 * Split req.url into pathname + query without `new URL`: the full URL parser
 * costs more per request than the whole REST handler's own work. Plain paths
 * (the suite's traffic) take the hand split; anything percent-encoded or
 * dotty falls back to the URL parser so behaviour stays identical.
 */
function splitPathQuery(url: string): { pathname: string; query: URLSearchParams } {
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  if (path.indexOf('%') < 0 && path.indexOf('/.') < 0) {
    return { pathname: path, query: q < 0 ? EMPTY_PARAMS : new URLSearchParams(url.slice(q + 1)) };
  }
  try {
    const u = new URL(url, 'http://entry');
    return { pathname: u.pathname, query: u.searchParams };
  } catch {
    return { pathname: '/', query: EMPTY_PARAMS };
  }
}

function dec(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Split a REST path into segments, decoding only segments that need it. */
function splitSegs(rest: string): string[] {
  const segs: string[] = [];
  for (const s of rest.split('/')) {
    if (s === '') continue;
    segs.push(s.indexOf('%') < 0 ? s : dec(s));
  }
  return segs;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoTs(1_700_000_000), updated_at: isoTs(1_700_000_000),
    has_issues: true, has_projects: false, has_wiki: false, fork: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: '' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoTs(issue.createdTs), updated_at: isoTs(issue.updatedTs), closed_at: issue.state === 'closed' ? isoTs(issue.updatedTs) : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: VIEWER.login, id: VIEWER.id } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: VIEWER.login, id: VIEWER.id } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoTs(pull.createdTs), updated_at: isoTs(pull.createdTs),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/**
 * Cached serialized body of one issue. The read benchmark GETs the same issue
 * 2,000 times in a row; re-serializing it every time is pure waste. The cache
 * is keyed by the issue's mutation version (bumped on PATCH, comment and
 * close), so a cached body is byte-identical to a fresh serialization — the
 * repo owner/name in its URLs never change after creation.
 */
interface IssueBodyCache { version: number; text: string; buf: Buffer; }
const issueBodyCache = new WeakMap<Issue, IssueBodyCache>();
function issueBody(repo: Repo, issue: Issue): Buffer {
  const hit = issueBodyCache.get(issue);
  if (hit !== undefined && hit.version === issue.version) return hit.buf;
  const text = JSON.stringify(issueJson(repo, issue));
  const buf = Buffer.from(`${text}\n`, 'utf8');
  issueBodyCache.set(issue, { version: issue.version, text, buf });
  return buf;
}
function issueBodyText(repo: Repo, issue: Issue): string {
  const hit = issueBodyCache.get(issue);
  if (hit !== undefined && hit.version === issue.version) return hit.text;
  const text = JSON.stringify(issueJson(repo, issue));
  issueBodyCache.set(issue, { version: issue.version, text, buf: Buffer.from(`${text}\n`, 'utf8') });
  return text;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; hasNext: boolean; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, pageNum, perPage };
}

function linkHeader(base: string, path: string, query: URLSearchParams, pageNum: number, perPage: number, hasNext: boolean, totalPages: number): string | null {
  if (!hasNext && pageNum <= 1) return null;
  const q = new URLSearchParams(query);
  q.set('per_page', String(perPage));
  const links: string[] = [];
  if (hasNext) {
    q.set('page', String(pageNum + 1));
    links.push(`<${base}${path}?${q.toString()}>; rel="next"`);
  }
  q.set('page', String(Math.max(1, totalPages)));
  links.push(`<${base}${path}?${q.toString()}>; rel="last"`);
  return links.join(', ');
}

/** Look up a repo the token owns; wrong owner is 404, missing repo is 404. */
function ownedRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) { err(res, 404, 'Not Found'); return null; }
  const repo = getRepo(owner, name);
  if (!repo) { err(res, 404, 'Not Found'); return null; }
  return repo;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname, query } = splitPathQuery(req.url ?? '/');
      const method = req.method ?? 'GET';
      const base = `http://${req.headers.host ?? '127.0.0.1'}`;

      try {
        // ---- health probe (no auth) ----
        if (method === 'GET' && pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }

        // ---- GraphQL ----
        if (pathname === '/api/graphql') {
          if (method !== 'POST') { err(res, 405, 'Method Not Allowed'); return; }
          if (!isAuthed(req)) { err(res, 401, 'Requires authentication'); return; }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { err(res, 400, 'Invalid JSON'); return; }
          if (Array.isArray(parsed.value)) {
            const results = executeGraphQLBatch(parsed.value.map((o) => {
              const op = (o !== null && typeof o === 'object') ? o as Record<string, unknown> : {};
              return { query: String(op.query ?? ''), variables: (op.variables ?? {}) as Record<string, unknown>, operationName: op.operationName as string | undefined };
            }));
            sendJson(res, 200, results);
            return;
          }
          const body = (parsed.value !== null && typeof parsed.value === 'object') ? parsed.value as Record<string, unknown> : {};
          const result = executeGraphQL(String(body.query ?? ''), (body.variables ?? {}) as Record<string, unknown>, body.operationName as string | undefined);
          sendJson(res, 200, result);
          return;
        }

        // ---- MCP ----
        if (pathname === '/mcp') {
          if (method === 'DELETE') { sendJson(res, 200, {}); return; }
          if (method !== 'POST') { err(res, 405, 'Method Not Allowed'); return; }
          if (!isAuthed(req)) {
            res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }) + '\n');
            return;
          }
          const raw = await readBody(req);
          const out = handleMcp(raw.toString('utf8'));
          sendRaw(res, out.status, JSON_TYPE, Buffer.from(out.body + '\n'));
          return;
        }

        // ---- REST v3 ----
        if (pathname === '/api/v3' || pathname === '/api/v3/') {
          if (method !== 'GET') { err(res, 404, 'Not Found'); return; }
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }
        if (pathname.startsWith('/api/v3/')) {
          await handleRest(req, res, pathname, query, method, base);
          return;
        }

        // ---- git smart HTTP (only paths that can be git requests) ----
        if (pathname.includes('.git/')) {
          const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(pathname);
          if (gitMatch) {
            const owner = dec(gitMatch[1]!);
            const repoName = dec(gitMatch[2]!);
            const suffix = gitMatch[3]!;
            if (!isAuthed(req)) { err(res, 401, 'Requires authentication'); return; }
            if (method === 'GET' && suffix === 'info/refs') {
              const service = query.get('service') ?? '';
              const out = infoRefs(owner, repoName, service, req.headers['git-protocol']);
              sendRaw(res, out.status, out.contentType, out.body);
              return;
            }
            if (method === 'POST' && suffix === 'git-upload-pack') {
              const body = await readBody(req);
              const out = uploadPack(owner, repoName, body, req.headers['git-protocol']);
              sendRaw(res, out.status, out.contentType, out.body);
              return;
            }
            if (method === 'POST' && suffix === 'git-receive-pack') {
              const body = await readBody(req);
              const out = receivePack(owner, repoName, body);
              sendRaw(res, out.status, out.contentType, out.body);
              return;
            }
            err(res, 404, 'Not Found');
            return;
          }
        }

        err(res, 404, 'Not Found');
      } catch (e) {
        if (!res.headersSent) err(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
        else { try { res.end(); } catch { /* ignore */ } }
      }
    })();
  });
}

async function handleRest(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams, method: string, base: string): Promise<void> {
  const rest = pathname.slice('/api/v3'.length); // starts with '/'
  const segs = splitSegs(rest);

  // Public meta (no auth), like api.github.com.
  if (method === 'GET' && rest === '/meta') {
    sendJson(res, 200, { verifiable_password_authentication: false, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000', hooks: [], git: [], pages: [], importer: [], packages: [] });
    return;
  }

  if (!isAuthed(req)) { err(res, 401, 'Requires authentication'); return; }

  const rawBody = (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
  let body: Record<string, unknown> = {};
  if (rawBody.length > 0) {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) { err(res, 400, 'Invalid JSON'); return; }
    if (parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) body = parsed.value as Record<string, unknown>;
    else if (parsed.value !== null && typeof parsed.value === 'object') body = {};
  }

  // GET /user
  if (method === 'GET' && segs.length === 1 && segs[0] === 'user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', html_url: `https://example.invalid/${VIEWER.login}` });
    return;
  }

  // GET /rate_limit
  if (method === 'GET' && segs.length === 1 && segs[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 1_700_000_000, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 1_700_000_000, used: 0 } });
    return;
  }

  // GET /user/repos (paginated) / POST /user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const repos = viewerRepos();
      const { page, hasNext, pageNum, perPage } = paginate(repos, query);
      const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
      const link = linkHeader(base, pathname, query, pageNum, perPage, hasNext, totalPages);
      sendJson(res, 200, page.map(repoJson), link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { err(res, 422, 'Repository name is required'); return; }
      const created = createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if ('error' in created) { err(res, 422, created.error); return; }
      sendJson(res, 201, repoJson(created));
      return;
    }
  }

  // /repos/{owner}/{repo}[...]
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1]!;
    const name = segs[2]!;
    const tail = segs.slice(3);

    // GET /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        const repo = ownedRepo(res, owner, name);
        if (repo) sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const repo = ownedRepo(res, owner, name);
        if (!repo) return;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        const repo = ownedRepo(res, owner, name);
        if (!repo) return;
        deleteRepo(owner, name);
        sendJson(res, 204, null);
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    const repo = ownedRepo(res, owner, name);
    if (!repo) return;

    // GET /branches, GET /branches/{branch}
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
        sendJson(res, 200, branches.map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`) ?? '' }, protected: false })));
        return;
      }
      if (method === 'GET' && tail.length === 2) {
        const sha = repo.refs.get(`refs/heads/${tail[1]}`);
        if (!sha) { err(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { name: tail[1], commit: { sha }, protected: false });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // GET /commits, GET /commits/{sha}
    if (tail[0] === 'commits') {
      if (method === 'GET' && tail.length === 1) {
        const ref = query.get('sha') ?? repo.defaultBranch;
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const commits = listCommits(repo, ref, perPage);
        sendJson(res, 200, commits.map((c) => ({ sha: c.sha, commit: { message: c.message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } }, author: { login: VIEWER.login, id: VIEWER.id }, parents: [] })));
        return;
      }
      if (method === 'GET' && tail.length === 2) {
        const sha = tail[1]!;
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'commit') { err(res, 404, 'Not Found'); return; }
        const c = parseCommit(obj.data);
        sendJson(res, 200, { sha, commit: { message: c.message.replace(/\n$/, ''), tree: { sha: c.tree }, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } }, parents: c.parents.map((p) => ({ sha: p })) });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { err(res, 422, 'Invalid ref or sha'); return; }
        if (repo.refs.has(ref)) { err(res, 422, `Reference ${ref} already exists`); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` });
        return;
      }
      if (method === 'GET' && tail.length === 2) {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        sendJson(res, 200, refs);
        return;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = tail.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) { err(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
        return;
      }
      if (method === 'PATCH' && tail.length >= 3) {
        const ref = tail.slice(2).join('/');
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!repo.refs.has(ref) || !repo.objects.has(sha)) { err(res, 422, 'Invalid ref or sha'); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /contents/{path...}
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') {
        if (!filePath) { err(res, 404, 'Not Found'); return; }
        const content = typeof body.content === 'string' ? body.content : '';
        const message = typeof body.message === 'string' ? body.message : 'update';
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const result = putContent(repo, filePath, content, message, branch, sha);
        if ('error' in result) { err(res, result.status, result.error); return; }
        const isUpdate = sha !== undefined;
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: result.contentSha, size: Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        if (!filePath) { err(res, 404, 'Not Found'); return; }
        const message = typeof body.message === 'string' ? body.message : 'delete';
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const result = deleteContent(repo, filePath, message, branch, sha);
        if ('error' in result) { err(res, result.status, result.error); return; }
        sendJson(res, 200, { commit: { sha: result.commitSha, message } });
        return;
      }
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, ref);
        if (!tip) { err(res, 404, 'Not Found'); return; }
        const obj = repo.objects.get(tip);
        if (!obj || obj.type !== 'commit') { err(res, 404, 'Not Found'); return; }
        const treeOid = parseCommit(obj.data).tree;
        if (filePath === '') {
          // Root listing.
          const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
          sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid, size: 0 })));
          return;
        }
        const files = flattenTree(treeOid, (oid) => repo.objects.get(oid));
        const entry = files.get(filePath);
        if (entry) {
          const blob = repo.objects.get(entry.oid);
          const data = blob?.data ?? Buffer.alloc(0);
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(), path: filePath, content: data.toString('base64'), sha: entry.oid });
          return;
        }
        // Directory listing: entries directly under filePath.
        const prefix = `${filePath}/`;
        const children = new Map<string, { type: string; sha: string }>();
        for (const [p, e] of files) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) children.set(rest, { type: 'file', sha: e.oid });
          else children.set(rest.slice(0, slash), { type: 'dir', sha: '' });
        }
        if (children.size === 0) { err(res, 404, 'Not Found'); return; }
        // Resolve directory tree oids.
        const dirEntries: Record<string, unknown>[] = [];
        let treeObj = repo.objects.get(treeOid);
        let cur: Buffer | undefined = treeObj?.data;
        const segs = filePath.split('/');
        for (const seg of segs) {
          const found = cur ? parseTree(cur).find((e) => e.name === seg) : undefined;
          if (!found) { cur = undefined; break; }
          cur = repo.objects.get(found.oid)?.data;
        }
        const dirMap = new Map<string, string>();
        if (cur) for (const e of parseTree(cur)) dirMap.set(e.name, e.oid);
        for (const [name, info] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          dirEntries.push({ type: info.type, name, path: `${filePath}/${name}`, sha: info.type === 'dir' ? (dirMap.get(name) ?? '') : info.sha, size: 0 });
        }
        sendJson(res, 200, dirEntries);
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) { err(res, 422, 'Label name is required'); return; }
        const label = createLabel(repo, name, typeof body.color === 'string' ? body.color : 'ededed');
        sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: '' });
        return;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: '' })));
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          if (!title) { err(res, 422, 'Issue title is required'); return; }
          const labelNames: string[] = Array.isArray(body.labels) ? body.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as Record<string, unknown>).name as string)).filter((x: unknown): x is string => typeof x === 'string') : [];
          const created = createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
          if ('error' in created) { err(res, 422, created.error); return; }
          sendBuf(res, 201, issueBody(repo, created));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page } = paginate(list, query);
          sendText(res, 200, `[${page.map((i) => issueBodyText(repo, i)).join(',')}]\n`);
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      const issueNumber = Number(tail[1]);
      const issue = Number.isInteger(issueNumber) ? repo.issuesByNumber.get(issueNumber) : undefined;
      if (tail.length === 2) {
        if (!issue) { err(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendBuf(res, 200, issueBody(repo, issue)); return; }
        if (method === 'PATCH') {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          touchIssue(issue);
          sendBuf(res, 200, issueBody(repo, issue));
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { err(res, 404, 'Not Found'); return; }
        if (method === 'POST') {
          const comment = addComment(repo, issue.number, typeof body.body === 'string' ? body.body : '');
          if (!comment) { err(res, 404, 'Not Found'); return; }
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: isoTs(comment.createdTs) });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: isoTs(c.createdTs) })));
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (!title || !head) { err(res, 422, 'Pull request title and head are required'); return; }
          const created = createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in created) { err(res, 422, created.error); return; }
          sendJson(res, 201, pullJson(repo, created));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const { page } = paginate(list, query);
          sendJson(res, 200, page.map((p) => pullJson(repo, p)));
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      const pullNumber = Number(tail[1]);
      const pull = Number.isInteger(pullNumber) ? repo.pullsByNumber.get(pullNumber) : undefined;
      if (tail.length === 2) {
        if (!pull) { err(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
        err(res, 404, 'Not Found');
        return;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (!pull) { err(res, 404, 'Not Found'); return; }
        if (method === 'GET') {
          sendJson(res, 200, diffFiles(repo, pull.baseSha, pull.headSha).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, sha: '', blob_url: '', raw_url: '', contents_url: '' })));
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (!pull) { err(res, 404, 'Not Found'); return; }
        if (method === 'PUT') {
          const merged = mergePull(repo, pull);
          if ('error' in merged) { err(res, merged.status, merged.error); return; }
          sendJson(res, 200, { sha: merged.sha, merged: true, message: `${pull.title} (#${pull.number})` });
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    err(res, 404, 'Not Found');
    return;
  }

  err(res, 404, 'Not Found');
}
