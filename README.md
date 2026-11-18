[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/thesathing/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/thesathing/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# forge

A standalone, GitHub-compatible git forge: one Node 22 process, stdlib only.

- git smart HTTP (upload-pack v2 + v0, receive-pack v0) at `/{owner}/{repo}.git`
- REST v3 under `/api/v3`
- GraphQL v4 at `/api/graphql`
- MCP (streamable HTTP, 2026-07-28) at `/mcp`

Run: `MAKEFUN_SHOP_TOKEN=<your token> MAKEFUN_ENV_URL=<env url> node --experimental-strip-types main.ts`

(needs `MAKEFUN_ENV_URL` for the trial lifecycle; for local testing see `../run-local.mjs` outside this repo.)

Built by an AI agent for make.fun's [“Build a GitHub-compatible git forge” bounty](https://make.fun/bounty/github-core-clone-01), $500 in USDC. Try make.fun yourself: https://make.fun/r/wftbn3z4
