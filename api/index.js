import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

// Vercel serverless functions can only write to /tmp. Local runs keep using
// the project directories so this entrypoint is also testable offline.
const root = process.env.VERCEL ? '/tmp/gurukul-olympics-2026' : path.resolve('.');
const config = loadConfig({
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  storageDir: process.env.STORAGE_DIR || path.join(root, 'storage'),
  openBrowser: false,
  port: 0
});

const app = createApp(config);

// @vercel/node accepts a Node HTTP server as the default export.
export default http.createServer(app);
