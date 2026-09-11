// Run against the development web app. Requires Playwright via PLAYWRIGHT_MODULE
// or the caller's module path. All broker responses are isolated demo fixtures.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.PREVIEW_URL || 'http://localhost:8081/?appearance=dark');
    await page.getByRole('tab', { name: '自选', exact: true }).click();
    await page.getByRole('button', { name: '行情 AAPL', exact: true }).click();
    await page.getByTestId('chart.plot').waitFor();
    await page.evaluate(() => {
      function component(name) {
        const element = document.querySelector('#root');
        const key = Object.keys(element).find(key => key.startsWith('__reactContainer$'));
        let root = element[key];
        while (root.return) root = root.return;
        const stack = [root.stateNode.current];
        while (stack.length) {
          const fiber = stack.pop();
          if (fiber.type?.name === name) return fiber.memoizedProps;
          if (fiber.child) stack.push(fiber.child);
          if (fiber.sibling) stack.push(fiber.sibling);
        }
        throw Error(`Missing mounted ${name}`);
      }
      const state = () => component('StockDetail').state;
      if (!state().isDemo) throw Error('Isolated demo mode required');
      const history = component('MarketChart').history;
      const indices = [400, 500];
      const fills = indices.map((index, i) => ({ id: `qa-fill-${i}`, symbol: history.symbol,
        side: i ? 'SELL' : 'BUY', time: history.candles[index].time + 1000,
        price: history.candles[index].close, quantity: 1 }));
      const fixture = { phase: 0, reads: 0, fail: false, inFlight: 0, maxInFlight: 0,
        state, indices, revision: state().revision };
      const broker = state().broker;
      const original = broker.orders.bind(broker);
      broker.orders = async id => {
        fixture.reads++;
        fixture.maxInFlight = Math.max(fixture.maxInFlight, ++fixture.inFlight);
        try {
          if (fixture.fail) throw Error('simulated transient read failure');
          const values = await original(id);
          return [...values, ...fills.map((fill, i) => ({ id: `qa-order-${i}`,
            symbol: fill.symbol, side: fill.side, kind: 'LIMIT', quantity: 2,
            status: fixture.phase > i ? 'PARTIALLY_FILLED' : 'WORKING',
            filledQuantity: fixture.phase > i ? 1 : 0,
            remainingQuantity: fixture.phase > i ? 1 : 2,
            executions: fixture.phase > i ? [fill] : [],
            cancelable: true, editable: true, isSimpleEquity: true }))];
        } finally { fixture.inFlight--; }
      };
      window.markerFixture = fixture;
    });
    // Simulate the existing immediate post-submit read: accepted, not filled yet.
    await page.evaluate(() => window.markerFixture.state().refresh());
    const revision = await page.evaluate(() => window.markerFixture.state().revision);
    assert.equal(await page.getByTestId('chart.execution.400.BUY').count(), 0);
    await page.evaluate(() => { window.markerFixture.phase = 1; });
    await page.getByTestId('chart.execution.400.BUY').waitFor({ timeout: 8000 });
    // Poll failure must retain confirmed markers and recover without a refresh.
    await page.evaluate(() => { window.markerFixture.fail = true; });
    await page.waitForFunction(() => !!window.markerFixture.state().ordersError, {}, { timeout: 8000 });
    assert.equal(await page.getByTestId('chart.execution.400.BUY').count(), 1);
    await page.evaluate(() => { window.markerFixture.fail = false; window.markerFixture.phase = 2; });
    await page.getByTestId('chart.execution.500.SELL').waitFor({ timeout: 8000 });
    assert.equal(await page.getByTestId('chart.execution.400.BUY').count(), 1);
    assert.equal(await page.evaluate(() => window.markerFixture.state().revision), revision);
    assert.equal(await page.evaluate(() => window.markerFixture.maxInFlight), 1);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.waitForTimeout(300);
    const reads = await page.evaluate(() => window.markerFixture.reads);
    await page.waitForTimeout(5500);
    assert.equal(await page.evaluate(() => window.markerFixture.reads), reads);
    assert.deepEqual(errors, []);
    console.log('PASS: delayed B/S fills update without refresh; failures retain markers; no chart revision, overlapping reads or polling after leaving.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
