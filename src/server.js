// Node entry point (Docker on Nomad / k8s, or plain `npm start`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { storageFromEnv } from './storage/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.relative(process.cwd(), path.join(here, '..', 'public')) || '.';

const storage = storageFromEnv(process.env);
const deps = { storage, accessToken: process.env.ACCESS_TOKEN || '' };

const app = new Hono();
app.route('/', createApp(() => deps));
app.use('/*', serveStatic({ root: publicDir }));

const port = Number(process.env.PORT || 8080);
const hostname = process.env.HOST || '0.0.0.0';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`inaccessibility listening on http://${info.address}:${info.port} storage=${storage.kind}${deps.accessToken ? ' auth=passphrase' : ' auth=NONE'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
