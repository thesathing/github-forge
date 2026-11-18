// Entry lifecycle, re-implemented here from the kit's contract (env/src/wire.ts):
// bind an ephemeral port, tell the env which port it is, then poll until the
// env says the trial is over and exit 0. The suite scores the server built by
// app.ts; this file only runs the harness protocol around it:
//
//   1. MAKEFUN_ENV_URL names the env origin (http://store:8080 in a trial
//      container). With no env to talk to, the process exits 1 at once.
//   2. Listen on port 0 and let the kernel pick a free port. Never bind
//      8080: the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register with {"port": N}. The env records the
//      address the request came from plus N as the base URL and dials it
//      from then on. The first register wins; a 409 means another entry
//      already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is a
//      poll, not a long-held request. A failed or slow poll is retried with
//      a short exponential backoff; the process never exits before the env
//      says done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// This file imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request may take at most this long before it is
// abandoned and retried.
const REQUEST_TIMEOUT_MS = 30_000;
// Backoff starts here and never grows past RETRY_CAP_MS.
const RETRY_START_MS = 250;
const RETRY_CAP_MS = 2_000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `failures` failed requests: doubling from RETRY_START_MS,
// capped at RETRY_CAP_MS (the exponent stops growing after 8 doublings).
function backoffMs(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_START_MS * 2 ** Math.min(failures, 8));
}

// A fetch that fails on timeout instead of hanging: the caller decides
// whether the failure is worth retrying.
async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

// POST the bound port until the env accepts it. 200 is the normal answer
// and 409 means a first register already won, which is not this process's
// to fix. 400 and 405 are contract errors and end the program; a network
// error or any other status is retried, since the env may still be starting.
async function registerPort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let answer: Response | null = null;
    try {
      answer = await timedFetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      answer = null;
    }
    if (answer !== null) {
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register answered HTTP ${answer.status}: ${await answer.text()}`);
      }
    }
    await wait(backoffMs(failures));
  }
}

// GET /done until it answers {"done": true}; never return before that.
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await timedFetch(`${envOrigin}/done`);
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not
      // done, so poll again.
    }
    await wait(backoffMs(failures));
  }
}

// Bind the port, register it, then wait for the env: the whole life of
// the process.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
