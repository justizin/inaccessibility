// Cloudflare Workers entry point. Static files come from the [assets]
// binding in wrangler.toml; everything under /api/ lands here.
import { createApp } from './app.js';
import { R2Storage } from './storage/r2.js';

const app = createApp((c) => ({
  storage: new R2Storage(c.env.BUCKET),
  accessToken: c.env.ACCESS_TOKEN || '',
}));

export default app;
