import http from 'node:http';
import { spawn } from 'node:child_process';
import { loadConfig, formatBytes } from './src/config.js';
import { createApp } from './src/app.js';

const config = loadConfig();
const app = createApp(config);
const server = http.createServer(app);

server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 10 * 1000;

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Opening the browser is a convenience; the URL is printed below either way.
  }
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} is already in use.`);
    console.error(`Close the other app, or start Mosaic on another port:\n`);
    console.error(`  PowerShell:  $env:PORT=3001; npm start\n`);
  } else {
    console.error('Mosaic could not start:', error);
  }
  try {
    app.locals.close();
  } catch {
    // Ignore close errors after a failed start.
  }
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;
  console.log('');
  console.log('  Gurukul Olympics 2026 — your local photo library');
  console.log(`  ${url}`);
  console.log('');
  console.log(`  Library:  ${config.storageDir}`);
  console.log(`  Database: ${config.dbPath}`);
  console.log(`  Files:    up to ${formatBytes(config.maxFileBytes)} each, ${config.maxBatchFiles} per batch`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  if (config.openBrowser) {
    setTimeout(() => openBrowser(url), 350);
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping Mosaic...');
  server.close(async () => {
    try {
      await app.locals.closeDriveWatcher?.();
    } catch {
      // Ignore watcher shutdown errors.
    }
    try {
      app.locals.close();
    } catch {
      // Ignore shutdown errors.
    }
    process.exit(0);
  });
  setTimeout(() => {
    try {
      app.locals.close();
    } catch {
      // Ignore.
    }
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
