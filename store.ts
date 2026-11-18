// The forge's in-memory store and domain operations shared by REST, GraphQL and MCP.
// Deterministic: commit timestamps come from a fixed-epoch counter, never the wall clock,
// so two runs fed the same requests produce the same object ids.

import {
  ZERO_OID, buildCommit, buildTreeFromFiles, closure, flattenTree, hashObject, isAncestor,
  isObjectId, parseCommit, parseTree, reachable, type GitObject, type GitObjectType,
} from './gitcore.ts';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

/** Fixed epoch + a counter: every timestamp this forge mints, in order. */
let tickCounter = 1_700_000_000;
export function nextTs(): number { return tickCounter++; }
export function isoTs(ts: number): string { return new Date(ts * 1000).toISOString(); }
function identity(): string { return `${VIEWER.name} <${VIEWER.email}>`; }

export interface Label { readonly id: number; name: string; color: string; }
export interface Issue {
  readonly id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; seq: number;
  createdTs: number; updatedTs: number;
  comments: { id: number; body: string; createdTs: number }[];
}
export interface Pull {
  readonly id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string; seq: number; createdTs: number;
}
export interface Repo {
  readonly id: number; owner: string; name: string;
  description: string; private: boolean; defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[]; issuesByNumber: Map<number, Issue>;
  pulls: Pull[]; pullsByNumber: Map<number, Pull>;
  nextIssue: number; nextPull: number; nextCommentId: number; nextLabelId: number;
  seq: number;
}

const reposByKey = new Map<string, Repo>();
const reposList: Repo[] = [];
let repoSeq = 0;
let issueSeq = 0;
let commentSeq = 0;
let repoCounter = 0;

export function keyOf(owner: string, name: string): string { return `${owner}/${name}`; }
export function getRepo(owner: string, name: string): Repo | undefined { return reposByKey.get(keyOf(owner, name)); }
export function allRepos(): readonly Repo[] { return reposList; }
export function viewerRepos(): readonly Repo[] { return reposList.filter((r) => r.owner === VIEWER.login); }

export function createRepo(name: string, description = '', isPrivate = false): Repo | { error: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return { error: `Invalid repository name ${JSON.stringify(name)}` };
  const key = keyOf(VIEWER.login, name);
  if (reposByKey.has(key)) return { error: `Repository ${VIEWER.login}/${name} already exists` };
  const repo: Repo = {
    id: ++repoCounter, owner: VIEWER.login, name, description, private: isPrivate, defaultBranch: 'main',
    objects: new Map(), refs: new Map(), labels: new Map(),
    issues: [], issuesByNumber: new Map(), pulls: [], pullsByNumber: new Map(),
    nextIssue: 1, nextPull: 1, nextCommentId: 1, nextLabelId: 1, seq: ++repoSeq,
  };
  reposByKey.set(key, repo);
  reposList.push(repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  const key = keyOf(owner, name);
  const repo = reposByKey.get(key);
  if (!repo) return false;
  reposByKey.delete(key);
  const i = reposList.indexOf(repo);
  if (i >= 0) reposList.splice(i, 1);
  return true;
}

// ---------------------------------------------------------------- git objects

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
export function lookup(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}
export function refTip(repo: Repo, ref: string): string | undefined { return repo.refs.get(ref); }
export function headRefName(repo: Repo): string { return `refs/heads/${repo.defaultBranch}`; }

/** Create a commit object on `branch` (creating the branch when missing). Returns the commit oid. */
export function commitOnBranch(repo: Repo, branch: string, files: ReadonlyMap<string, { oid: string; mode: string }>, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const tree = buildTreeFromFiles(files, (t, d) => putObject(repo, t, d));
  const ts = nextTs();
  const who = `${identity()} ${ts} +0000`;
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const data = buildCommit(tree, parent ? [parent] : [], who, who, msg);
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  return oid;
}

/** The file map of a ref's tip tree (empty when the ref is unborn). */
export function filesAt(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(ref);
  if (!tip) return new Map();
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(parseCommit(obj.data).tree, lookup(repo));
}

/** Resolve a ref name / branch name / oid to a commit oid. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
}

// ---------------------------------------------------------------- contents

export interface ContentResult { commitSha: string; contentSha: string; }

/** Write one file through the contents API. Creates the branch from the default tip when missing. */
export function putContent(
  repo: Repo, path: string, contentBase64: string, message: string, branch?: string, sha?: string,
): ContentResult | { error: string; status: number } {
  const branchName = branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branchName}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined && branch !== undefined && branch !== repo.defaultBranch) {
    // Creating a branch through a contents write: start from the default branch tip.
    const baseTip = repo.refs.get(headRefName(repo));
    if (baseTip !== undefined) { repo.refs.set(ref, baseTip); tip = baseTip; }
  }
  const files = tip !== undefined ? filesAt(repo, ref) : new Map<string, { oid: string; mode: string }>();
  const content = Buffer.from(contentBase64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = putObject(repo, 'blob', content);
  const existing = files.get(path);
  if (existing) {
    if (sha === undefined) return { error: 'sha is required to update a file', status: 422 };
    if (sha.toLowerCase() !== existing.oid.toLowerCase()) return { error: 'sha does not match the current file', status: 409 };
  }
  files.set(path, { oid: blobOid, mode: '100644' });
  const commitSha = commitOnBranch(repo, branchName, files, message);
  return { commitSha, contentSha: blobOid };
}

