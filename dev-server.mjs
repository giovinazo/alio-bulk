// 로컬 미리보기 서버. 버셀 함수(api/alio.js)를 같은 방식으로 띄우고 public/ 을 정적으로 낸다.
// 보안 방침: 127.0.0.1 에만 묶고, 정해진 시간이 지나면 스스로 끝난다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const { GET } = await import('./api/alio.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const TTL_MIN = Number(process.env.TTL_MIN || 180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function toRequest(req, url) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  return new Request(url, { method: req.method, headers, signal: ctrl.signal });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/api/alio' || url.pathname.startsWith('/api/alio/')) {
      const seg = url.pathname.slice('/api/alio'.length).replace(/^\//, '');
      if (seg && !url.searchParams.get('op')) url.searchParams.set('op', seg);
      const started = Date.now();
      const response = await GET(toRequest(req, url));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
      } else {
        res.end();
      }
      res.on('finish', () =>
        console.log(`${response.status} ${url.search.slice(0, 120)} ${Date.now() - started}ms`)
      );
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EISDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    } else {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('error');
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`미리보기: http://${HOST}:${PORT}/  (${TTL_MIN}분 뒤 자동 종료)`);
});

setTimeout(() => {
  console.log('정해진 시간이 지나 미리보기 서버를 끝냅니다.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}, TTL_MIN * 60 * 1000);
