// GraphQL v4 executor for the exact documents gh / github-mcp-server send.
// A small recursive-descent parser for the query language subset in use, plus
// resolvers over the store. Unknown fields become GraphQL errors naming the field.

import {
  VIEWER, createIssue, createPull, diffFiles, getRepo, isoTs, mergePull, addComment,
  pullConflicts, resolveRef, type Issue, type Pull, type Repo,
} from './store.ts';
import { parseCommit, parseTree } from './gitcore.ts';

// ---------------------------------------------------------------- global ids

export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}
export function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const i = text.indexOf(':');
    if (i <= 0) return null;
    return { kind: text.slice(0, i), key: text.slice(i + 1) };
  } catch { return null; }
}
function repoGid(r: Repo): string { return gid('R', `${r.owner}/${r.name}`); }
function issueGid(r: Repo, i: Issue): string { return gid('I', `${r.owner}/${r.name}#${i.number}`); }
function pullGid(r: Repo, p: Pull): string { return gid('P', `${r.owner}/${r.name}#${p.number}`); }
function commentGid(r: Repo, issueNumber: number, commentId: number): string { return gid('C', `${r.owner}/${r.name}#${issueNumber}:${commentId}`); }

function repoFromGid(id: string): Repo | undefined {
  const d = ungid(id);
  if (!d || d.kind !== 'R') return undefined;
  const [owner, name] = d.key.split('/');
  if (!owner || !name) return undefined;
  return getRepo(owner, name);
}
function issueFromGid(id: string): { repo: Repo; issue: Issue } | undefined {
  const d = ungid(id);
  if (!d || d.kind !== 'I') return undefined;
  const [full, num] = d.key.split('#');
  const [owner, name] = (full ?? '').split('/');
  if (!owner || !name || !num) return undefined;
  const repo = getRepo(owner, name);
  const issue = repo?.issuesByNumber.get(Number(num));
  return repo && issue ? { repo, issue } : undefined;
}
function pullFromGid(id: string): { repo: Repo; pull: Pull } | undefined {
  const d = ungid(id);
  if (!d || d.kind !== 'P') return undefined;
  const [full, num] = d.key.split('#');
  const [owner, name] = (full ?? '').split('/');
  if (!owner || !name || !num) return undefined;
  const repo = getRepo(owner, name);
  const pull = repo?.pullsByNumber.get(Number(num));
  return repo && pull ? { repo, pull } : undefined;
}

// ---------------------------------------------------------------- parser

type Value = string | number | boolean | null | Value[] | { [k: string]: Value };
interface FieldNode {
  alias: string; name: string; args: Record<string, Value>; children: FieldNode[] | null;
  fragmentType?: string; isFragment?: boolean;
}
interface Operation { kind: 'query' | 'mutation'; name?: string; variables: Record<string, { type: string; default?: Value }>; selections: FieldNode[]; }

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c) || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}():[]!=$@'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j += 1; }
      }
      tokens.push(JSON.stringify(out)); i = j + 1; continue;
    }
    if (/[A-Za-z_0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z_0-9-]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j)); i = j; continue;
    }
    i += 1; // skip anything else
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  private readonly fragments: Map<string, FieldNode[]>;
  constructor(tokens: string[], fragments: Map<string, FieldNode[]>) {
    this.tokens = tokens;
    this.fragments = fragments;
  }
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string { return this.tokens[this.pos++]!; }
  expect(t: string): void { const got = this.next(); if (got !== t) throw new Error(`expected ${t}, got ${got}`); }

  parseValue(): Value {
    const t = this.next();
    if (t === '$') return { __var: this.next() } as unknown as Value;
    if (t === '[') {
      const arr: Value[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (t === '{') {
      const obj: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const k = this.next();
        this.expect(':');
        obj[k] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t; // enum
  }

  parseSelections(): FieldNode[] {
    this.expect('{');
    const out: FieldNode[] = [];
    while (this.peek() !== '}') {
      out.push(this.parseField());
    }
    this.expect('}');
    return out;
  }

  parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeName = this.next();
        const children = this.parseSelections();
        return { alias: '', name: '', args: {}, children, fragmentType: typeName, isFragment: true };
      }
      const fragName = this.next();
      const children = this.fragments.get(fragName) ?? [];
      return { alias: '', name: '', args: {}, children, isFragment: true };
    }
    let name = this.next();
    let alias = name;
    if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
    const args: Record<string, Value> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const k = this.next();
        this.expect(':');
        args[k] = this.parseValue();
      }
      this.expect(')');
    }
    while (this.peek() === '@') { // skip directives
      this.next(); this.next();
      if (this.peek() === '(') { let depth = 0; do { const t = this.next(); if (t === '(') depth += 1; if (t === ')') depth -= 1; } while (depth > 0); }
    }
    let children: FieldNode[] | null = null;
    if (this.peek() === '{') children = this.parseSelections();
    return { alias, name, args, children };
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const t = this.peek();
    if (t === 'query' || t === 'mutation') { kind = this.next() as 'query' | 'mutation'; if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') name = this.next(); }
    const variables: Record<string, { type: string; default?: Value }> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const vname = this.next();
        this.expect(':');
        const parts: string[] = [];
        while (this.peek() !== ')' && this.peek() !== '=' && this.peek() !== '$') parts.push(this.next());
        let def: Value | undefined;
        if (this.peek() === '=') { this.next(); def = this.parseValue(); }
        variables[vname] = { type: parts.join(''), default: def };
      }
      this.expect(')');
    }
    const selections = this.parseSelections();
    return { kind, name, variables, selections };
  }
}

