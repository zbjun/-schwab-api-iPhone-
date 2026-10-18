import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { TradingError } from '../mobile/src/orderRules.ts';

const MAX_BODY = 24 * 1024;
const REVIEW_TTL = 60_000;
const AUTH_TTL = 9 * 60_000;
const QUICK_TTL = 10 * 60_000;
const MAX_QUICK_RECEIPTS = 512;
const digest = value => createHash('sha256').update(value).digest();
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new TradingError(code, message); };
const safeError = error => error instanceof TradingError
  ? { code: error.code, message: error.message }
  : { code: 'serverFailure', message: '服务器无法完成请求，请稍后重试。' };

export function createDeviceAuthenticator(devices) {
  if (!Array.isArray(devices) || !devices.length || devices.length > 20) throw new Error('Invalid device configuration');
  const ids = new Set(), tokens = new Set();
  const entries = devices.map(({ id, token }) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id) ||
        typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token) || tokens.has(token))
      throw new Error('Invalid device configuration');
    ids.add(id); tokens.add(token);
    return { id, hash: digest(token) };
  });
  return request => {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization)) return null;
    const hash = digest(authorization.slice(7));
    return entries.find(entry => timingSafeEqual(hash, entry.hash))?.id ?? null;
  };
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    fail('invalidRequest', '请求格式无效。');
  let size = 0, chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) fail('invalidRequest', '请求内容过大。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('invalidRequest', '请求格式无效。'); }
}

