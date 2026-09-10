import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGateway } from '../server/gateway.mjs';
import { ServerBroker } from '../mobile/src/ServerBroker.ts';
import { SchwabBroker } from '../mobile/src/broker.ts';
import { MarketHub } from '../server/market.ts';

// All credentials, orders and accounts are fictional. Only loopback HTTP is used.
const base = 'https://gateway.example.test';
const devices = [{ id: 'phone-a', token: 'a'.repeat(64) }, { id: 'phone-b', token: 'b'.repeat(64) }];
function vault(initial = []) {
  const values = new Map(initial);
  return { get: async k => values.get(k) ?? null, set: async (k,v) => { values.set(k,v); }, remove: async k => { values.delete(k); } };
}
async function fixture(t, broker, options = {}) {
  const server = createGateway({ broker, devices, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const local = `http://127.0.0.1:${server.address().port}`;
  const transport = async (url, init) => {
    assert.equal(new URL(url).origin, base);
    const reply = await fetch(local + new URL(url).pathname, init);
    const response = new Response(await reply.text(), { status: reply.status, headers: reply.headers });
    Object.defineProperty(response, 'url', {value: url});
    return response;
  };
  const a = new ServerBroker(vault(), { fetch: transport });
  const b = new ServerBroker(vault(), { fetch: transport });
  await a.configureServer(base, devices[0].token);
  await b.configureServer(base, devices[1].token);
  return {a,b,local};
}
function fakeBroker() {
  let submits = 0, disconnects = 0, authStarts = 0;
  let authenticated = true;
  return {
    counts: () => ({submits,disconnects,authStarts}),
    setAuthenticated: value => { authenticated = value; },
    status: async () => ({configured:true,authenticated,unresolvedOperation:false}),
    accounts: async () => [],
    authorizationURL: async () => { authStarts++; return 'https://api.schwabapi.com/v1/oauth/authorize?state=fictional'; },
    completeAuthorization: async () => { authenticated = true; },
    disconnect: async () => { disconnects++; authenticated = false; },
    prepare: async (accountID,draft) => Object.freeze({id:'fake-private-id', accountID, accountDisplay:'fictional',draft:Object.freeze({...draft}),quote:{symbol:draft.symbol},availableShares:10,preparedAt:Date.now(),isDemo:false}),
    submit: async () => { submits++; return {orderID:'fictional-order'}; },
  };
}
test('two mobile connections share authorization; forgetting one does not log out the broker', async t => {
  const broker = fakeBroker();
  const {a,b} = await fixture(t,broker);
  assert.equal((await a.status()).authenticated,true);
  assert.equal((await b.status()).authenticated,true);
  await a.disconnect();
  assert.equal((await a.status()).configured,false);
  assert.equal((await b.status()).authenticated,true);
  assert.equal(broker.counts().disconnects,0);
});
test('another device cannot submit a prepared order; owning device can submit only once', async t => {
  const broker = fakeBroker();
  const {a,b} = await fixture(t,broker);
  const prepared = await a.prepare('fictional-account',{symbol:'AAPL',side:'BUY',kind:'LIMIT',quantity:1,limitPrice:'100',duration:'DAY'});
  await assert.rejects(b.submit(prepared));
  assert.equal(broker.counts().submits,0);
  assert.equal((await a.submit(prepared)).orderID,'fictional-order');
  await assert.rejects(a.submit(prepared));
  assert.equal(broker.counts().submits,1);
});
test('two devices initiating login share one pending authorization and see completion', async t => {
  const broker = fakeBroker();
  broker.setAuthenticated(false);
  const {a,b} = await fixture(t,broker);
  const [first,second] = await Promise.all([a.authorizationURL(),b.authorizationURL()]);
  assert.equal(first,second);
  assert.equal(broker.counts().authStarts,1);
  await a.completeAuthorization('https://127.0.0.1/?code=fictional&state=fictional');
  assert.equal((await b.status()).authenticated,true);
});
test('two actual remote clients cause exactly one central Schwab token refresh', async t => {
  let refreshes = 0;
  const state = {version:1,credentials:{clientID:'fictional-client',clientSecret:'fictional-secret'},token:{accessToken:'fictional-expired-access',refreshToken:'fictional-refresh-token',expiresAt:Date.now()-1000}};
  const broker = new SchwabBroker(vault([['ths.schwab.session.v1',JSON.stringify(state)]]),{
    randomState: () => 'c'.repeat(64),
    fetch: async (url,init) => {
      assert.equal(new URL(url).origin,'https://api.schwabapi.com');
      let data;
      if (new URL(url).pathname === '/v1/oauth/token') {
        assert.equal(new URLSearchParams(init.body).get('grant_type'),'refresh_token');
        refreshes++;
        await new Promise(resolve=>setTimeout(resolve,30));
        data={access_token:'fictional-new-access',refresh_token:'fictional-new-refresh',expires_in:1800,token_type:'Bearer'};
      } else {
        assert.equal(new URL(url).pathname,'/trader/v1/accounts');
        data=[];
      }
      const response = new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
      Object.defineProperty(response,'url',{value:url});
      return response;
    }
  });
  const {a,b} = await fixture(t,broker);
  const result = await Promise.all([a.accounts(),b.accounts()]);
  assert.deepEqual(result,[[],[]]);
  assert.equal(refreshes,1);
});

test('HTTPS callback completes the actual central broker once and never exposes tokens to either device', async t => {
  const callbackURL = base + '/oauth/callback';
  let exchanges = 0;
  const broker = new SchwabBroker(vault(), {
    callbackURL, randomState: () => 'd'.repeat(64),
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.schwabapi.com/v1/oauth/token');
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('redirect_uri'), callbackURL);
      assert.equal(body.get('code'), 'fictional-code');
      exchanges++;
      const response = new Response(JSON.stringify({access_token:'private-fixture-access',refresh_token:'private-fixture-refresh',expires_in:1800,token_type:'Bearer'}), {status:200});
      Object.defineProperty(response, 'url', {value:url});
      return response;
    },
  });
  await broker.configure('fictional-client', 'fictional-secret');
  const {a,b,local} = await fixture(t, broker, {callbackURL});
  const login = new URL(await a.authorizationURL());
  assert.equal(login.searchParams.get('redirect_uri'), callbackURL);
  const invalid = await fetch(local + '/oauth/callback?code=fictional-code&state=' + 'e'.repeat(64));
  assert.equal(invalid.status, 400);
  assert.equal(exchanges, 0);
  const callback = local + '/oauth/callback?code=fictional-code&state=' + login.searchParams.get('state');
  const reply = await fetch(callback, {headers:{Host:'attacker.example.test'}});
  assert.equal(reply.status, 200);
  assert.match(await reply.text(), /授权已完成/);
  const states = await Promise.all([a.status(),b.status()]);
  assert.ok(states.every(state => state.authenticated));
  assert.doesNotMatch(JSON.stringify(states), /private-fixture|fictional-secret/);
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(exchanges, 1);
});