function parseDocument(src: string): { operations: Operation[]; fragments: Map<string, FieldNode[]> } {
  const tokens = tokenize(src);
  const fragments = new Map<string, FieldNode[]>();
  const operations: Operation[] = [];
  // First pass: collect fragment definitions (they may appear before/after operations).
  const parser = new Parser(tokens, fragments);
  while (parser.peek() !== undefined) {
    if (parser.peek() === 'fragment') {
      parser.next();
      const name = parser.next();
      parser.expect('on');
      parser.next(); // type name
      const sels = parser.parseSelections();
      fragments.set(name, sels);
    } else {
      operations.push(parser.parseOperation());
    }
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- schema (introspection)

interface TypeInfo { fields?: string[]; enumValues?: string[]; kind: 'OBJECT' | 'ENUM' | 'SCALAR'; }
const SCHEMA: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'url', 'isPrivate'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'repository'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'mergedAt', 'mergeCommitSha', 'author', 'url'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  Viewer: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'target'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues', 'description'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'description'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type'] },
};

function typeInfo(name: string): TypeInfo | undefined { return SCHEMA[name]; }

// ---------------------------------------------------------------- execution

interface Ctx { type: string; value: unknown; repo?: Repo; }
interface ExecState { errors: { message: string }[]; variables: Record<string, unknown>; }

function resolveVars(value: Value, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && '__var' in (value as Record<string, unknown>)) {
    return variables[(value as unknown as { __var: string }).__var];
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, variables));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVars(v, variables);
    return out;
  }
  return value;
}

function argValue(field: FieldNode, name: string, state: ExecState): unknown {
  const raw = field.args[name];
  if (raw === undefined) return undefined;
  return resolveVars(raw, state.variables);
}

function cursorFor(n: number): string { return Buffer.from(`cursor:${n}`, 'utf8').toString('base64'); }
function numberFromCursor(c: string | undefined): number | undefined {
  if (!c) return undefined;
  try {
    const text = Buffer.from(c, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : undefined;
  } catch { return undefined; }
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __type: 'Issue', __repo: repo, __issue: issue };
}
function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __type: 'PullRequest', __repo: repo, __pull: pull };
}

function fieldTypeName(ctx: Ctx, fieldName: string): string {
  // The GraphQL type of a field's value, for nested resolution.
  const t = ctx.type;
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
    Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    Issue: { author: 'User', comments: 'IssueConnection' },
    PullRequest: { files: 'PullRequestChangedFileConnection', headRef: 'Ref', baseRef: 'Ref', author: 'User' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
    __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
  };
  return map[t]?.[fieldName] ?? 'Scalar';
}

