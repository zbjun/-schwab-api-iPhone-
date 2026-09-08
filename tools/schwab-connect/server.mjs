import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CALLBACK_URL, PublicError, SchwabSession, createTransport, parseEnv, sameSecret } from './core.mjs';

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function createLocalServer({ session }) {
  const csrfToken = randomBytes(32).toString('hex');
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { ...securityHeaders, 'Content-Type': type });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      if (req.headers.host !== new URL(origin).host) throw new PublicError('仅允许通过本机地址访问。', 403);
      if (req.method === 'GET' && req.url === '/api/status') {
        return send(200, { ...session.status(), csrfToken });
      }
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      if (req.method === 'GET' && Object.hasOwn(assets, req.url)) {
        const [name, type] = assets[req.url];
        return send(200, await readFile(new URL(`./public/${name}`, import.meta.url)), type);
      }
      if (req.method !== 'POST') throw new PublicError('此地址不存在。', 404);
      if (req.headers.origin !== origin || !sameSecret(req.headers['x-csrf-token'], csrfToken)) {
        throw new PublicError('请求来源校验失败，请刷新本机页面。', 403);
      }
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        throw new PublicError('请求必须使用 JSON。', 415);
      }
      if (busy) throw new PublicError('上一项操作仍在进行，请等待完成。', 409);
      const handlers = {
        '/api/config': (data) => session.configure(data),
        '/api/auth/start': () => session.startAuth(),
        '/api/auth/complete': (data) => session.completeAuth(data),
        '/api/benchmark': (data) => session.benchmark(data),
        '/api/history-probe': () => session.probeHistory(),
        '/api/logout': () => session.logout(),
      };
      if (!Object.hasOwn(handlers, req.url)) throw new PublicError('此地址不存在。', 404);
      busy = true;
      try {
        let body = '';
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32 * 1024) throw new PublicError('输入内容过长。', 413);
          body += chunk.toString('utf8');
        }
        let data;
        try { data = JSON.parse(body || '{}'); }
        catch { throw new PublicError('输入格式无效。'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PublicError('输入格式无效。');
        send(200, await handlers[req.url](data));
      } finally { busy = false; }
    } catch (error) {
      if (!res.headersSent) {
        send(error instanceof PublicError ? error.status : 500,
          { error: error instanceof PublicError ? error.message : '本机工具无法完成操作，请刷新后重试。' });
      }
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 10000;
  return server;
}

async function main() {
  const port = Number(process.env.SCHWAB_LOCAL_PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid-port');
  let config = {};
  try { config = parseEnv(await readFile(new URL('../../.env', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const transport = createTransport();
  const proxyUrl = process.env.SCHWAB_PROXY_URL || 'http://127.0.0.1:7897';
  const proxyTransport = createTransport({ proxyUrl });
  const session = new SchwabSession({ request: transport.request,
    clientId: config.SCHWAB_CLIENT_ID, clientSecret: config.SCHWAB_CLIENT_SECRET,
    callbackUrl: config.SCHWAB_REDIRECT_URI || CALLBACK_URL,
    proxyRequest: proxyTransport.request, proxyLabel: new URL(proxyUrl).host });
  const server = createLocalServer({ session });
  server.on('error', () => {
    transport.close();
    proxyTransport.close();
    process.stderr.write('本机服务无法启动。请确认端口未被占用，再重试。\n');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Schwab 本机验证工具：http://127.0.0.1:${port}\n`);
    process.stdout.write('只读测速；密钥和令牌只用于本机进程，不写入日志。关闭程序将清除内存中的授权。\n');
  });
  const stop = () => { session.logout(); server.close(); server.closeAllConnections(); transport.close(); proxyTransport.close(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write('启动失败，请检查本地配置和 Node.js 版本。\n');
    process.exitCode = 1;
  });
}