test('two actual mobile streams share a gateway upstream and one device can leave without disconnecting the other', async t => {
  let upstream, opens = 0, closes = 0;
  const hub = new MarketHub(async () => { throw new Error('No real credentials in integration'); }, {
    openStream(symbols, _credentials, callbacks) {
      assert.deepEqual(symbols,['AAPL']);
      opens++; upstream = callbacks;
      callbacks.onStatus('live');
      return () => { closes++; };
    },
  });
  t.after(() => hub.close());
  const {a,b} = await fixture(t,fakeBroker(),{marketHub:hub});
  let resolveA,resolveB,resolveAfter;
  const firstA = new Promise(resolve => {resolveA=resolve;});
  const firstB = new Promise(resolve => {resolveB=resolve;});
  const after = new Promise(resolve => {resolveAfter=resolve;});
  const statuses=[];
  const stopA = a.subscribeMarket('AAPL',{onStatus:value=>statuses.push(value),onQuote:resolveA,onCandle:()=>{}});
  const stopB = b.subscribeMarket('AAPL',{onStatus:value=>statuses.push(value),onQuote:quote=>{
    if(quote.lastPrice === 124) resolveAfter(quote); else resolveB(quote);
  },onCandle:()=>{}});
  t.after(() => {stopA();stopB();});
  const until = async predicate => {
    for(let i=0;i<100;i++) {
      if(predicate()) return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail('Timed out waiting for local relay');
  };
  await until(()=>statuses.filter(value=>value==='live').length>=2);
  upstream.onQuote({symbol:'AAPL',lastPrice:123,quoteTime:Date.now()});
  await Promise.all([firstA,firstB]);
  assert.equal(opens,1);
  stopA();
  upstream.onQuote({symbol:'AAPL',lastPrice:124,quoteTime:Date.now()});
  assert.equal((await after).lastPrice,124);
  assert.equal(closes,0);
  stopB();
  await until(()=>closes===1);
});

test('new order passes real broker preparation over JSON RPC and submits the server snapshot unchanged', async t => {
  const now = Date.now(), accountID = '12345678', hash = 'FixtureAccountHash_A';
  let writes = 0;
  const state = {version:1,credentials:{clientID:'fictional-client',clientSecret:'fictional-secret'},token:{accessToken:'fictional-access',refreshToken:'fictional-refresh',expiresAt:now+1_800_000}};
  const broker = new SchwabBroker(vault([['ths.schwab.session.v1',JSON.stringify(state)]]), {
    randomState:()=> 'f'.repeat(64), now:()=>now,
    fetch: async (raw, init) => {
      const url=new URL(raw);
      assert.equal(url.origin,'https://api.schwabapi.com');
      let data, status=200, headers={};
      if (init.method === 'POST') {
        assert.equal(url.pathname,`/trader/v1/accounts/${hash}/orders`);
        const order=JSON.parse(init.body);
        assert.equal(order.price,'100');
        assert.equal(order.orderLegCollection[0].quantity,1);
        writes++; status=201;
        headers={location:`https://api.schwabapi.com/trader/v1/accounts/${hash}/orders/123`};
      } else {
        assert.equal(init.method,'GET');
        if(url.pathname==='/trader/v1/accounts') data=[{securitiesAccount:{accountNumber:accountID,type:'CASH',currentBalances:{liquidationValue:1000,cashBalance:1000,buyingPower:1000},positions:[]}}];
        else if(url.pathname==='/trader/v1/accounts/accountNumbers') data=[{accountNumber:accountID,hashValue:hash}];
        else if(url.pathname==='/marketdata/v1/quotes') data={AAPL:{symbol:'AAPL',realtime:true,assetMainType:'EQUITY',reference:{description:'Fixture'},quote:{lastPrice:100,bidPrice:99.98,askPrice:100.02,quoteTime:now,totalVolume:12345}}};
        else {assert.equal(url.pathname,`/trader/v1/accounts/${hash}/orders`);data=[];}
      }
      const response=new Response(data===undefined?'':JSON.stringify(data),{status,headers});
      Object.defineProperty(response,'url',{value:raw});
      return response;
    },
  });
  const {a,b}=await fixture(t,broker);
  const prepared=await a.prepare(accountID,{symbol:'AAPL',side:'BUY',kind:'LIMIT',quantity:1,limitPrice:'100',duration:'DAY'});
  assert.equal(prepared.draft.quantity,1);
  assert.equal(writes,0);
  await assert.rejects(b.submit(prepared),{code:'reviewExpired'});
  // Devices receive JSON copies. Tampering cannot rewrite the private broker snapshot.
  prepared.draft.quantity=999;
  assert.equal((await a.submit(prepared)).orderID,'123');
  assert.equal(writes,1);
});