function executeSelections(ctx: Ctx, selections: FieldNode[], state: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.isFragment) {
      if (field.fragmentType && !matchesType(ctx, field.fragmentType)) continue;
      Object.assign(out, executeSelections(ctx, field.children ?? [], state));
      continue;
    }
    if (field.name === '__typename') { out[field.alias] = ctx.type === 'Node' ? (ctx.value as Record<string, unknown>).__type ?? 'Repository' : ctx.type; continue; }
    const allowed = typeInfo(ctx.type)?.fields ?? [];
    // Node interface: resolve by the wrapped type.
    const effectiveType = ctx.type === 'Node' ? String((ctx.value as Record<string, unknown>).__type ?? 'Repository') : ctx.type;
    const allowedEff = typeInfo(effectiveType)?.fields ?? [];
    if (!allowed.includes(field.name) && !allowedEff.includes(field.name) && field.name !== '__type' && field.name !== '__schema') {
      state.errors.push({ message: `Cannot query field "${field.name}" on type "${effectiveType}".` });
      out[field.alias] = null;
      continue;
    }
    const value = resolveField({ type: effectiveType, value: ctx.value, repo: ctx.repo }, field, state);
    if (field.children && value !== null && value !== undefined) {
      const childType = fieldTypeName({ type: effectiveType, value: ctx.value }, field.name);
      if (Array.isArray(value)) {
        out[field.alias] = value.map((item) => {
          if (item !== null && typeof item === 'object') return executeSelections({ type: childType, value: item, repo: ctx.repo }, field.children!, state);
          return item;
        });
      } else if (typeof value === 'object') {
        out[field.alias] = executeSelections({ type: childType, value, repo: ctx.repo }, field.children, state);
      } else out[field.alias] = value;
    } else {
      out[field.alias] = value === undefined ? null : value;
    }
  }
  return out;
}

function matchesType(ctx: Ctx, typeName: string): boolean {
  if (ctx.type === 'Node') return String((ctx.value as Record<string, unknown>).__type ?? '') === typeName;
  return ctx.type === typeName;
}

