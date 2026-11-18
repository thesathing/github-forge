// MCP endpoint (streamable HTTP, revision 2026-07-28 + legacy initialize).
// Tools act on the same store as REST.

import {
  VIEWER, addComment, allRepos, createIssue, createLabel, createPull, createRepo, deleteRepo,
  getRepo, mergePull, type Issue, type Pull, type Repo,
} from './store.ts';

export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string; description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  { name: 'create_repo', description: 'Create a new repository owned by the authenticated user.', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' } }, required: ['name'] },
  { name: 'get_repo', description: 'Get a repository by owner and name.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  { name: 'list_repos', description: 'List repositories owned by the authenticated user.', properties: { owner: { type: 'string', description: 'Owner login' } }, required: [] },
  { name: 'create_issue', description: 'Create an issue in a repository.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  { name: 'get_issue', description: 'Get one issue by number.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'number'] },
  { name: 'list_issues', description: 'List issues in a repository, optionally filtered by state.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] },
  { name: 'create_comment', description: 'Add a comment to an issue.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, number: { type: 'integer', description: 'Issue number' }, body: { type: 'string', description: 'Comment body' } }, required: ['owner', 'repo', 'number', 'body'] },
  { name: 'create_pull_request', description: 'Open a pull request from a head branch into a base branch.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  { name: 'get_pull_request', description: 'Get one pull request by number.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'number'] },
  { name: 'list_pull_requests', description: 'List pull requests in a repository.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Pull request state: open, closed or all' } }, required: ['owner', 'repo'] },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash commit.', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
];

function toolsListJson(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.properties, required: t.required },
  }));
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id }, private: repo.private,
    description: repo.description, default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER.login, id: VIEWER.id },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

type ToolOutcome = { ok: true; data: unknown } | { ok: false; message: string };

function findRepo(owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  return getRepo(owner, repo) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (!repoName) return { ok: false, message: 'name is required' };
      const created = createRepo(repoName, str(args.description), args.private === true);
      if ('error' in created) return { ok: false, message: created.error };
      return { ok: true, data: repoJson(created) };
    }
    case 'get_repo': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return { ok: false, message: `Repository ${String(args.owner)}/${String(args.repo)} not found` };
      return { ok: true, data: repoJson(repo) };
    }
    case 'list_repos': {
      return { ok: true, data: { repositories: allRepos().filter((r) => r.owner === VIEWER.login).map((r) => repoJson(r)) } };
    }
    case 'create_issue': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return { ok: false, message: `Repository ${String(args.owner)}/${String(args.repo)} not found` };
      const created = createIssue(repo, str(args.title), str(args.body));
      if ('error' in created) return { ok: false, message: created.error };
      return { ok: true, data: issueJson(repo, created) };
    }
    case 'get_issue': {
      const repo = findRepo(args.owner, args.repo);
      const n = num(args.number);
      const issue = repo && n !== null ? repo.issuesByNumber.get(n) : undefined;
      if (!repo || !issue) return { ok: false, message: 'Issue not found' };
      return { ok: true, data: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return { ok: false, message: `Repository ${String(args.owner)}/${String(args.repo)} not found` };
      const state = str(args.state) || 'open';
      const list = repo.issues.filter((i) => state === 'all' ? true : i.state === state);
      return { ok: true, data: { issues: list.map((i) => issueJson(repo, i)) } };
    }
    case 'create_comment': {
      const repo = findRepo(args.owner, args.repo);
      const n = num(args.number);
      if (!repo || n === null) return { ok: false, message: 'Issue not found' };
      const comment = addComment(repo, n, str(args.body));
      if (!comment) return { ok: false, message: 'Issue not found' };
      return { ok: true, data: { id: comment.id, body: comment.body } };
    }
    case 'create_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return { ok: false, message: `Repository ${String(args.owner)}/${String(args.repo)} not found` };
      const created = createPull(repo, str(args.title), str(args.body), str(args.head), str(args.base) || repo.defaultBranch);
      if ('error' in created) return { ok: false, message: created.error };
      return { ok: true, data: pullJson(repo, created) };
    }
    case 'get_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      const n = num(args.number);
      const pull = repo && n !== null ? repo.pullsByNumber.get(n) : undefined;
      if (!repo || !pull) return { ok: false, message: 'Pull request not found' };
      return { ok: true, data: pullJson(repo, pull) };
    }
    case 'list_pull_requests': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return { ok: false, message: `Repository ${String(args.owner)}/${String(args.repo)} not found` };
      const state = str(args.state) || 'open';
      const list = repo.pulls.filter((p) => state === 'all' ? true : p.state === state);
      return { ok: true, data: { pull_requests: list.map((p) => pullJson(repo, p)) } };
    }
    case 'merge_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      const n = num(args.pull_number) ?? num(args.number);
      const pull = repo && n !== null ? repo.pullsByNumber.get(n) : undefined;
      if (!repo || !pull) return { ok: false, message: 'Pull request not found' };
      const merged = mergePull(repo, pull);
      if ('error' in merged) return { ok: false, message: merged.error };
      return { ok: true, data: { merged: true, sha: merged.sha, message: `${pull.title} (#${pull.number})`, number: pull.number } };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one POST /mcp body (already read as text). Returns {status, body}.
 * Auth is checked by the caller (401 before this runs).
 */
export function handleMcp(rawBody: string): { status: number; body: string } {
  const json = (obj: unknown): string => JSON.stringify(obj);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: json(rpcError(null, -32700, 'Parse error')) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: json(rpcError(null, -32600, 'Invalid Request')) };
  }
  const req = parsed as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params)) ? req.params as Record<string, unknown> : {};

  // Notifications (no id): acknowledge with 202 and no JSON-RPC body.
  if (req.id === undefined) {
    return { status: 202, body: '{}' };
  }

  if (method === 'server/discover') {
    const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
    return { status: 200, body: json(rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo,
      instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests.',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    })) };
  }
  if (method === 'initialize') {
    const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? (params as Record<string, unknown>).protocolVersion as string : '2026-07-28';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return { status: 200, body: json(rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    })) };
  }
  if (method === 'ping') {
    return { status: 200, body: json(rpcResult(id, {})) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: json(rpcResult(id, { tools: toolsListJson() })) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)) ? params.arguments as Record<string, unknown> : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { status: 200, body: json(rpcError(id, -32602, `Unknown tool: ${name}`)) };
    const missing = tool.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length) return { status: 200, body: json(rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`)) };
    const outcome = callTool(name, args);
    if (!outcome.ok) {
      return { status: 200, body: json(rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true })) };
    }
    const text = JSON.stringify(outcome.data);
    return { status: 200, body: json(rpcResult(id, { content: [{ type: 'text', text }], structuredContent: outcome.data, isError: false })) };
  }
  return { status: 200, body: json(rpcError(id, -32601, `Method not found: ${method}`)) };
}

export { createLabel, deleteRepo };
