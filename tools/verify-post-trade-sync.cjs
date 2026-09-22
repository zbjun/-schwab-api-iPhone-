const assert = require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:8081/?appearance=dark');
 await page.getByRole('tab',{name:'自选',exact:true}).click();
 await page.getByRole('button',{name:'行情 AAPL',exact:true}).click();
 await page.getByTestId('chart.plot').waitFor();
 const result=await page.evaluate(async()=>{
  const el=document.querySelector('#root');const key=Object.keys(el).find(k=>k.startsWith('__reactContainer$'));
  function state(){let r=el[key];while(r.return)r=r.return;const stack=[r.stateNode.current];while(stack.length){const f=stack.pop();if(f.type?.name==='StockDetail')return f.memoizedProps.state;if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);}throw Error('state missing');}
  if(!state().isDemo)throw Error('Demo required');
  const wait=()=>new Promise(r=>setTimeout(r,40));
  const broker=state().broker;const original={accounts:broker.accounts.bind(broker),orders:broker.orders.bind(broker)};
  const accountValues=await original.accounts();const orderValues=await original.orders(state().accountID);
  let resolveAccounts,resolveOrders;let accountStarted=false,ordersStarted=false,quotes=0;
  const revision=state().revision;const originalQuote=broker.quotes.bind(broker);
  broker.quotes=async(...args)=>{quotes++;return originalQuote(...args);};
  broker.accounts=()=>{accountStarted=true;return new Promise(r=>{resolveAccounts=r;});};
  broker.orders=()=>{ordersStarted=true;return new Promise(r=>{resolveOrders=r;});};
  // Emulate acknowledged submission; no brokerage write is performed.
  await state().run(async()=>{state().setMessage('测试订单已提交 #fixture');state().syncAfterTrade();});
  await wait();
  if(state().busy || !accountStarted || !ordersStarted)throw Error('Acknowledgement blocked by background reads');
  if(quotes || state().revision!==revision)throw Error('Unrelated quotes/history refreshed');
  resolveOrders(orderValues);await wait();
  if(!state().ordersLoaded)throw Error('Orders waited for accounts');
  resolveAccounts(accountValues);await wait();
  broker.accounts=async()=>{throw Error('fixture read failure');};
  broker.orders=async()=>{throw Error('fixture read failure');};
  state().syncAfterTrade();await wait();
  if(!state().accountRefreshError || !state().ordersError)throw Error('Read failure missing');
  if(!state().message.includes('已提交'))throw Error('Read failure changed receipt');
  broker.accounts=()=>new Promise(r=>{resolveAccounts=r;});broker.orders=()=>new Promise(r=>{resolveOrders=r;});
  state().syncAfterTrade();await wait();
  // Changing context must invalidate a late post-trade snapshot.
  state().selectAccount('fixture-other-account');await wait();
  resolveAccounts([{...accountValues[0],netLiquidation:123456789}]);resolveOrders([{...orderValues[0],id:'stale-read'}]);
  await wait();
  if(state().orders.some(o=>o.id==='stale-read') || state().accounts.some(a=>a.netLiquidation===123456789))throw Error('Stale snapshot applied');
  return {releasedBeforeReads:true,independentUpdates:true,noHistoryRefresh:true,receiptRetained:true,staleContextIgnored:true};
 });
 assert.deepEqual(errors,[]);console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
