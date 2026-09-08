# 0.4.2 visual restoration in Expo · 2026-09-07

## Authenticated overnight history coverage · 2026-09-08

- Supersedes the earlier lack of authenticated evidence: three direct `pricehistory` GETs completed at 14:56 UTC, after local OAuth. SNDU/App parameters returned 8,281 valid unique bars; SNDU/explicit 10-calendar-day window returned 4,190; QQQ/App parameters returned 11,836. All HTTP 200, zero malformed or duplicate bars. Report contains only public-symbol date/session counts, no credentials or account information: [OVERNIGHT-DIAGNOSTIC.md](OVERNIGHT-DIAGNOSTIC.md).
- SNDU has overnight bars on August 25–31, but zero on September 1–4 in both queries. QQQ has 453/453/442/224 overnight bars on those four dates. Both return zero overnight bars for September 8 as of the request. Thus this API can return overnight observations, while the tested recent SNDU data is absent upstream of the app decoder. The underlying coverage/schedule/correction cause is unverified; do not generalize this into API-wide lack of overnight support or assert trading eligibility.
- No app behavior changed, no real order writes, no IPA build. Read-only diagnostic tests previously passed (19); documentation whitespace check passed. Earlier build notes remain chronological records.

## Compact inline trade ticket · 2026-09-08 (local only)

- `src/TradePanel.tsx`: reduced inline padding/gaps and account header; moved session and duration onto one row and amount/share switch beside the quantity label. Kept actionable bid/ask prices, maximum quantity, order review and cancel flow. Removed growing space before submission; shortened repeated explanatory text. No dependencies or broker-write changes.
- `src/StockDetail.tsx`: chart allocation now uses measured ticket content height, capped at 382px, so short/cancel panels return space to the chart. Longer forms scroll independently below the chart; keyboard layout remains bounded.
- TypeScript and all 168 existing tests passed; `git diff --check` passed. Browser QA at 402×874 and 375×812 verified compact buy/sell/cancel views, bid/ask price fill, maximum 40-share sell quantity, amount-based 1000 USD preview producing four shares, and selecting premarket resetting GTC to DAY. Demo review only, no orders submitted or canceled; browser error log empty.
- No IPA build, cloud submission or version change. Physical iPhone keyboard/installation remains unverified for this layout revision.

## User-authorized personal configuration bootstrap · 2026-09-08

- EAS build `f43d56e6-5e22-49a0-9cf6-ae6910af466b` finished, version 0.5.5 (6). Public archive verified without configuration. Local personalized output `../artifacts/THS-0.5.5-personal-unsigned.ipa`: 8,237,231 bytes, SHA256 `fbcee686d7838bd09ec550abf2c229ad44a2b4b4edf91c34fa418ab8ab7d66f1`. Explicit private verifier passed ZIP, version, arm64 iOS, 2,033,785-byte Hermes bundle and root credential resource. Private resource matches the local configuration; every original archive entry is byte-identical; raw Secret is absent from public archive entries. Requires user signing. Includes the quote-ticket changes from 0.5.4.
- User explicitly chose full Client ID/Secret in their private IPA and accepted extraction risk. Cloud build still contains no private configuration. `scripts/personalize-ipa.py` injects only the versioned application credentials into `Payload/THS.app/THSPersonalConfiguration.json` locally, before user signing. Tokens/account passwords are not included. The original public IPA is preserved; output must be new. `verify-ipa.py` rejects bundled configuration by default and requires explicit `--allow-personal-config` to validate the private artifact without printing credentials.
- `personalConfiguration.ts`, `device.ts`, `useTrading.ts`: first iOS startup reads `Paths.bundle` (installed Expo file-system maps this to Bundle.main.bundlePath), then uses existing broker validation and Keychain persistence. Existing credentials/tokens win. An import marker prevents explicit reset being undone on restart. Missing resource preserves public/Expo Go behavior. New installs with configured credentials choose real mode; an existing demo preference is preserved. Parsing is shared with manual file import. No new dependencies.
- `Connection.tsx` now says configuration is ready for account authorization and explains private packages contain app credentials. Account authorization remains interactive.
- TypeScript and 168 JavaScript tests passed, including first bootstrap, existing authorization preservation, reset behavior, persistence failure retry, missing bundle, bounded parsing and non-leaking errors. Four Python packaging tests passed for injection, explicit verifier opt-in, original preservation, unsafe ZIP rejection, overwrite/re-injection rejection and controlled error output. Physical iPhone first launch remains unverified.

## Quotes in the trade ticket · 2026-09-08

- EAS build `0fa6d7d2-f50f-421f-81ba-86760784c192` finished. `../artifacts/THS-0.5.4-unsigned.ipa` is version 0.5.4 (5), 8,236,876 bytes. ZIP, bundle ID, physical iOS arm64 and embedded 2,030,007-byte Hermes bundle verified. SHA256 `d65a384a311e2277e2cd1b31d3fe78c2611c80839cc915dded9fd3d2a668fd1c`. User signing required; personal configuration remains absent.
- `src/TradePanel.tsx` reuses the existing quote prop to show bid/ask inside both buy and sell entry forms, with quote timestamp and explicit demo labeling. Previously quotes were only in the detail statistics hidden behind the ticket. No additional fetches, subscriptions or timers. Size is not available in the current model and is not fabricated.
- Positive finite quotes for the same symbol can fill LIMIT/STOP_LIMIT price on explicit tap, preserving up to four decimals. Missing/zero/mismatched quotes show a dash; market/stop-only forms and busy tickets cannot fill. Quote arrivals do not overwrite the user's price. Existing price-change review invalidation applies.
- TypeScript and all 164 tests passed. At 402 x 874, both prices are visible under buy/sell tabs with the chart above; clicking ask filled 234.86 for buy, clicking bid filled 234.84 for sell. No browser console errors. No actual orders sent; iPhone native keyboard behavior not tested.