/** One server, one shared Broker. Never mount two gateway processes on the same vault. */
export function createGateway({ broker, devices, callbackURL = 'https://127.0.0.1', now = Date.now, marketHandler, marketHub }) {
  const authenticate = createDeviceAuthenticator(devices);
  const callback = new URL(callbackURL);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash || /[\\\s]/u.test(callbackURL))
    throw new Error('Invalid HTTPS callback');
  const automaticCallback = callback.pathname === '/oauth/callback';
  const reviews = new Map();
  const quickReceipts = new Map();
  let prepareBusy = false, writeBusy = false;
  let authPending, authInitiating, authCompleting;
  const prune = () => {
    for (const [id, review] of reviews) if (review.expires <= now()) reviews.delete(id);
    for (const [id, receipt] of quickReceipts) if (!receipt.pending && receipt.expires <= now()) quickReceipts.delete(id);
  };
  const beginAuthorization = () => {
    if (authCompleting) fail('operationBusy', '授权正在完成，请稍候刷新连接状态。');
    if (authInitiating) return authInitiating;
    authInitiating = (async () => {
      if ((await broker.status()).authenticated) fail('alreadyAuthenticated', '服务器已经完成授权，请刷新连接状态。');
      if (authPending && authPending.expires > now()) return authPending.url;
      const url = await broker.authorizationURL();
      authPending = { url, expires: now() + AUTH_TTL };
      return url;
    })().finally(() => { authInitiating = undefined; });
    return authInitiating;
  };
  const completeAuthorization = async url => {
    if (authCompleting || authInitiating) fail('operationBusy', '授权正在处理中，请稍候。');
    // The Broker owns the persisted one-use state and validates it even after restart.
    authCompleting = broker.completeAuthorization(url);
    try { await authCompleting; authPending = undefined; reviews.clear(); }
    catch (error) {
      // The broker consumes pending state before exchanging the one-use code.
      // A failed exchange must not keep returning that spent URL on retry.
      // Invalid callbacks are rejected before consumption: preserve the valid
      // attempt so an unrelated browser request cannot invalidate its state.
      if (!(error instanceof TradingError && error.code === 'invalidCallback')) authPending = undefined;
      throw error;
    }
    finally { authCompleting = undefined; }
  };
  const dispatch = async (device, method, args) => {
    prune();
    if (!Array.isArray(args)) fail('invalidRequest', '请求参数无效。');
    const length = (min, max = min) => { if (args.length < min || args.length > max) fail('invalidRequest', '请求参数无效。'); };
    switch (method) {
      case 'status': length(0); return broker.status();
      case 'accounts': length(0); return broker.accounts();
      case 'quotes': length(1, 2); if (!Array.isArray(args[0])) fail('invalidRequest', '股票列表无效。'); return broker.quotes(...args);
      case 'history': {
        length(2);
        const history = await broker.history(...args);
        try { return marketHub?.mergeHistory ? await marketHub.mergeHistory(history, args[1]) : history; }
        catch { return history; } // Retention must never hide a successful provider response.
      }
      case 'orders': length(1); return broker.orders(...args);
      case 'orderHistory': length(3); return broker.orderHistory(...args);
      case 'orderDetail': length(2); return broker.orderDetail(...args);
      case 'authorizationURL': length(0); return beginAuthorization();
      case 'completeAuthorization': length(1); return completeAuthorization(args[0]);
      case 'prepare': {
        length(2, 3);
        if (prepareBusy || writeBusy) fail('operationBusy', '另一台设备正在核对或提交，请稍候重试。');
        if (!object(args[1])) fail('invalidRequest', '委托参数无效。');
        prepareBusy = true;
        reviews.clear(); // Existing Broker intentionally supports only the latest review.
        try {
          const prepared = await broker.prepare(...args);
          const id = randomBytes(32).toString('base64url');
          reviews.set(id, { device, prepared, expires: now() + REVIEW_TTL });
          return { ...prepared, id };
        } finally { prepareBusy = false; }
      }
      case 'submit': {
        length(1);
        if (!object(args[0]) || Object.keys(args[0]).length !== 1 || typeof args[0].id !== 'string')
          fail('invalidRequest', '提交只接受服务器生成的核对编号。');
        const review = reviews.get(args[0].id);
        if (!review || review.device !== device) fail('reviewExpired', '核对已过期、已使用或被另一台设备更新，请重新核对。');
        if (writeBusy || prepareBusy) fail('operationBusy', '另一台设备正在处理委托，请稍候。');
        reviews.delete(args[0].id); // Never replay after timeout or a failed write.
        writeBusy = true;
        try { return await broker.submit(review.prepared); }
        finally { writeBusy = false; }
      }
      case 'submitQuick': {
        length(3);
        const [accountID, draft, requestID] = args;
        if (typeof accountID !== 'string' || !accountID || !object(draft) ||
            typeof requestID !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(requestID))
          fail('invalidRequest', '快速委托参数无效。');
        const fingerprint = JSON.stringify([accountID, draft]);
        const previous = quickReceipts.get(requestID);
        if (previous) {
          if (previous.device !== device || previous.fingerprint !== fingerprint)
            fail('invalidRequest', '快速委托编号与设备或委托内容不一致。');
          if (previous.pending) fail('operationBusy', '快速委托正在处理中，请等待结果。');
          if (previous.error) throw previous.error;
          return previous.result;
        }
        if (writeBusy || prepareBusy) fail('operationBusy', '另一台设备正在处理委托，请稍候。');
        if (typeof broker.submitQuick !== 'function') fail('methodNotAllowed', '服务器尚不支持快速委托，请更新服务器。');
        if (quickReceipts.size >= MAX_QUICK_RECEIPTS) fail('operationBusy', '快速委托记录暂满，请稍后重试。');
        const receipt = { device, fingerprint, pending: true, expires: now() + QUICK_TTL };
        quickReceipts.set(requestID, receipt);
        writeBusy = true;
        reviews.clear();
        try { receipt.result = await broker.submitQuick(accountID, draft); return receipt.result; }
        catch (error) { receipt.error = error; throw error; }
        finally { receipt.pending = false; receipt.expires = now() + QUICK_TTL; writeBusy = false; }
      }
      case 'cancel': {
        length(2);
        if (writeBusy || prepareBusy) fail('operationBusy', '另一台设备正在处理委托，请稍候。');
        writeBusy = true;
        reviews.clear();
        try { return await broker.cancel(...args); }
        finally { writeBusy = false; }
      }
      default: fail('methodNotAllowed', '此操作不允许通过设备调用。');
    }
  };
  const server = createServer(async (request, response) => {
    try {
      const path = (request.url ?? '').split('?')[0];
      if (request.method === 'GET' && path === '/oauth/callback' && automaticCallback) {
        // No Host/X-Forwarded-Host is incorporated into authorization URLs.
        const url = new URL(request.url, callback.origin);
        if (url.origin !== callback.origin || url.pathname !== callback.pathname) fail('invalidCallback', '授权回调无效。');
        await completeAuthorization(url.toString());
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
        response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>授权完成</title><h1>Schwab 授权已完成</h1><p>请返回 App，两台设备均可刷新连接。</p>');
        return;
      }
      // Native clients have no Origin header. Never enable browser credential access via CORS.
      if (request.headers.origin) { json(response, 403, { error: { code: 'originRejected', message: '请从 App 连接服务器。' } }); return; }
      const device = authenticate(request);
      if (!device) { json(response, 401, { error: { code: 'deviceUnauthorized', message: '设备连接密钥无效或已撤销。' } }); return; }
      if (request.url === '/activity' && marketHub) {
        if (request.method === 'DELETE') { marketHub.releaseActivity(device); json(response, 200, { result: null }); return; }
        if (request.method !== 'POST') fail('methodNotAllowed', '账户事件接口仅接受订阅和释放请求。');
        const body = await readBody(request);
        if (!object(body) || Object.keys(body).some(key => !['cursor', 'waitMs'].includes(key)) ||
            (body.cursor !== undefined && (!Number.isSafeInteger(body.cursor) || body.cursor < 0)) ||
            (body.waitMs !== undefined && (!Number.isInteger(body.waitMs) || body.waitMs < 0 || body.waitMs > 20_000)))
          fail('invalidRequest', '账户事件订阅参数无效。');
        const controller = new AbortController();
        const disconnected = () => controller.abort();
        response.once('close', disconnected);
        try {
          const result = await marketHub.pollActivity(device, body.cursor, body.waitMs, controller.signal);
          if (!response.destroyed) json(response, 200, { result });
        } finally { response.off('close', disconnected); }
        return;
      }
      if (request.url === '/market' && marketHub) {
        if (request.method === 'DELETE') { marketHub.release(device); json(response, 200, { result: null }); return; }
        if (request.method !== 'POST') fail('methodNotAllowed', '行情接口仅接受订阅和释放请求。');
        const body = await readBody(request);
        if (!object(body) || Object.keys(body).some(key => !['symbol', 'cursor', 'waitMs'].includes(key)) ||
            typeof body.symbol !== 'string' || !/^[A-Za-z0-9.\/-]{1,20}$/.test(body.symbol) ||
            (body.cursor !== undefined && (!Number.isSafeInteger(body.cursor) || body.cursor < 0)) ||
            (body.waitMs !== undefined && (!Number.isInteger(body.waitMs) || body.waitMs < 0 || body.waitMs > 20_000)))
          fail('invalidRequest', '行情订阅参数无效。');
        const controller = new AbortController();
        const disconnected = () => controller.abort();
        response.once('close', disconnected);
        try {
          const result = await marketHub.poll(device, body.symbol, body.cursor, body.waitMs, controller.signal);
          if (!response.destroyed) json(response, 200, { result });
        } finally { response.off('close', disconnected); }
        return;
      }
      if (path === '/market' && marketHandler) { await marketHandler(request, response, device); return; }
      if (request.method !== 'POST' || request.url !== '/rpc') { json(response, 404, { error: { code: 'notFound', message: '接口不存在。' } }); return; }
      const body = await readBody(request);
      if (!object(body) || Object.keys(body).some(key => !['method', 'args'].includes(key)) || typeof body.method !== 'string')
        fail('invalidRequest', '请求格式无效。');
      const result = await dispatch(device, body.method, body.args);
      json(response, 200, { result: result ?? null });
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof TradingError ? 400 : 500, { error: safeError(error) });
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 30;
  return server;
}