function resolveField(ctx: Ctx, field: FieldNode, state: ExecState): unknown {
  const v = ctx.value as Record<string, unknown>;
  switch (ctx.type) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'User', login: VIEWER.login, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email };
      if (field.name === 'repository') {
        const owner = String(argValue(field, 'owner', state) ?? '');
        const name = String(argValue(field, 'name', state) ?? '');
        const repo = getRepo(owner, name);
        if (!repo) return null;
        return { __type: 'Repository', __repo: repo };
      }
      if (field.name === 'node') {
        const id = String(argValue(field, 'id', state) ?? '');
        const repo = repoFromGid(id);
        if (repo) return { __type: 'Repository', __repo: repo };
        const issue = issueFromGid(id);
        if (issue) return issueNode(issue.repo, issue.issue);
        const pull = pullFromGid(id);
        if (pull) return pullNode(pull.repo, pull.pull);
        return null;
      }
      if (field.name === '__type') {
        const name = String(argValue(field, 'name', state) ?? '');
        const info = typeInfo(name);
        if (!info) return null;
        return { __type: '__Type', __typeName: name, __info: info };
      }
      if (field.name === '__schema') return { __type: '__Schema' };
      return null;
    }
    case 'User': case 'Viewer': {
      if (field.name === 'login') return v.login ?? VIEWER.login;
      if (field.name === 'id') return v.id ?? String(VIEWER.id);
      if (field.name === 'name') return v.name ?? VIEWER.name;
      if (field.name === 'email') return v.email ?? VIEWER.email;
      if (field.name === 'url') return `https://example.invalid/${v.login ?? VIEWER.login}`;
      return null;
    }
    case 'Repository': {
      const repo = v.__repo as Repo;
      switch (field.name) {
        case 'id': return repoGid(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', login: repo.owner, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email };
        case 'defaultBranchRef': return { __type: 'Ref', name: repo.defaultBranch };
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': case 'isPrivate': return repo.private;
        case 'createdAt': return isoTs(1_700_000_000);
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
        case 'issue': {
          const number = Number(argValue(field, 'number', state));
          const issue = repo.issuesByNumber.get(number);
          return issue ? issueNode(repo, issue) : null;
        }
        case 'issues': {
          const first = Number(argValue(field, 'first', state) ?? 100);
          const after = argValue(field, 'after', state) as string | undefined;
          const states = (argValue(field, 'states', state) as string[] | undefined) ?? undefined;
          const orderBy = argValue(field, 'orderBy', state) as { field?: string; direction?: string } | undefined;
          let list = [...repo.issues];
          if (states) {
            const wanted = new Set(states.map((s) => String(s).toLowerCase()));
            list = list.filter((i) => wanted.has(i.state));
          }
          const dir = orderBy?.direction === 'ASC' ? 1 : -1;
          list.sort((a, b) => dir * (a.number - b.number));
          const afterNum = numberFromCursor(after);
          if (afterNum !== undefined) list = list.filter((i) => dir > 0 ? i.number > afterNum : i.number < afterNum);
          const page = list.slice(0, first);
          const hasNext = list.length > first;
          const endCursor = page.length ? cursorFor(page[page.length - 1]!.number) : null;
          return { __type: 'IssueConnection', __nodes: page.map((i) => issueNode(repo, i)), __hasNext: hasNext, __endCursor: endCursor };
        }
        case 'pullRequests': {
          const first = Number(argValue(field, 'first', state) ?? 100);
          const after = argValue(field, 'after', state) as string | undefined;
          const states = (argValue(field, 'states', state) as string[] | undefined) ?? undefined;
          let list = [...repo.pulls];
          if (states) {
            const wanted = new Set(states.map((s) => String(s)));
            list = list.filter((p) => wanted.has(p.state === 'closed' && p.merged ? 'MERGED' : p.state.toUpperCase()));
          } else {
            list = list.filter((p) => p.state === 'open');
          }
          const afterNum = numberFromCursor(after);
          if (afterNum !== undefined) list = list.filter((p) => p.number > afterNum);
          const page = list.slice(0, first);
          return { __type: 'PullRequestConnection', __nodes: page.map((p) => pullNode(repo, p)), __hasNext: list.length > first, __endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null };
        }
        case 'pullRequest': {
          const number = Number(argValue(field, 'number', state));
          const pull = repo.pullsByNumber.get(number);
          return pull ? pullNode(repo, pull) : null;
        }
        default: return null;
      }
    }
    case 'Issue': {
      const repo = v.__repo as Repo;
      const issue = v.__issue as Issue;
      switch (field.name) {
        case 'id': return issueGid(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return { __type: 'User', login: VIEWER.login, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email };
        case 'createdAt': return isoTs(issue.createdTs);
        case 'updatedAt': return isoTs(issue.updatedTs);
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'repository': return { __type: 'Repository', __repo: repo };
        case 'labels': return issue.labels.map((l) => ({ name: l.name, color: l.color }));
        case 'comments': return { __type: 'IssueConnection', __nodes: issue.comments.map((c) => ({ __type: 'IssueComment', id: commentGid(repo, issue.number, c.id), body: c.body })), __hasNext: false, __endCursor: null };
        default: return null;
      }
    }
    case 'PullRequest': {
      const repo = v.__repo as Repo;
      const pull = v.__pull as Pull;
      switch (field.name) {
        case 'id': return pullGid(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { __type: 'Ref', name: pull.headRef };
        case 'baseRef': return { __type: 'Ref', name: pull.baseRef };
        case 'createdAt': return isoTs(pull.createdTs);
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommitSha': return pull.mergeCommitSha;
        case 'author': return { __type: 'User', login: VIEWER.login, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email };
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'files': {
          const first = Number(argValue(field, 'first', state) ?? 100);
          const files = diffFiles(repo, pull.baseSha, pull.headSha).slice(0, first);
          return { __type: 'PullRequestChangedFileConnection', __nodes: files.map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status })), __hasNext: false, __endCursor: null };
        }
        default: return null;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return v.name ?? '';
      if (field.name === 'id') return gid('Ref', String(v.name ?? ''));
      if (field.name === 'target') return null;
      return null;
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return (v.__nodes as unknown[]) ?? [];
      if (field.name === 'edges') return ((v.__nodes as unknown[]) ?? []).map((n) => ({ node: n, cursor: '' }));
      if (field.name === 'pageInfo') return { __type: 'PageInfo', __hasNext: Boolean(v.__hasNext), __endCursor: (v.__endCursor as string | null) ?? null };
      if (field.name === 'totalCount') return ((v.__nodes as unknown[]) ?? []).length;
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return Boolean(v.__hasNext);
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'endCursor') return (v.__endCursor as string | null) ?? null;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return v.path ?? '';
      if (field.name === 'additions') return v.additions ?? 0;
      if (field.name === 'deletions') return v.deletions ?? 0;
      if (field.name === 'changeType') return v.changeType ?? 'modified';
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return String(v.id ?? '');
      if (field.name === 'body') return v.body ?? '';
      if (field.name === 'author') return { __type: 'User', login: VIEWER.login, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email };
      if (field.name === 'createdAt') return isoTs(1_700_000_000);
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return v.node ?? null;
      if (field.name === 'cursor') return '';
      return null;
    }
    case '__Type': {
      const info = v.__info as TypeInfo;
      const name = v.__typeName as string;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return info.kind;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        if (!info.fields) return null;
        return info.fields.map((f) => ({ __type: '__Field', name: f }));
      }
      if (field.name === 'enumValues') {
        if (!info.enumValues) return null;
        return info.enumValues.map((e) => ({ __type: '__EnumValue', name: e }));
      }
      return null;
    }
    case '__Field': {
      if (field.name === 'name') return v.name ?? '';
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return { __type: '__Type', __typeName: 'String', __info: { kind: 'SCALAR' } };
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return v.name ?? '';
      if (field.name === 'description') return null;
      return null;
    }
    case '__Schema': {
      if (field.name === 'types') return Object.keys(SCHEMA).map((n) => ({ __type: '__Type', __typeName: n, __info: SCHEMA[n]! }));
      if (field.name === 'queryType') return { __type: '__Type', __typeName: 'Query', __info: SCHEMA.Query! };
      if (field.name === 'mutationType') return { __type: '__Type', __typeName: 'Mutation', __info: SCHEMA.Mutation! };
      if (field.name === 'description') return null;
      return null;
    }
    case 'Mutation': {
      return executeMutation(field, state);
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (field.name === 'issue') return v.issue ?? null;
      return null;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return v.pullRequest ?? null;
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return v.commentEdge ?? null;
      return null;
    }
    default: return null;
  }
}