## Explicit order sessions · 2026-09-08

- EAS build `0262e0b6-a6d5-46bc-8fee-27d0ca53b5ce` finished: `../artifacts/THS-0.5.3-unsigned.ipa`, version 0.5.3 (4), 8,236,198 bytes. ZIP, bundle ID, physical iOS arm64 and embedded 2,028,568-byte Hermes bundle verified. SHA256 `e63355c88031c760e1114060cf64f559323a6665ebc7887e4a80b0800bb42d39`. User signing required; no personal configuration embedded. Physical installation and live brokerage acceptance not exercised.
- Root cause: `encodeDraft` hardcoded NORMAL and the frozen broker review discarded session. `types.ts`, `orderRules.ts`, `broker.ts` and `TradePanel.tsx` now carry a selected NORMAL / AM / PM / SEAMLESS value through validation, review and submission. Existing drafts default to NORMAL. Extended sessions require LIMIT; AM/PM require DAY, SEAMLESS permits DAY/GTC. Unknown/night session strings are rejected. Changing session clears the review; extended selections visibly use LIMIT and AM/PM clear GTC. No new dependencies.
- Existing extended orders remain cancellable with the previous guards. Replacement remains restricted to supported normal-session orders, and may not change the original session. Demo edit availability mirrors that restriction (`demo.ts`).
- 164 tests and TypeScript passed, including intercepted BUY and SELL writes for all three extended sessions, frozen-review preservation and rejected invalid combinations. Phone-size 402 x 874 browser verified postmarket BUY/DAY and continuous extended SELL/GTC review labels. Chart remains visible; no console errors. No real orders submitted.
- Session enum reference: [schwab-py OrderBuilder implementation documentation](https://schwab-py.readthedocs.io/en/latest/order-builder.html#session-and-duration). [Schwab extended-hours overview](https://www.schwab.com/stocks/extended-hours-trading) confirms limit-only extended sessions. Public Trader API specification was not readable; overnight API order support and real account acceptance remain unverified. SEAMLESS is not advertised as overnight/24-hour trading.

## Overnight observation handling · 2026-09-08

- EAS build `09275bca-50df-457a-917a-3201b634c2a2` finished. `../artifacts/THS-0.5.2-unsigned.ipa` is version 0.5.2 (3), 8,235,106 bytes; ZIP integrity, physical iOS arm64 binary, bundle ID and embedded 2,026,515-byte Hermes bundle passed verification. SHA256 `0b8dd0e463916cd0293700b1bd72769c941d0c9dee543173b69f15eedec328f8`. Requires user signing; personal configuration is absent. No physical iPhone or live overnight response verification.
- Confirmed client defect: the 04:00–20:00 day-session calendar rejected observed overnight trades in live overlays and 60/120-minute aggregation. REST 1/5/15/30-minute history already requested extended hours and did not filter overnight timestamps; missing bars there cannot be attributed to this client filter alone.
- `chartData.ts`: separate observation windows classify actual 20:00–04:00 New York data as overnight, split aggregation at local midnight, cache by day, and preserve sparse observed candles without inventing minutes or volume. Daytime trading calendar/permissions remain unchanged. `liveHistory.ts` consumes those windows; daily/weekly/monthly provisional updates still only include regular-session trades. `tradeMarkers.ts` uses matching observation sessions.
- `MarketChart.tsx` adds the purple overnight legend and shading for returned overnight candles. `StockDetail.tsx` reports missing current-night data instead of presenting an old chart as current. This is absence of returned data, not proof the API never supports overnight.
- 162 tests passed, including summer/winter boundaries, midnight, sparse 60/120-minute aggregation, live quotes and authoritative minutes, no fabricated volume, regular-only calendar candles, and missing-data status. TypeScript and whitespace checks passed. Phone-size 402 × 874 browser check shows four session keys without overlap; no console errors.
- Live Schwab overnight response could not be inspected: phone authorization is unavailable locally and the previous local auth helper is not running. Public [Schwab 24/5 documentation](https://www.schwab.com/learn/story/what-to-know-about-245-trading-on-thinkorswim) describes thinkorswim eligibility, not overnight coverage of pricehistory/CHART_EQUITY/LEVELONE_EQUITIES. No real brokerage writes performed.

## Standalone IPA 0.5.1 (2) · 2026-09-07

- EAS build `41574d68-a6d8-43dd-bf91-bcc49e8253c5` finished successfully, including current chart centering and gesture fixes and all intervening source changes. Submission uses `EAS_NO_VCS=1`, `EAS_PROJECT_ROOT` set to the absolute mobile directory and `EXPO_NO_DOTENV=1`, so mobile's upload allowlist is applied at its intended root. No paid plan enabled or signing credentials uploaded.
- Version/build updated in app.json and the existing unsigned build scripts/workflow; mobile's gitignore now explicitly includes the EAS workflow despite the ancestor build/ rule.
- `../artifacts/THS-0.5.1-unsigned.ipa`: 8,233,525 bytes. ZIP integrity, bundle ID, version/build, physical iOS arm64 binary and embedded 2,024,392-byte Hermes bundle passed verification. SHA256 `39dc4554a9163891a64afaed8e03e2703c215a1ea6fc7bdc913d0ea751b05e72`.
- Requires user signing. Physical iPhone installation and live brokerage behavior were not exercised. Personal configuration is not embedded.

## Visible candle price scale · 2026-09-07

- `chartData.ts` and `MarketChart.tsx`: candle ranges derive their vertical scale from visible candle highs/lows with symmetric padding, recomputed on pan, zoom and incoming candle changes. Moving averages, executions and cost overlays cannot expand that scale. In-range cost retains its dashed line; out-of-range cost is an explicitly arrowed edge label, not a line at a misleading price. Line charts also exclude cost/execution overlays from scaling.
- Two regression tests cover excluding off-screen extremes, changing visible highs, flat prices and empty input. All 158 tests and TypeScript passed.
- At 402 × 874, one-minute demo candles fill the chart vertically with balanced margins both at the latest range and after panning to 9427–9547. Cost 221.30 remains labelled below the visible 234.98–236.54 range. No console errors; visual verdict 96. Physical iPhone check remains outstanding.

## Chart drag and page scroll arbitration · 2026-09-07

- `src/MarketChart.tsx`: ordinary candle panning and pinching now hold the existing parent scroll lock for the entire gesture. Viewport updates cancel the press timer without unlocking an active drag. Release, rejection, cancellation, period/size changes, web blur and unmount share the unlock path. Active drags cannot rearm the long-press timer.
- `src/chartGesture.ts` / `src/chartGesture.test.ts`: sticky axis intent tolerates initial finger jitter; clear vertical swipes yield to page scrolling. Three tests cover axis retention, diagonal thresholds and the inspection/drag lock union. `src/StockDetail.tsx` enables iOS directional scroll locking. No dependencies or polling added.
- Full suite: 156 passed; TypeScript and `git diff --check` passed. No dedicated lint script is configured.
- Browser demo at 402 × 874: diagonal horizontal drags moved the window from latest 120 candles to 4–124, then 47–167; parent scrollTop stayed 0. After release, normal scrolling reached scrollTop 113 with overflow auto. Long hold displayed a crosshair and a following tap dismissed it; no browser console errors.
- Physical iPhone touch arbitration and two-finger pinch require device validation; desktop pointer checks do not prove native iOS touch behavior. Existing IPA was not rebuilt.

## Latest adjustment: signed percentage

`StockDetail.tsx` now shows the selected percentage instead of the timestamp below the main price. `marketStatistics.ts` reuses chart history: intraday/five-day use the chart previous-close baseline; candle periods use the immediately preceding candle close. Missing or nonpositive references display —. Red/green follows this same percentage. Timestamp remains below the plot. Added two baseline/missing-data tests in `marketStatistics.test.ts`; 82 tests and TypeScript pass. Browser verified +1.63% in red and -0.96% in green; screenshot: `../artifacts/crosshair/selected-percent.png`.

## Follow-up: long-press crosshair

- `src/MarketChart.tsx`: reuses existing selected-candle/crosshair rendering; 450 ms hold activates continuous horizontal selection. The selected candle now drives the main top-left price and a time caption; the former in-chart badge was removed. A subsequent short tap clears the crosshair and restores the latest quote. Ordinary pan and pinch clear inspection; release preserves the selected candle. Web mouse events use the same controller; blur, lost buttons, cancellation and unmount clear pending timers and scrolling locks.
- `src/StockDetail.tsx`: temporarily disables the parent scroll while inspecting.
- `src/chartPress.ts` and `src/chartPress.test.ts`: one dependency-free press controller, shared across mouse/touch. Eight deterministic timer tests cover hold threshold, motion tolerance, continuous selection, release, cancellation, stale deadline replacement, tap dismissal and renewed hold without dismissal.
- 80 tests and TypeScript pass; local iOS Hermes export passes (758 modules). Browser checks verify price/time matching selected crosshair, normal pan after selection, zoom, and 402 × 874 layout with no console errors. Screenshot: `../artifacts/crosshair/daily-light.png`.
- Header price and dismissal verified in the browser: daily selection 248.30 -> tap -> latest 234.85; intraday selection 230.12 -> period switch -> latest 234.85. Inline order limit stays at the current 234.85 while inspecting history. Screenshot: `../artifacts/crosshair/header-price-selected.png`.
- Physical iPhone long-hold/drag and multi-touch arbitration still require device validation; browser automation verified click selection/normal dragging, not a physical finger hold.

## Restoration

Restored the native 0.4.2 screen composition in the existing Expo client: centered headers, floating five-tab capsule, grouped account/order/connection cards, compact watchlist rows, underlined chart periods, and the inline buy/sell/cancel form. System light/dark appearance remains automatic on iPhone.

## Changed files and reuse

- `App.tsx`: native-style navigation, trade quote card, shared watchlist search/view state.
- `src/Accounts.tsx`, `src/Watchlist.tsx`: extracted screen views with original card/table hierarchy; returning from detail preserves search and multi-chart mode.
- `src/ui.tsx`, `src/Icon.tsx`, `src/DemoNotice.tsx`: shared native palette, controls and small SVG icons, with no new dependency.
- `src/StockDetail.tsx`, `src/MarketChart.tsx`: quote summary, period menu and chart presentation; existing session, moving-average and viewport algorithms reused.
- `src/TradePanel.tsx`, `src/Connection.tsx`: grouped forms and inline trading; existing broker, authentication and explicit order confirmation remain in use.
- `.gitignore`: excludes the local restoration verification export.

## Current verification

- TypeScript check and 72 existing tests pass.
- Final local iOS Hermes export passes (757 modules, `dist-restore-ios/`); this is a JavaScript bundle check, not a signed IPA or device test.
- Browser review at 402 × 874 covers all five tabs and both light/dark market screens. Reference screenshots: `../artifacts/preview-0.4.2/`; restored screenshots and evidence: `../artifacts/restore-0.4.2/`.
- All six minute periods, daily/weekly/monthly candles, five-day line, MA5/10/20/30 and pre/post-market shading remain available.
- Browser zoom changed visible daily bars from 62–181 to 79–164; horizontal drag moved to 53–139; closing the trade panel preserved that window.
- Inline chart remains above trading. A $1,000 budget at $234.85 converts to 4 shares and a $939.40 review; maximum sell returned 40 demo shares. Cancel confirmation for demo order #901 was reached without submitting it.
- Multi-chart mode and search survive detail return and tab switches. Fresh browser console reported zero errors after the decorative SVG accessibility fix.
- No real broker writes and no cloud builds were performed. Existing trading/account fixtures were used without changing their behavior.

The visual comparison passes at 92/100. Expo approximates the native capsule surface; it does not reproduce the exact iOS Liquid Glass material. Windows text rendering also differs from iOS. Physical iPhone pinch/keyboard behavior, real OAuth, and live Schwab connectivity still require device validation; local exports do not prove these.

---

# Earlier 0.5.0 migration verification · 2026-09-07

## Result

Expo / React Native client is runnable in Expo Go, with a live Metro manifest advertising `exposdk:57.0.0` and the iOS launch asset at `<LAN-IP>:8081`. No EAS or GitHub build was requested for this migration.

## Evidence

- TypeScript strict check passes for the complete project.
- 72 Node fixture tests pass: 38 broker/order tests, 22 chart/calendar/viewport tests, 10 demo/account reservation tests, 2 volume-statistics tests.
- Expo Doctor: 21/21 checks pass; Expo package version check passes.
- Local iOS Hermes export and web export pass. These are JavaScript build checks, not IPA signing or iOS UI tests.
- Browser at 402×874: watchlist and sparklines, extended-hours line chart, 60-minute candles and MA, horizontal drag, zoom buttons/latest reset, chart retained above inline trading, simulated order preview/submit/replace/cancel, order status changes, and web-only demo restriction verified.
- Browser console error list empty at the end of the flow. Screenshots and test/export logs are in `../artifacts/expo-0.5.0/`.
- Saved Client ID/Secret absent from all 41 checked mobile source/export files. Private import JSON validated separately; values were not printed. File and exports are ignored by Git.
- Source review confirmed `expo/fetch` iOS supports `redirect: error`, so the strict broker transport does not rely on React Native's default fetch redirect behavior.

## Main files and reuse

`App.tsx`, `src/StockDetail.tsx`, `src/TradePanel.tsx`, `src/Connection.tsx` replace SwiftUI view implementations for Expo Go. `src/broker.ts` and `src/orderRules.ts` preserve direct API/OAuth and single-use order safety. `src/MarketChart.tsx`, `src/chartData.ts`, `src/marketStatistics.ts` port chart calculations and session rules. `src/useTrading.ts` restores app mode/watchlist and rejects stale reads; `src/device.ts` handles SecureStore and private file import. `src/demo.ts` shares quote/chart data and reserves buying power for simulated open orders.

The app uses local state for its five tabs instead of adding a navigation dependency. Shared session/viewport functions are reused by chart rendering, aggregation, demo data, and statistics. No SwiftUI files or existing IPA artifacts were replaced.

## Remaining physical-device checks

Expo Go on the user's iPhone has not yet been opened in this session. Real OAuth login, direct Schwab networking, real account permissions, native keyboard layout, native multi-touch arbitration/performance and secure-store persistence across actual app termination remain to be tested on that phone. No real order has been placed, changed or canceled.

The UI labels order-size estimates; the original 30-day / 200-order query limit remains and may omit older GTC orders. Missing provider fields are not synthesized. Pre/post-market charts do not enable extended-hours orders. The existing 2026–2028 trading calendar is static and does not include emergency closures. Upstream build-tool audit warnings are recorded in `../artifacts/expo-audit.json`; forced downgrading to Expo 46 was rejected.
# 2026-09-07: Order loading and sellable shares

## 2026-09-07: Forming-candle motion

- `marketStream.ts` now accumulates every received eligible realtime trade before 250 ms UI coalescing. Optional forming-candle callbacks preserve the first observed open and intrabatch high/low; quote-only bid/ask changes cannot create trades. `liveHistory.ts` merges these batches without resetting the minute open or inventing volume; authoritative minute candles still supersede provisional observations.
- `FormingCandle.tsx` / `candleMotion.ts` animate only the latest visible provisional candlestick body/wick for 140 ms. There is no idle animation loop or whole-history recalculation per frame. New ticks retarget from current displayed geometry, new minutes mount a new candle, and background/reduced-motion/unmount stop animation. Numeric readouts and order values remain actual observations, not interpolated pixels.
- Development-only browser fixture: `http://127.0.0.1:8081/?preview=forming`. `FormingCandlePreview.tsx` and the guarded App branch use explicitly simulated data and never run in the native trading UI. Browser verified 100 -> 105 -> 97 in one candle, fixed open100/high105/low97, then a second candle at102 after the minute boundary; exactly one animated candle node and no console errors.
- All 147 tests, TypeScript, local iOS Hermes export and whitespace checks pass. Added tests cover pre-coalescing trade extremes, two-minute batches, bid-only/delayed rejection, first-open retention, motion retargeting/cancellation/idleness and authoritative replacement. Real iPhone motion and live feed still require device verification; observed OHLC before full broker history arrives remains explicitly provisional.

## 2026-09-07: Push-first detail market data

- Added `marketStream.ts` and broker-owned subscription/auth lifecycle. Read `/trader/v1/userPreference`, validate a Schwab-owned secure WebSocket URL, authenticate and require matching acknowledgments for LEVELONE_EQUITIES and CHART_EQUITY. Credentials remain inside the broker/transport; disconnect/config invalidation closes active sockets. No dependencies or brokerage writes added.
- `useLiveMarket.ts` subscribes only the current foreground detail symbol. Updates coalesce in 250 ms batches (up to four UI updates per second), preserve partial quote deltas and minute corrections, and use bounded reconnect/heartbeat timeouts. A healthy stream stops frequent quote REST reads and reduces history reconciliation to once per minute; stream failure restores prior polling. Leaving detail/background closes the connection.
- `liveHistory.ts` overlays authoritative minute candles and explicitly provisional current-price observations across supported periods. Provisional volume is unknown, not fabricated; calendar candles exclude extended sessions. Late trades cannot replace completed minute candles. The UI labels forming estimates. This is not a guarantee that every exchange trade arrives or that provider latency is 250 ms.
- Cached bar-to-period lookup and chart time/session metadata avoid repeated calendar conversion for price-only updates. New bars preserve chart selection/gesture state. Local overlay-only benchmark with 9,600 bars/500 iterations: median 0.823 ms, p95 1.528 ms; excludes SVG rendering, phone power and network.
- All 139 tests, TypeScript and local iOS Hermes export pass. Fake sockets cover login/subscription ACK ordering, numeric IDs, pre-ACK snapshot retention, deltas, coalescing, corrections, foreign/malformed/stale data, reconnect and stop. Broker tests cover authenticated preference reads and disconnect. Browser demo retained viewport 79-164 and cost line through refresh, with no console errors.
- Real iPhone stream permissions, authenticated connectivity, actual feed cadence and power remain unverified. Protocol references are SDK authors' primary implementations, not a captured user response: https://github.com/alexgolec/schwab-py/blob/main/schwab/streaming.py and https://github.com/tylerebowers/Schwabdev/blob/main/docs/pages-raw/stream.md . Official developer streaming pages were inaccessible during verification.

## 2026-09-07: Foreground market refresh

- Previously StockDetail loaded once on entry/range/revision; it had no automatic polling. Added current-detail polling: quotes 2 seconds, intraday/five-day/minute history 10 seconds, day/week/month history 30 seconds while the existing calendar reports a trading session (including extended sessions). Closed sessions and demo use 60 seconds. Volume statistics use 60 seconds. Intervals are request cadence, not a guarantee of upstream freshness.
- AppState pauses scheduling when inactive/background and resumes immediately in foreground; leaving the detail disposes its polls. Each poll is serial with bounded error backoff; already running requests can finish after pause. Chart/statistics simultaneous history requests share a promise. Quote polling skips the optional instruments endpoint except initial/30-minute metadata refresh. Manual refresh still runs the existing account/order flow.
- `useLiveMarket.ts`, `marketPolling.ts`, `marketRefresh.ts` own the read lifecycle and unchanged history reuse. StockDetail reuses them; MarketChart is memoized so price-only updates do not redraw its SVG. No dependencies, broker writes or streaming connection added. Existing history/calendar limitations remain.
- All 108 tests, TypeScript and local iOS Hermes export pass. Tests cover serial polling, pause/resume/stop during in-flight reads, retry backoff, active/closed session cadence, history corrections/identity reuse, and quote-only endpoint reads. Browser demo preserved daily viewport bars 79–164 before/after refresh; console error log empty. Device power, native lifecycle and real-provider update latency remain unmeasured.

## 2026-09-07: Executed B/S markers and current average cost

- Decode actual EXECUTION/FILL legs with explicit instrument, time, price and quantity. Optional malformed execution metadata does not break order loading or cancellation. Duplicate fills are deduplicated; missing execution details are not inferred from order prices or timestamps.
- Map fills to minute/session or New York day/week/month candles, grouping same-bar fills by side with weighted prices. Draw B/S markers at execution prices and a horizontal dashed line for the current account's weighted holding cost. Both follow the existing chart viewport; compact watchlist charts remain unchanged.
- Reuse existing order reads (last 30 days, at most 200 orders), positions and chart coordinates. No dependencies added. Demo-only historical fills provide visible examples.
- All 99 tests, TypeScript and local iOS Hermes export pass. This export checks the JavaScript bundle, not a signed IPA. Browser at 402 x 874 verified intraday and daily markers, cost line, complete legends, zoom/pan visibility and latest reset. Browser error log empty. Screenshots: `../artifacts/trade-markers/`.
- Authenticated execution payloads and native iPhone rendering remain unverified. Only fills returned within the existing order window can appear; cost is the current holding average, not a historical cost series. No real order was submitted or canceled.

## Follow-up: reservation/cancellation incorrectly reused replacement eligibility

- Latest screenshot shows recognized holdings with an unresolvable open-order reservation. Inspection found `isSimpleEquity` required normal session plus supported replacement kind/duration and was reused for reservations and cancellation.
- Decode single-leg structure separately, retaining raw asset type/session. Compute share reservations for simple stock orders in extended sessions and for collective-investment orders with matching ETF quote evidence. Preserve strict replacement eligibility. Cancellation accepts single stock/collective-investment orders only with an actionable status and the broker's explicit `cancelable` flag, re-read immediately before the exact order-ID DELETE.
- The cancel pane now lists unfinished orders even when cancellation is disabled, with an explanation in the detail panel. Complex/linked orders, final/pending-cancel/pending-replace statuses and false/missing broker flags remain blocked. Missing remaining quantity still blocks sell sizing.
- 89 tests and TypeScript pass. New injected-transport tests exercise EQUITY/COLLECTIVE_INVESTMENT across NORMAL/AM/PM/SEAMLESS sessions, five-share reservation, strict replacement limits, exact DELETE path/no body, and blocked changed orders. All broker writes in these tests are intercepted by fixtures; no real trades/cancellations were performed.
- Browser demo at 402 x 874 verified list -> detail -> confirmation and scrolling to the confirmation button while keeping the chart visible. Did not press final confirmation. No browser errors. Screenshot: `artifacts/order-loading/cancel-review-mobile.png`. Device's exact open-order payload and actual cancellation remain unverified.

## Confirmed follow-up: SNDU is COLLECTIVE_INVESTMENT

- User's updated device screenshot confirms 25 held shares and raw position type `COLLECTIVE_INVESTMENT`. The earlier explicit ETF-label fix alone did not address this account response.
- Preserve quote `assetSubType`; recognize a collective-investment holding only with a same-symbol quote classified as `ETF` or `EQUITY` / `ETF`. Keep the raw position type. The UI and fresh broker preparation/submission use the same `isStockHolding` predicate and the same sell-sizing path.
- New regression initially failed. The passing fixture uses SNDU, 25 collective-investment shares, and an equity/ETF quote. Covers 25 available with no orders, 20 after a five-share reservation, oversized rejection, missing/wrong-symbol/non-ETF classification rejection, and revalidation before submission with no writes. All 87 tests, TypeScript, and diff whitespace checks pass.
- No real brokerage writes. Actual quote subtype and result after the device reload remain to be verified on the phone. Reference for quote subtype examples: https://github.com/altanalytics/schwabr/ .

## Follow-up: ETF holdings excluded by the sell filter

- New screenshots show both held and sellable shares as zero, no longer an unloaded order list. Found that the account page matches symbols while the sell pane and `maximumSell` discarded any position not labeled `EQUITY`.
- A shared `isStockAsset` predicate accepts explicit `EQUITY` and `ETF` labels for positions, read order legs, and executable quotes. Outbound stock/ETF orders retain their existing `EQUITY` contract. Unrecognized matched position types now yield unknown availability instead of silently counting zero, with the type displayed in the sell pane. Mutual funds/options/unspecified collective investments remain unsupported.
- Position quantity display now matches the account page independently from trade eligibility. Zero purchasing capacity explains the available buying power; changing sides clears stale action messages unless an operation outcome is unresolved.
- Two regression tests failed before the fix and pass afterward. ETF fixtures cover reserved shares, cancellable order recognition, fresh preparation, excess-share rejection, insufficient cash, unsupported types, and zero broker writes. All 86 tests and TypeScript pass.
- Browser at 402 x 874 verified the buying-power explanation, QQQ held 12 shares, Maximum, and side switching; no browser errors. Screenshot: `artifacts/order-loading/buying-power-mobile.png`. Physical device's exact asset type and authenticated retry remain unverified.
- Reference for distinct asset labels: https://pkg.go.dev/github.com/major/schwab-go/schwab#AssetType (SDK source, not a capture of the user's account).

- Reproduced a decoder failure with `enteredTime` ending in `+0000`: both new regression tests failed before the fix. Normalize compact offsets to colon-separated offsets before parsing (including fractional seconds and non-UTC offsets); malformed and timezone-less values remain rejected.
- Added a broker fixture with 25 held shares: a completed order leaves 25 sellable, an open sell for 5 leaves 20, and an unavailable order list leaves the estimate unknown. No broker writes in the regression.
- Order-load errors now retain controlled error messages and HTTP status instead of the combined generic refresh message. Unknown list counts no longer display as zero; sell panels separate held shares from the pending available estimate and provide refresh.
- `tsc --noEmit` and all 84 tests pass. At 402 × 874 in the web demo, the sell panel displays 40 held / 40 sellable and Maximum fills 40; cancel panel still lists the demo open order. Browser error log empty. Screenshot: `artifacts/order-loading/sell-mobile.png` at repository root.
- Physical iPhone authenticated response was not available in local tests. The timestamp issue is reproduced, but the user's exact failing response has not been captured; reload Expo Go and retry to establish whether it resolves that incident. No real orders submitted, changed, or canceled.
- Format reference: https://github.com/tylerebowers/Schwabdev/blob/main/docs/pages/api.html (SDK author's order response examples; not a capture of the user's response).
# 2026-09-07: Remove five-level depth (supersedes earlier depth entry)

- Removed five-level UI/toggle and row wrappers from `StockDetail.tsx`, book state from `useLiveMarket.ts`, and all book callbacks/subscriptions/ACKs/timers/decoding from `marketStream.ts`. Deleted unused `OrderBookPanel.tsx`, `orderBook.ts`, `orderBook.test.ts`, and three depth-only transport tests. Updated README. L1 bid/ask quotes remain in quote statistics.
- Existing stream test explicitly verifies only LEVELONE_EQUITIES and CHART_EQUITY subscriptions. Typecheck, remaining 153 tests and diff whitespace check pass. No book names/references remain under src. Reused the existing full-width chart, with no new dependencies or abstractions.
- 402×874 browser checks: intraday/day full-width chart, 336px gesture plot (previously 204px with sidebar), MA legends, cost/B/S overlays and crosshair summary update. Browser error log checked. No physical iPhone test or new IPA build; Expo Go/source receives this change. Visual verdict 97 in `.omx/state/remove-depth/ralph-progress.json`.

# 2026-09-07: Crosshair summary metrics

- `StockDetail.tsx` now switches the entire OHLC/previous-close/volume header to the selected candle, including compact trade-panel OHLC. It no longer falls back to today's volume when historical volume is absent. Selected price colors and percent share `selectedReferencePrice` in `marketStatistics.ts`; dismissal restores the latest quote summary.
- Selected-bar dollar turnover is explicitly labelled 额估 / 成交额估, calculated as OHLC arithmetic mean × volume, not actual traded notional. Selected turnover percentage uses selected volume / current shares outstanding, also labelled estimated; historical share counts are unavailable. Selected mode replaces today's volume-ratio slot with the amount estimate, keeps current market cap and PE under 市值今 / 市盈今, and timestamps the selection in New York time. Small positive turnover uses six decimals. Indicator help explains all definitions; no extra header rows, network calls or dependencies.
- Typecheck and all 165 tests passed. New regression cases cover changing candle volumes, real zero vs missing/invalid/forming volume, unknown shares, invalid prices and prior-bar baselines across daily/weekly/monthly/all minute periods. Browser desktop/day and 402×874 phone/day + 1-minute checks confirmed header values changed with selected candles and returned to live values after a normal click. Example minute selection: open 235.35 / high 235.46 / low 235.28 / close 235.42 / volume 2.21万 / amount estimate 520.94万 / turnover estimate 0.000146%. Browser error log empty. Visual verdict 96 in `.omx/state/crosshair-summary/ralph-progress.json`.
- Real account and physical iPhone gestures were not re-tested. No real orders and no cloud IPA rebuild. This fixes summary data binding and reuses existing chart selection callbacks; no gesture changes.

# 2026-09-07: Watchlist holdings and overnight reference badges

- `Watchlist.tsx`: shared normal/chart row uses theme accent for names and codes with nonzero finite holdings in the selected account, independently of asset classification. Prices retain up/down colors. Gold 24 reference badges and a dismissible legend show coverage/date/meaning; no new dependencies, subscriptions, or trading behavior.
- `overnightReference.ts` is a deliberately incomplete offline reference, **not** an entitlement/API result. 503 USD securities from the issuer's SPY holdings as of 2026-09-03 map to Schwab's policy covering S&P 500 components; this is index-derived inference. SPY, QQQ and TLT are examples pictured in Schwab's 24/5 marketing section, weaker than the authoritative thinkorswim roster. Files retrieved 2026-09-07; source URLs are in the module. SNDU and other unknown funds do not inherit eligibility from their underlying stocks.
- No accessible full Schwab roster or verified public API flag was found. Unmarked means unconfirmed, not unsupported. Reference badges expire 30 days after the recorded check date, with an update notice. Update the source snapshot only after rechecking the policy/issuer holdings or replacing it with an authoritative thinkorswim `Public > 24 Hour Trading` export. Do not use extended-hours candles or L1 fields as overnight eligibility evidence.
- Typecheck and all 162 tests pass. New tests cover reference provenance, unknown/related tickers, explicit class-share aliases, and stale/invalid time rejection. Browser checks: dark phone list/chart views and legend, light appearance. Visual verdict 95/100 in `.omx/state/watchlist-badges/ralph-progress.json`. Reused the existing row and palette; no extra polling. No new cloud IPA build or real broker order submitted. Physical iPhone and complete current overnight roster remain unverified.

# 2026-09-07: Five-level order book

- Added `orderBook.ts` / tests and `OrderBookPanel.tsx`; connected through `marketStream.ts`, `useLiveMarket.ts` and `StockDetail.tsx`. `MarketChart.tsx` wraps MA legends into two rows below 300px width. Existing stream is reused for one selectable NASDAQ_BOOK / NYSE_BOOK subscription, with independent acknowledgement and availability; depth rejection does not fail price/chart subscriptions. UI batches at the existing 250ms cadence.
- Full snapshots validate symbols, safe-integer timestamps and numeric price/volume fields. Sort bid descending/ask ascending and retain five levels; reject duplicates, malformed sides and oversized input instead of merging or inventing levels. No ×100 size conversion or mixing of venues. Old timestamps ignored; 30 seconds without a book marks the snapshot stale. Failure/background/source changes clear the applicable visible book; missing data only uses independently available L1 prices with unknown size. Explicitly labelled demo data never fills a real account's missing depth.
- 159 tests and TypeScript passed. Nine decoder tests plus three transport tests cover empty sides, malformed/duplicate/oversized data, sorting, source matching, independent ACK/denial/timeout, coalescing, stale marking and reconnect cleanup. Local iOS Hermes export passed; no new IPA generated.
- 402×874 browser checks: intraday five asks/five bids and quantity bars, NASDAQ/NYSE selector, daily MA legends, collapse restoring full width, and trade panel preserving chart and review button. Visual verdict 94/100 in `.omx/state/order-book/ralph-progress.json`. No real orders sent or canceled. Real account entitlements, actual subscribed symbol coverage and device depth feed have not been verified. API field evidence is the SDK author's source and fixtures, not an authenticated capture from this account or an official full-market guarantee.

# 2026-09-07: Chart proportions after IPA build

- Latest reference follow-up supersedes the two-column phone layout: all nine quote metrics now use three columns beside the headline on phones, removing both lower metric rows. Header labels shorten to 市盈 / 换手 / 量比 / 量; the estimate explanation remains available. Market caps at or above 1e12 display in 万亿. The default phone chart receives 36px extra height. Browser checks at 402×874 and 375×812 passed for intraday/daily charts and the expanded sell panel; typecheck and whitespace checks passed. Existing IPA remains unchanged.
- Follow-up: bounded the headline column to 144px on wide screens and 120px on phones; moved existing metrics beside price (three columns on wide screens, high/low and open/previous-close columns on phones). Other phone statistics remain below. Verified 1280×720 and 402×874 including expanded sell panel; visual verdict 95, typecheck passed. No new fields, dependencies or trading logic.
- `StockDetail.tsx` reduces headline price 44→32px (trade panel 28→24px) and raises the default chart section from 330–450px / 56% of available height to 420–650px / 65%. Compact quote strip is 64px instead of 72px, with a slightly larger chart allocation.
- Browser visual checks at 1240×1272 and 402×874: larger default price plot; compact intraday and daily MA charts stay above the sell panel, with the review action visible. Temporary viewport override reset. Typecheck and diff whitespace checks passed. Visual verdict 95/100 in `.omx/state/chart-proportions/ralph-progress.json` at repository root.
- Layout-only change; no new dependencies or data/gesture changes. Physical iPhone keyboard was not tested. The previously generated 0.5.0 (1) IPA predates this layout revision; web/Expo Go uses the updated source.

# 2026-09-07: Standalone Expo IPA 0.5.0 (1)

- EAS build `7cdad8d5-8ee5-418a-9ce3-7abad02e1734` finished successfully for `@fried_chicken_cn/ths-expo-personal`. Account was Free, with 4 of 15 iOS builds used before submission. No paid usage enabled and no signing credentials uploaded.
- Added `eas.json`, `.easignore`, `.eas/build/unsigned-ios.yml`, `scripts/build-unsigned-ios.sh`, and `scripts/verify-ipa.py`; app.json records the separate Expo project and build number. No new app dependencies or trading behavior changes. The custom build generates iOS with Expo prebuild and archives unsigned Release with Xcode.
- Upload inspection: 56 allowlisted files, exact source match, no personal credential values. Local and cloud typecheck plus all 147 tests passed. Archive succeeded. Final IPA ZIP integrity, app ID/version, physical iOS arm64 executable, embedded Hermes bytecode (2,016,818 bytes), and all eight embedded frameworks' device platforms passed. Scan against local personal credential values found no credentials in the IPA. Validator fixtures reject simulator, unsafe ZIP paths and private files.
- Output: `../artifacts/THS-0.5.0-unsigned.ipa`, 8,227,506 bytes. Local and cloud SHA256 agree: `8eda14f046a34414662b531182c843c99f3ef6537abe1d81c16ec852d4c45fea`.
- Requires user's signing before installation. Physical iPhone launch, third-party signing and authenticated streaming remain unverified. Expo Go's SecureStore is not shared with this standalone app; import personal configuration on first use. No real brokerage writes were performed.
