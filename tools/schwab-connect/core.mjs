import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { historyProbePaths, isHistoryProbePath, summarizeHistoryResponse } from './history-probe.mjs';

export const CALLBACK_URL = 'https://127.0.0.1';
const API_HOST = 'api.schwabapi.com';
const TOKEN_PATH = '/v1/oauth/token';
const POSITIONS_PATH = '/trader/v1/accounts?fields=positions';
const QUOTES_PATH = '/marketdata/v1/quotes?symbols=AAPL';

export class PublicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function sameSecret(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(SCHWAB_CLIENT_ID|SCHWAB_CLIENT_SECRET|SCHWAB_REDIRECT_URI)\s*=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

export function percentile(values, proportion) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * proportion;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return Math.round((sorted[low] + (sorted[high] - sorted[low]) * (position - low)) * 100) / 100;
}

// Use separate, explicit agents for direct and local HTTP CONNECT proxy routes.
export function createTransport({ proxyUrl = '' } = {}) {
  const proxyEnv = {};
  if (proxyUrl) {
    let proxy;
    try { proxy = new URL(proxyUrl); } catch { throw new PublicError('本地代理地址无效。'); }
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port ||
      proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
      throw new PublicError('仅允许不含凭据的 127.0.0.1 HTTP 代理。');
    }
    proxyEnv.HTTPS_PROXY = proxy.href;
    proxyEnv.NO_PROXY = '';
  }
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, proxyEnv });
  const request = ({ method, path, form, authorization }) => new Promise((resolve, reject) => {
    const allowed = (method === 'POST' && path === TOKEN_PATH) ||
      (method === 'GET' && ([POSITIONS_PATH, QUOTES_PATH].includes(path) || isHistoryProbePath(path)));
    if (!allowed) return reject(new PublicError('此工具仅允许授权和指定的只读请求。'));
    const started = performance.now();
    let firstByteMs;
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const headers = { Accept: 'application/json', Authorization: authorization };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({ hostname: API_HOST, port: 443, method, path, headers, agent,
      rejectUnauthorized: true }, (response) => {
      firstByteMs = performance.now() - started;
      const remoteAddress = response.socket?.remoteAddress ?? null;
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          req.destroy(new Error('response-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => reject(new PublicError('Schwab 响应中断，请稍后重试。', 502)));
      response.on('end', () => {
        clearTimeout(deadline);
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'),
          timing: { status: response.statusCode, totalMs: Math.round((performance.now() - started) * 100) / 100,
            firstByteMs: Math.round(firstByteMs * 100) / 100, reusedConnection: req.reusedSocket, bytes,
            proxyUsed: Boolean(proxyUrl), remoteAddress } });
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('deadline-exceeded')), 20000);
    req.on('error', () => {
      clearTimeout(deadline);
      reject(new PublicError('无法完成到 Schwab 的 HTTPS 请求，请检查网络后重试。', 502));
    });
    req.end(body);
  });
  return { request, close: () => agent.destroy() };
}

export class SchwabSession {
  constructor({ request, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clientId = '', clientSecret = '', callbackUrl = CALLBACK_URL, proxyRequest, proxyLabel = '' } = {}) {
    this.request = request;
    this.proxyRequest = proxyRequest;
    this.proxyLabel = proxyLabel;
    this.now = now;
    this.pause = pause;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = callbackUrl;
    this.token = null;
    this.pending = null;
  }

  status() {
    return { configured: Boolean(this.clientId && this.clientSecret), authenticated: Boolean(this.token),
      callbackUrl: this.callbackUrl,
      supportsProxyComparison: true, proxyAvailable: Boolean(this.proxyRequest), proxyLabel: this.proxyLabel || '',
      benchmarkProgress: this.benchmarkProgress || null,
      expiresInSeconds: this.token ? Math.max(0, Math.floor((this.token.expiresAt - this.now()) / 1000)) : 0 };
  }

  configure({ clientId, clientSecret }) {
    for (const value of [clientId, clientSecret]) {
      if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\r\n]/.test(value)) {
        throw new PublicError('请填写有效的 Client ID 和 Client Secret。');
      }
    }
    this.clientId = clientId.trim();
    this.clientSecret = clientSecret.trim();
    this.logout();
    return { configured: true };
  }

  startAuth() {
    if (!this.status().configured) throw new PublicError('请先在本机配置 Client ID 和 Client Secret。');
    if (this.callbackUrl !== CALLBACK_URL) {
      throw new PublicError(`此无域名测试流程要求本地配置及 Schwab 后台的回调均为 ${CALLBACK_URL}。`);
    }
    const state = randomBytes(32).toString('hex');
    this.pending = { state, createdAt: this.now() };
    const url = new URL(`https://${API_HOST}/v1/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.clientId,
      redirect_uri: this.callbackUrl, state }).toString();
    return { authorizationUrl: url.href };
  }

  async completeAuth({ callbackUrl }) {
    if (!this.pending || this.now() - this.pending.createdAt > 10 * 60 * 1000) {
      this.pending = null;
      throw new PublicError('这次授权已过期，请重新点击登录 Schwab。');
    }
    let received;
    try { received = new URL(typeof callbackUrl === 'string' ? callbackUrl.trim() : ''); }
    catch { throw new PublicError('请粘贴浏览器地址栏里的完整回调链接。'); }
    const expected = new URL(this.callbackUrl);
    if (received.origin !== expected.origin || received.pathname !== expected.pathname ||
      received.username || received.password || received.hash ||
      received.searchParams.getAll('state').length !== 1 ||
      !sameSecret(received.searchParams.get('state'), this.pending.state)) {
      throw new PublicError('回调地址或授权校验值不匹配，请使用本次登录产生的完整链接。');
    }
    if (received.searchParams.has('error')) {
      this.pending = null;
      throw new PublicError('Schwab 未完成授权，请重新登录并确认账户授权。');
    }
    const codes = received.searchParams.getAll('code');
    if (codes.length !== 1 || !codes[0] || codes[0].length > 8192) {
      throw new PublicError('回调链接缺少有效授权码，请重新登录。');
    }
    // Consume before exchange. A retry must begin a new authorization session.
    this.pending = null;
    await this.exchange({ grant_type: 'authorization_code', code: codes[0], redirect_uri: this.callbackUrl });
    return { authenticated: true, expiresInSeconds: this.status().expiresInSeconds };
  }

  async exchange(form) {
    const authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
    const response = await this.request({ method: 'POST', path: TOKEN_PATH, form, authorization });
    if (response.status !== 200) {
      this.token = null;
      throw new PublicError(`Schwab 授权未成功（HTTP ${response.status}）。请检查密钥、回调地址和应用状态后重新登录。`, 502);
    }
    let data;
    try { data = JSON.parse(response.body); } catch { data = {}; }
    const seconds = Number(data.expires_in);
    if (typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token) ||
      !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400 ||
      (data.token_type && String(data.token_type).toLowerCase() !== 'bearer')) {
      this.token = null;
      throw new PublicError('Schwab 返回了无法使用的授权结果，请重新登录。', 502);
    }
    this.token = { accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : this.token?.refreshToken,
      expiresAt: this.now() + seconds * 1000 };
  }

  async ensureToken() {
    if (!this.token) throw new PublicError('请先完成 Schwab 登录授权。', 401);
    if (this.token.expiresAt - this.now() > 60000) return;
    if (!this.token.refreshToken) {
      this.token = null;
      throw new PublicError('授权已到期，请重新登录 Schwab。', 401);
    }
    await this.exchange({ grant_type: 'refresh_token', refresh_token: this.token.refreshToken });
  }

  async probeHistory() {
    await this.ensureToken();
    const now = this.now();
    const results = [];
    for (const item of historyProbePaths(now)) {
      await this.ensureToken();
      const response = await this.request({ method: 'GET', path: item.path,
        authorization: `Bearer ${this.token.accessToken}` });
      results.push({ symbol: item.symbol, mode: item.mode,
        ...summarizeHistoryResponse(response, item.symbol, now) });
      if (response.status === 401 || response.status === 429) break;
    }
    return { checkedAt: new Date(now).toISOString(), results };
  }

  async benchmark({ samples = 5, includeQuotes = false, route = 'direct' }) {
    if (!Number.isInteger(samples) || samples < 1 || samples > 30 || typeof includeQuotes !== 'boolean' ||
      !['direct', 'proxy', 'compare'].includes(route)) {
      throw new PublicError('样本数必须为 1–30 的整数，且线路必须为直连、代理或对比。');
    }
    if (route !== 'direct' && !this.proxyRequest) throw new PublicError('当前服务未配置可用的本地代理。');
    await this.ensureToken();
    const startedAt = new Date(this.now()).toISOString();
    const endpoints = [{ endpoint: POSITIONS_PATH, label: '账户与持仓' }];
    if (includeQuotes) endpoints.push({ endpoint: QUOTES_PATH, label: 'AAPL 行情' });
    const routes = route === 'compare' ? ['direct', 'proxy'] : [route];
    const groups = endpoints.flatMap((endpoint) => routes.map((networkRoute) => ({ ...endpoint,
      route: networkRoute, routeLabel: networkRoute === 'direct' ? '直连' : '当前代理',
      samples: [], warmup: null, blocked: false })));
    let first = true;
    let mustStop = false;
    this.benchmarkProgress = { completed: 0, total: groups.length * (samples + (route === 'compare' ? 1 : 0)) };
    const measure = async (group) => {
      if (!first) await this.pause(1000);
      first = false;
      await this.ensureToken();
      const request = group.route === 'direct' ? this.request : this.proxyRequest;
      const start = performance.now();
      let response;
      try {
        response = await request({ method: 'GET', path: group.endpoint,
          authorization: `Bearer ${this.token.accessToken}` });
      } catch {
        response = { status: 0, body: '', timing: { status: 0, transportError: true,
          totalMs: Math.round((performance.now() - start) * 100) / 100, firstByteMs: null,
          reusedConnection: false, bytes: 0 } };
      }
      let validData = false;
      if (response.status === 200) {
        try {
          const payload = JSON.parse(response.body);
          validData = group.endpoint === POSITIONS_PATH
            ? Array.isArray(payload) && payload.every((account) => account?.securitiesAccount &&
              typeof account.securitiesAccount === 'object')
            : Boolean(payload?.AAPL && typeof payload.AAPL === 'object' && !payload.AAPL.error);
        } catch { /* Never include a provider payload in diagnostics. */ }
      }
      if (response.status === 401) this.token = null;
      if ([401, 429].includes(response.status)) mustStop = true;
      // Stop a failing group to avoid retrying rejected requests or a dead proxy.
      if (!validData) group.blocked = true;
      this.benchmarkProgress.completed++;
      return { ...response.timing, validData };
    };
    try {
      for (const endpoint of endpoints) {
        const pair = groups.filter((group) => group.endpoint === endpoint.endpoint);
        if (route === 'compare') {
          for (const group of pair) {
            if (mustStop) break;
            group.warmup = await measure(group);
          }
        }
        for (let i = 0; i < samples && !mustStop; i++) {
          // Alternate both the route and which route runs first in each pair.
          for (const group of (i % 2 ? [...pair].reverse() : pair)) {
            if (mustStop) break;
            if (!group.blocked) group.samples.push(await measure(group));
          }
        }
        if (mustStop) break;
      }
    } finally { this.benchmarkProgress = null; }
    const results = groups.map(({ blocked, ...group }) => {
      const successful = group.samples.filter((item) => item.status === 200 && item.validData);
      const values = successful.map((item) => item.totalMs);
      const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      return { ...group, successfulCount: successful.length,
        medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
        maxMs: values.length ? Math.max(...values) : null,
        reusedCount: successful.filter((item) => item.reusedConnection).length,
        over1000msCount: values.filter((value) => value > 1000).length,
        failureCount: group.samples.length - successful.length,
        warmupFailed: Boolean(group.warmup && !group.warmup.validData),
        stddevMs: values.length ? Math.round(Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) * 100) / 100 : null };
    });
    return { results, startedAt, measuredAt: new Date(this.now()).toISOString(),
      comparison: route === 'compare', requestedSamplesPerRoute: samples,
      authenticatedRequestCount: results.reduce((sum, group) => sum + group.samples.length + (group.warmup ? 1 : 0), 0) };
  }

  logout() {
    this.token = null;
    this.pending = null;
    return { authenticated: false };
  }
}