function executeMutation(field: FieldNode, state: ExecState): unknown {
  const input = (argValue(field, 'input', state) ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = repoFromGid(String(input.repositoryId ?? ''));
      if (!repo) return { issue: null };
      const created = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''));
      if ('error' in created) { state.errors.push({ message: created.error }); return { issue: null }; }
      return { issue: issueNode(repo, created) };
    }
    case 'closeIssue': {
      const found = issueFromGid(String(input.issueId ?? ''));
      if (!found) return { issue: null };
      found.issue.state = 'closed';
      found.issue.updatedTs = found.issue.updatedTs; // keep deterministic
      return { issue: issueNode(found.repo, found.issue) };
    }
    case 'createPullRequest': {
      const repo = repoFromGid(String(input.repositoryId ?? ''));
      if (!repo) return { pullRequest: null };
      const created = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? repo.defaultBranch));
      if ('error' in created) { state.errors.push({ message: created.error }); return { pullRequest: null }; }
      return { pullRequest: pullNode(repo, created) };
    }
    case 'mergePullRequest': {
      const found = pullFromGid(String(input.pullRequestId ?? ''));
      if (!found) return { pullRequest: null };
      const merged = mergePull(found.repo, found.pull);
      if ('error' in merged) { state.errors.push({ message: merged.error }); return { pullRequest: pullNode(found.repo, found.pull) }; }
      return { pullRequest: pullNode(found.repo, found.pull) };
    }
    case 'addComment': {
      const found = issueFromGid(String(input.subjectId ?? ''));
      if (!found) return { commentEdge: null };
      const comment = addComment(found.repo, found.issue.number, String(input.body ?? ''));
      if (!comment) return { commentEdge: null };
      return { commentEdge: { node: { __type: 'IssueComment', id: commentGid(found.repo, found.issue.number, comment.id), body: comment.body } } };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- entry points

export interface GqlResult { data: Record<string, unknown> | null; errors: { message: string }[]; }

export function executeGraphQL(query: string, variables: Record<string, unknown> = {}, operationName?: string): GqlResult {
  try {
    const { operations } = parseDocument(query);
    if (operations.length === 0) return { data: null, errors: [{ message: 'No operation found in document.' }] };
    let op = operations[0]!;
    if (operationName) {
      const named = operations.find((o) => o.name === operationName);
      if (named) op = named;
    }
    const state: ExecState = { errors: [], variables: { ...variables } };
    for (const [name, def] of Object.entries(op.variables)) {
      if (!(name in state.variables) && def.default !== undefined) state.variables[name] = resolveVars(def.default, variables);
    }
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelections({ type: rootType, value: {} }, op.selections, state);
    return { data, errors: state.errors };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export function executeGraphQLBatch(ops: { query: string; variables?: Record<string, unknown>; operationName?: string }[]): GqlResult[] {
  return ops.map((o) => executeGraphQL(o.query, o.variables ?? {}, o.operationName));
}

export { parseCommit, parseTree };