/** Delete one file through the contents API. */
export function deleteContent(repo: Repo, path: string, message: string, branch?: string, sha?: string): { commitSha: string } | { error: string; status: number } {
  const branchName = branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branchName}`;
  const tip = repo.refs.get(ref);
  if (!tip) return { error: 'Not Found', status: 404 };
  const files = filesAt(repo, ref);
  const existing = files.get(path);
  if (!existing) return { error: 'Not Found', status: 404 };
  if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return { error: 'sha does not match the current file', status: 409 };
  files.delete(path);
  const commitSha = commitOnBranch(repo, branchName, files, message);
  return { commitSha };
}

// ---------------------------------------------------------------- issues / labels / comments

export function createLabel(repo: Repo, name: string, color = 'ededed'): Label {
  const existing = repo.labels.get(name);
  if (existing) return existing;
  const label: Label = { id: repo.nextLabelId++, name, color };
  repo.labels.set(name, label);
  return label;
}

export function createIssue(repo: Repo, title: string, body = '', labelNames: readonly string[] = []): Issue | { error: string } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (!label) return { error: `Label ${JSON.stringify(name)} does not exist` };
    labels.push(label);
  }
  const ts = nextTs();
  const issue: Issue = {
    id: ++issueSeq, number: repo.nextIssue++, title, body, state: 'open', labels,
    seq: repo.nextIssue, createdTs: ts, updatedTs: ts, comments: [],
  };
  repo.issues.push(issue);
  repo.issuesByNumber.set(issue.number, issue);
  return issue;
}

export function addComment(repo: Repo, issueNumber: number, body: string): { id: number; body: string } | undefined {
  const issue = repo.issuesByNumber.get(issueNumber);
  if (!issue) return undefined;
  const comment = { id: ++commentSeq, body, createdTs: nextTs() };
  issue.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------- pull requests

export function createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headRef = head.includes(':') ? head.split(':').pop()! : head;
  const baseRef = base.includes(':') ? base.split(':').pop()! : base;
  const headSha = resolveRef(repo, headRef);
  if (!headSha) return { error: `Head branch ${JSON.stringify(headRef)} does not exist` };
  const baseSha = resolveRef(repo, baseRef) ?? resolveRef(repo, repo.defaultBranch);
  if (!baseSha) return { error: `Base branch ${JSON.stringify(baseRef)} does not exist` };
  const ts = nextTs();
  const pull: Pull = {
    id: ++issueSeq, number: repo.nextPull++, title, body, state: 'open', merged: false,
    mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, seq: repo.nextPull, createdTs: ts,
  };
  repo.pulls.push(pull);
  repo.pullsByNumber.set(pull.number, pull);
  return pull;
}

/** Three-way merge check: does merging `pull` conflict with the current base tip? */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseFiles = flattenTreeOfCommit(repo, pull.baseSha);
  const headFiles = flattenTreeOfCommit(repo, pull.headSha);
  const curTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!curTip) return false;
  const curFiles = flattenTreeOfCommit(repo, curTip);
  if (baseFiles === null || headFiles === null || curFiles === null) return false;
  const paths = new Set([...headFiles.keys(), ...curFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid;
    const h = headFiles.get(path)?.oid;
    const c = curFiles.get(path)?.oid;
    const headChanged = h !== b;
    const curChanged = c !== b;
    if (headChanged && curChanged && h !== c) return true;
  }
  return false;
}

function flattenTreeOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return flattenTree(parseCommit(obj.data).tree, lookup(repo));
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid or an error. */
export function mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
  if (pull.merged) return { error: 'Pull request already merged', status: 405 };
  if (pull.state !== 'open') return { error: 'Pull request is closed', status: 405 };
  if (pullConflicts(repo, pull)) return { error: 'Merge conflict', status: 405 };
  const baseFiles = flattenTreeOfCommit(repo, pull.baseSha) ?? new Map();
  const headFiles = flattenTreeOfCommit(repo, pull.headSha) ?? new Map();
  const curTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const curFiles = curTip ? flattenTreeOfCommit(repo, curTip) ?? new Map() : new Map();
  // Apply the head's changes (vs its base) onto the current base tree.
  const merged = new Map(curFiles);
  for (const [path, entry] of headFiles) {
    if (baseFiles.get(path)?.oid !== entry.oid) merged.set(path, entry);
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path) && baseFiles.get(path)?.oid !== curFiles.get(path)?.oid) {
      // Deleted on head; keep the current version only when the base side also changed it.
      if (curFiles.get(path)?.oid === baseFiles.get(path)?.oid) merged.delete(path);
    }
  }
  const tree = buildTreeFromFiles(merged, (t, d) => putObject(repo, t, d));
  const ts = nextTs();
  const who = `${identity()} ${ts} +0000`;
  const message = `${pull.title} (#${pull.number})\n`;
  const parents = curTip ? [curTip] : [];
  const data = buildCommit(tree, parents, who, who, message);
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoTs(ts);
  pull.mergeCommitSha = sha;
  return { sha };
}

