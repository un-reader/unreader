import type { Config, Context } from '@netlify/edge-functions';

// Netlify Functions can't hold WebSocket connections, so on Netlify the live
// chat socket connects to the Render deployment instead. This only rewrites
// the copy of common.js served by Netlify; the file in the repo is unchanged.
const RENDER_WS_URL = 'wss://unreader-2lz0.onrender.com';

export default async (_req: Request, context: Context) => {
  const res = await context.next();
  if (!res.ok) return res;
  const js = await res.text();
  const patched = js.replace(
    /var WS_URL = DEBUG \?\s*'ws:\/\/127\.0\.0\.1:80' :\s*window\.location\.origin[^;]*;/,
    `var WS_URL = DEBUG ? 'ws://127.0.0.1:80' : '${RENDER_WS_URL}';`,
  );
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(patched, { status: res.status, headers });
};

export const config: Config = { path: '/common.js' };
