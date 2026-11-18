# forge

A standalone, GitHub-compatible git forge: one Node 22 process, stdlib only.

- git smart HTTP (upload-pack v2 + v0, receive-pack v0) at `/{owner}/{repo}.git`
- REST v3 under `/api/v3`
- GraphQL v4 at `/api/graphql`
- MCP (streamable HTTP, 2026-07-28) at `/mcp`

Run: `MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts`
(needs `MAKEFUN_ENV_URL` for the trial lifecycle; for local testing see
`../run-local.mjs` outside this repo.)
