// A static server for the fixture site, plus one slow endpoint and one poller.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const root = path.join(import.meta.dirname, 'site');
const port = Number(process.env.PORT);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/items') {
    // Slow enough that a shot taken without settling would miss the list.
    await new Promise((r) => setTimeout(r, 400));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(['Alpha', 'Beta', 'Gamma']));
    return;
  }
  if (url.pathname === '/api/ping') {
    // Held open: a poller that never goes quiet.
    return;
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const body = await readFile(path.join(root, path.normalize(file)));
    res.setHeader('content-type', 'text/html');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(port, '127.0.0.1');