/** Diff between two commits' trees: filename, status, line counts. */
export function diffFiles(repo: Repo, baseSha: string, headSha: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseFiles = flattenTreeOfCommit(repo, baseSha) ?? new Map();
  const headFiles = flattenTreeOfCommit(repo, headSha) ?? new Map();
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const countLines = (oid: string | undefined): number => {
    if (!oid) return 0;
    const obj = repo.objects.get(oid);
    if (!obj) return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (!b && h) {
      const additions = countLines(h.oid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const deletions = countLines(b.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h && b.oid !== h.oid) {
      const additions = countLines(h.oid);
      const deletions = countLines(b.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Commits reachable from `ref`, newest first (walk order), capped. */
export function listCommits(repo: Repo, ref: string, limit = 30): { sha: string; message: string }[] {
  const tip = resolveRef(repo, ref);
  if (!tip) return [];
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message.replace(/\n$/, '') });
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      // tags in history are not expected here
    }
  }
  return out;
}

// ---------------------------------------------------------------- git fetch planning

export interface FetchPlan { objects: GitObject[]; shallow: string[]; unshallow: string[]; }

/**
 * Plan a fetch: objects to send for `wants` (with optional shallow depth), minus what the
 * client already holds (`haves`, with the client's shallow boundaries).
 */
export function planFetch(repo: Repo, wants: readonly string[], haves: readonly string[], shallowBoundaries: readonly string[], depth?: number): FetchPlan {
  const lookupFn = lookup(repo);
  const maxDepth = depth === undefined ? Infinity : depth;
  const wanted = reachable(wants, lookupFn, maxDepth);
  // What the client already holds: full closure of haves, except when the client is shallow —
  // then it holds only the boundary commits' own trees/blobs (depth 1).
  const held = new Set<string>();
  if (haves.length) {
    if (shallowBoundaries.length) {
      for (const h of haves) {
        const r = reachable([h], lookupFn, 1);
        for (const oid of r.objects) held.add(oid);
      }
    } else {
      for (const oid of closure(haves, lookupFn)) held.add(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wanted.objects) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // Unshallow: an old boundary whose parents are now included in the walk.
  const unshallow: string[] = [];
  if (depth !== undefined && shallowBoundaries.length) {
    for (const b of shallowBoundaries) {
      if (!wanted.objects.has(b)) continue;
      const obj = repo.objects.get(b);
      if (obj?.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        if (parents.length && parents.every((p) => wanted.objects.has(p))) unshallow.push(b);
      }
    }
  }
  return { objects, shallow: wanted.shallow, unshallow };
}

/** Is `newOid` a fast-forward from the ref's current tip (or a create/delete)? */
export function fastForwardOk(repo: Repo, ref: string, oldOid: string, newOid: string): boolean {
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) return current !== undefined && (oldOid === ZERO_OID || oldOid === current);
  if (current === undefined) return oldOid === ZERO_OID;
  if (oldOid !== current) return false;
  if (oldOid === ZERO_OID) return false;
  return isAncestor(oldOid, newOid, lookup(repo));
}

export { ZERO_OID, parseTree };
