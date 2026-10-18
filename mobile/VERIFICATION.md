# 2026-10-06: Missing device connection recovery (source only)

> Commit IDs in these notes predate the 2026-10-18 history rewrite; see the old → new list at the top of `server/DEPLOYMENT.md`.

- Live shared-server status checks succeed for both device keys: configured/authenticated=true, reauthorizationRequired=false and unresolvedOperation=false. The phone screenshot has blank local connection fields; its local loss cause is unverified.
- Added explicit recovery from the personalized IPA resource even after the one-time import flag. Startup still respects an explicit disconnect. Recovery preserves an existing device identity; storage errors propagate and failed restores can retry.
- Connection UI distinguishes absent configuration from unreadable storage, offers recovery when a valid bundled configuration exists, and shows OAuth actions only after a local connection is configured.
- Two new regression tests failed before the change and pass after it. All 287 mobile tests, TypeScript and web export pass. Changed bundledServer.ts/test, device.ts and ServerConnection.tsx. No dependencies, server deployment or IPA build were needed; physical iPhone restoration is not verified. Existing 0.6.4 packages require manual re-entry of the matching private device configuration for immediate recovery.

# 2026-09-28: 0.6.4 (11) release build

- Expo build `c6c99824-d602-4eba-beba-0389322f15d1` completed successfully for `ths-expo-personal`, version 0.6.4/build 11. One cloud build supplies both device variants.
- Local checks: 285 mobile tests, 51 server/integration tests, TypeScript and six packaging fixtures passed. Archive inspection verified 88 allowlisted mobile files and excluded server vaults and personal/device credentials.
- The matching server release `optimization-20260928` passed 115 tests on Linux before activation. Deployed broker/gateway/market/archive hashes match local source. `/activity` forwarding is active, both device sessions remain authenticated without uncertain operations, and a live read-only account request succeeds.
- Physical iPhone interaction, real trade latency/fills and live account-event entitlement are not verified. Both personalized IPAs passed ZIP/path, arm64 physical-iPhone, version/build, embedded Hermes and server-config checks. Every original archive entry is byte-identical to the cloud artifact; only the distinct validated device configuration was added. Each package is about 8.3 MB and requires user signing. SHA-256: device1 `a5606167fbb5c3e46a53bfa96a7ff52d726b8632c2cdf7da0ce2f02a5562a96e`; device2 `82e11f2de53e01048857a1ccc356079827a7344122960ae1dc5154b6f81de0f5`.

# 2026-09-28: Authorization recovery, atomic quick orders and event synchronization (source only)

- Broker GET 401 performs one coordinated access-token refresh and one read retry. Only a definitive refresh `invalid_grant` clears authorization. Concurrent and delayed-401 tests, disconnect/configure generation tests and refresh-age migration tests pass; brokerage writes are never replayed.
- Atomic quick orders reuse the existing validation/write functions under the broker and gateway write locks. An actual `ServerBroker -> gateway -> SchwabBroker` loopback fixture verifies four validation GETs plus one POST, compared with eight GETs plus one POST for the ordinary two-stage flow. Freshness is checked again after token renewal and durable marker persistence; a failed unsent-marker cleanup remains blocked as unknown.
- Account activity uses the shared socket and authenticated `/activity` long polls. Notifications coalesce and trigger REST reconciliation, including trailing events during a read. Completion-aware polling retains error backoff. Two actual client adapters receive events, and disconnecting one does not interrupt the other. Stream rejection/timeout, reconnect, duplicate/unknown messages and desired-symbol delta acknowledgments use fake-socket tests.
- Observed minute retention uses a separate encrypted vault, bounded symbols/bars/age, periodic flush, and explicit collection symbols. Tests cover restart restore, missing-night additions, REST corrections, partial/provisional data, invalid volume, missing minutes, cross-midnight observations and persistence failure. Retention is not proof that Schwab supplies every overnight minute.
- Validation: 285 mobile unit tests, 41 server tests and 10 loopback integration tests passed (336 total); mobile and server TypeScript checks, Node syntax checks, `git diff --check` and Expo web export passed. No lint script or linter dependency is configured; no dependency was added.
- No real order, live account-event permission, physical-phone latency, production deployment or IPA build was tested/performed. Existing installed 0.6.3 remains unchanged. Server deployment must include `/activity` in the HTTPS reverse proxy before using the updated client; optional `collectSymbols` and `diagnostics` are documented in `server/README.md`.

# 2026-09-22: Order submission latency

- Root cause: prepare and submit each perform fresh account, quote, account-hash and order checks. Orders previously waited for every independent read; accepted submissions then waited for a full status/accounts/watchlist/orders refresh before releasing the form. Validation count and submission freshness are intentionally retained.
- broker.ts now starts orders and optional replacement detail as soon as the fresh account hash arrives, overlapping slow accounts/quotes. Deferred regression failed on the original scheduling and passes for prepare/submit and new/replacement orders. Five read-failure cases confirm no write or operation marker is created.
- useTrading.ts adds generation-guarded background post-trade reconciliation; TradePanel.tsx uses it after acknowledged submit/cancel and local strategy termination. Account and order results apply independently, read errors retain accepted receipts, and no watchlist/history reload is initiated. The action's final status reconciliation still runs, and later submissions still validate fresh balances/reserved shares at the broker.
- Local TypeScript, 254 mobile tests, 28 server tests and web export passed. tools/verify-post-trade-sync.cjs verifies completion before delayed reads, independent updates, error/receipt separation and stale account response suppression in isolated browser demo state. No live orders were used.
- Read-only live sample before deployment: status 994 ms cold / 18 ms warm, accounts 717 ms, quotes 399 ms, orders 798 ms. These are individual RPC observations, not measured order-to-acknowledgement or fill latency.
- Server staged at /opt/ths-gateway/releases/latency-20260922; 79 broker/server tests passed under deployed Node. Only freshContext was replaced in the deployed broker, preserving the pre-existing history decoder invocation. Graceful stop/start switched the current symlink; previous release retained. Verified deployed broker SHA-256 794a8c41a43b8c4f0149b11ecbfb42411027a606cfbe1302107ca2821dc5630f, service active, both devices authenticated with no unresolved operation, and account read succeeds.
- Server change is live for existing server-mode clients; client background-refresh change requires a later IPA. No IPA built, no physical-device latency or real-trade/fill-time claim.

# 2026-09-11: 0.6.3 (10) two-device IPA delivery

- Source: `cc19367`; EAS build `776e920e-b860-4a3c-b0fd-528f8fccfd33` finished successfully. Includes the price-priority engine/settings, unified primary tabs, automatic execution markers and order-row stock navigation described below.
- Local TypeScript, 252 mobile tests, 6 personalizer tests, web production export and whitespace checks passed. The cloud also passed TypeScript and all 252 tests before Xcode reported ARCHIVE SUCCEEDED.
- Audited 86 upload files against local source; no device keys or legacy client credentials included. The build commit's 84-file trailer was a counting typo; the audit checked 86 files. No dependencies changed; package-lock root name/version metadata now matches package.json.
- Generated only two deliverables locally: device 1 and device 2. Both are version 0.6.3, build 10, arm64 physical iPhone archives, minimum iOS 16.4, with a 2,146,787-byte embedded Hermes bundle. Each retains every original archive entry byte-for-byte and adds only its validated server device configuration. Distinct device keys connect to the same server; no private packages are uploaded to GitHub.
- SHA-256 device 1: `29b2f727508ff0fe3045af806162a6c63474b9e32eb67f1ea654394320f97033`.
- SHA-256 device 2: `36b9922457e972661f95c273188e0ae814f6e2c2513da35b4dcad56895dbd473`.
- Signing and physical iPhone installation remain user-side and untested here. No real trades were placed. Server authorization freshness and live fill quality were not revalidated during packaging.

# 2026-09-11: Order-row stock navigation (source update, no IPA)

- OrderList in the Orders tab now routes a single valid stock symbol through App's existing openStock navigation. Tapping the order body/chevron opens that stock's chart; Back returns to Orders. Complex or invalid symbols keep the order-detail path instead of opening an invalid chart.
- Added an explicit order-detail action and moved the existing detail/cancel/replace controls beneath the selected row, eliminating the previous offscreen expansion at the end of the list. Reused the existing guarded read and action handlers; cancel-only panels still open order details, never trigger cancellation from a row tap.
- TypeScript, all 252 tests, whitespace check and web export passed. Browser checks in both themes at 390/509px verified AAPL row navigation, returning to Orders, selected-row inline expansion, collapse and retained modify control; no browser errors or document overflow. Visual review score 96, screenshots under ignored artifacts/order-navigation. No real trading, physical iPhone verification or IPA build.

# 2026-09-11: Automatic execution-marker synchronization (source update, no IPA)

- Root cause: post-submit refresh reads an accepted order once, but later fills were never fetched while viewing a chart. StockDetail already recalculates execution markers when shared orders change; no chart redraw workaround or synthetic fill is needed.
- useTrading now refreshes orders while a chart or Orders tab is visible and the app is foreground/authenticated. Reads wait 2 seconds after completion with unfinished orders, 5 seconds otherwise, and back off on errors using the existing serial polling utility. Background/leave cleanup suppresses late results. Read-only polling can observe partial fills while a local strategy remains active.
- Reused the account reader's generic serialization for orders. Manual refresh, post-trade refresh and account selection share the order reader with generation/epoch guards; pre-operation or other-account responses cannot overwrite newer snapshots. Background sync retains existing markers during read errors and does not increment the chart history revision.
- Verification: TypeScript, all 252 mobile tests, web export and diff checks passed. Added tools/verify-order-marker-sync.cjs as a development-browser regression (Playwright supplied via PLAYWRIGHT_MODULE, optional BROWSER_EXECUTABLE). In isolated demo mode it verifies delayed BUY and SELL partial-fill SVG markers without refresh, transient read failure/recovery, no duplicate markers, unchanged chart revision, serialized reads and no polling after leaving the chart. Independent read-only review found no actionable defects.
- No real orders or physical iPhone tests; visibility in real accounts depends on when Schwab returns execution details and the corresponding candle being available. No IPA built.

# 2026-09-11: Price-priority local execution (source update, no IPA)

- Replaced midpoint-plus-slippage pricing with spread placement: BUY starts at bid + configured fraction of spread; SELL starts at ask - that fraction. Defaults to 25%. After the first child rests for the configured interval, the strategy permanently permits midpoint placement. BUY rounds down and SELL rounds up to valid price increments; neither crosses its current target at submission.
- Fixed adverse boundary remains anchored to the initial midpoint. Favorable and adverse changes both require the resting interval and minimum tick change before cancel/reorder. Default interval 5 seconds, minimum 2 ticks; default stop thresholds are midpoint movement exceeding 0.5% within observed rolling 3 seconds and spread/midpoint exceeding 1%. These are adjustable engineering starting values, not backtested optimal parameters. Stops cancel remaining orders and never automatically restart.
- Preparation quotes also pass spread/jump checks; a frozen order that became more aggressive than its new target is stopped before submission. Existing confirmed-cancellation, partial-fill, ambiguous-write, context and deadline protections are retained. No broker protocol or dependency added.
- Settings contains all seven parameters; existing boundary/duration are preserved, while old stock-price slippage is discarded instead of being misread as a spread percentage. TradePanel reuses the shared validated preferences and displays a summary rather than duplicate parameter inputs.
- Verification: all 252 mobile tests passed, including 31 execution/DemoBroker tests; TypeScript, web export and diff checks passed. Independent read-only review found no actionable regression. Browser checks passed on 320/390/760px in both themes, preference save/reload and invalid-input handling, and both ordinary and quick-mode simulated submission followed by confirmed timeout cancellation. No browser page errors. Visual review score 95; screenshots under ignored artifacts/price-priority.
- No real orders, physical iPhone execution or fill-quality/backtest validation. No IPA build. Foreground sampling cannot guarantee cancellation after process termination or network loss; current broker order state remains authoritative.

# 2026-09-11: Consistent primary tabs (source update, no IPA)

- Account, Watchlist, Trade, Orders and Settings now share a left-aligned 28-point title in a 64-point header, 16-point side margins, 8-point content inset, rounded surface cards and the same system-theme background. Removed the empty large-title toolbar, the fake 54-point web top inset and the account card's extra 35-point gap.
- Removed primary-tab toolbar refresh buttons. Account, Watchlist, Trade and Orders share one native refresh control and the existing serialized refresh lock; Trade also refreshes its selected quote. Settings contains local preferences and has no data-refresh action. The account's foreground automatic refresh remains intact. Stock-detail navigation and its dedicated refresh action remain available.
- Browser screenshots reviewed for all five tabs in both themes. Automated assertions passed for 30 tab/theme/width combinations (320, 390 and 760 pixels): equal title placement and header height, visible content, no primary-header refresh buttons and no document overflow. Mounted refresh callbacks were exercised on all four data tabs using isolated demo state; watchlist edit/add controls passed; no browser page errors.
- Visual QA caught and fixed a RefreshControl wrapper that dropped ScrollView-injected children on web; all injected props are now forwarded. Physical iPhone pull recognition remains unverified because RN-web does not implement the native pull gesture.
- TypeScript and all 250 tests passed; web export (329 modules) and diff check passed. No dependencies added, no real trades and no IPA build.

# 2026-09-11: Midpoint slippage and settings-only controls (source update)

- Local-market pricing now uses `(bid + ask) / 2`, adding configured percentage slippage for buys and subtracting it for sells. Both sides must be finite, positive and non-crossed; missing or invalid sides stop the strategy without substituting last trade or a one-sided quote. Locked quotes remain valid.
- Each chase uses the latest midpoint; slippage is not compounded. The adverse price boundary stays anchored to the initial midpoint and includes slippage. Existing tick rounding, elapsed limit, partial-fill accounting and confirmed-cancellation-before-resubmit behavior remain intact. A target inside the spread can wait for a fill; no immediate fill is promised.
- Settings contains the local-market slippage, price boundary and chase duration. The trade ticket only displays parameter summaries. Older stored boundary/duration can be restored, but missing slippage requires explicit input, including an explicit zero if desired.
- This is newer source than the delivered 0.6.2 (9) IPA. Per user request, no IPA is built for this adjustment and no real order is placed.
- Verification: TypeScript and all 250 tests passed, including midpoint pricing, fixed-boundary chasing, invalid two-sided quotes, legacy preference migration and serialized saves. Web export succeeded (333 modules); `git diff --check` passed. Browser automation was unavailable (`nodeRepl.fetch request failed`), so visual interaction and physical iPhone behavior remain unverified.

# 2026-09-11: 0.6.2 (9) personal iPhone delivery

- EAS `2e194572-3afa-4e6e-8bad-a919e61651fa` finished successfully from source `050067f`. Free subscription, 12/30 aggregate builds before submission, zero accrued cost; no paid usage enabled. Upload audit: 83 files identical to local source, new local-market/account-refresh modules included, no known private values.
- Cloud TypeScript and 240 tests passed. Public IPA verified as arm64/iphoneos, minimum iOS 16.4, embedded 2,133,197-byte Hermes bundle. Bundle string checks confirm local-market settings/order kind and account-refresh status. Public SHA256 `5cd595411556575fdb263554d1a9c597bce7a55a0a8ee8b94dbe09830c27f0bd`.
- Device configurations injected only locally. Both personal IPAs preserve all original ZIP entries byte for byte, add only their own connection resource, and pass IPA verification. Device 1 SHA256 `f8c446af8ad79dc444da9b67f36709bb983eb10357ddafb9b4375aabbd617f05`; device 2 `55124ce0293adabb7af88facc18f04457434db58717396e1e7f045622b647b25`. Packages remain ignored local artifacts and require user signing.
- Read-only status checks with both actual device configurations returned authenticated=true and unresolvedOperation=false before delivery. No real brokerage writes were performed. Physical signed installation, foreground/background behavior, and real local-market execution remain unverified.

# 2026-09-11: 0.6.0 shared-server personal iPhone packages

- EAS build `e1d49219-f31a-436a-9d9f-7da30bc60c1f` finished: 0.6.0 (7), arm64 iPhone, embedded 2,100,233-byte Hermes bundle. One Free-plan cloud build; no paid plan enabled. Upload inspection covered 76 files with exact source match and no known private values; market preview JSON files stayed local.
- First startup imports version-2 bundled server origin/device key into SecureStore and selects server/real mode. Existing server identity wins over the bundle. Import markers prevent reactivation after explicit disconnect; failed preference persistence can retry. Direct credentials are not imported from a server resource. No dependency added.
- 208 mobile tests, TypeScript, 6 local IPA packaging tests and whitespace checks passed. Actual ServerBroker instances bootstrapped independently with both private device files and each read authenticated=true from the live server, without a Schwab login. Physical iPhone Keychain, signed installation and startup remain to be tested by the user; no real order was sent or cancelled.
- Public archive SHA256: `2ffaabeb0706489413f4b449ed0aab5d1b258a64b6138117f2f581e1e437d2b9`. Device 1: `4e3543d21c4ac967675c9cfa8a591c7df350d9dbc1d0305b463723b917acfa71`. Device 2: `61cc07156120fdf9668cec5270aeb167d5310152c853790316bf623139859052`. Both private packages were generated only locally, require user signing, and contain distinct server device keys, not Schwab secrets/tokens. ZIP and Mach-O verification passed; private resource equality and byte-for-byte preservation of all original entries passed.
- Read-only live capture now confirms QQQ 432 and SNDK 471 one-minute bars on NY September 9 20:00 through September 10 03:59. Both render with purple night shading through the existing MarketChart in the development-only history preview. SNDK's following night and SNDU's recent nights were absent in those responses; no replacement candles were fabricated. Snapshots are not live streaming. Server authorization is now confirmed; older pending-authorization records below are historical.

# 2026-09-11: Preserve received QQQ night bars across sparse refreshes

- User evidence: QQQ one-minute IPA chart shows September 9 postmarket adjacent to September 10 premarket, with no night bars between. This is evidence of a displayed gap, not proof of an upstream omission or of the refresh defect being its cause. The specific night's raw response remains unavailable because shared OAuth is awaiting the developer app's `Modification Pending` status to clear.
- Reproduced a concrete client defect with fictional QQQ bars at the matching dates: decoding and rendering retain night timestamps, but `shareHistory` previously erased them if the next successful REST response omitted those timestamps. The regression failed before the change (2 bars instead of 4).
- `marketRefresh.ts` now reuses previously received, non-provisional minute/intraday bars only inside the new successful response's bounds and within ten days. Source symbol/known period must match. Added cache entries cannot increase the merged result beyond 15,000 bars; a larger fresh broker response is not trimmed. New broker corrections always win. Empty/first-load history is not seeded, and calendar/60/120-minute aggregation is not patched with incompatible cached bars. This is in-memory retention within the mounted view, not a historical data provider or disk cache.
- `types.ts`, `orderRules.ts`, `broker.ts`, and `historyCoverage.ts` carry original response count and deduplicated observation counts before larger-period aggregation. `StockDetail.tsx` exposes a snapshot via the existing info control, comparing NY day/session counts with full chart observations and identifying retained/forming bars. Calendar candles do not claim night coverage from their timestamps. Native share opens the user's share sheet with only symbol, range, times and counts; no credentials, account data or raw broker body are included. Reports state that absence does not establish zero trades or trading eligibility.
- Reused the existing history merge and information control; no new dependency, request, polling loop, or synthetic candle was added.
- Final checks: TypeScript, all 204 mobile tests and 28 local server tests passed. Regression coverage includes corrections, no first-load fabrication, source/period isolation, cache budget/age/window limits, NY winter offsets, pre/post aggregation diagnostics, refreshed evidence and calendar semantics. iOS JS/Hermes export passed (777 modules). No lint script exists; whitespace checks passed.
- Browser control returned `nodeRepl.fetch request failed`; the diagnostic layout/share sheet and real iPhone behavior remain visually unverified. No new IPA was built, no real orders were placed, and these changes have not been deployed to the running server. They do not prove restoration of the specific QQQ or SNDU night absent on the phone.

# 2026-09-10: Shared server deployed, awaiting account activation

- Deployed gateway release `303757f` to the existing personal Linux server with isolated, checksum-verified Node v24.21.0. Added an unprivileged systemd service and exact HTTPS Nginx routes, preserving the website's root route. Deployment templates and evidence are in `../server/DEPLOYMENT.md`.
- All 35 server/integration fixtures passed on that runtime. Both real device keys passed public HTTPS readiness checks using the actual mobile ServerBroker class. Keyless and browser-origin requests were rejected; invalid callback, log suppression, loopback binding and graceful restart/vault preservation checks passed.
- Existing Client ID/Secret are stored on the server; distinct device configurations were written only to ignored, ACL-restricted local files. No keys, vaults, account data or OAuth URLs were committed.
- Fresh shared status is configured=true, authenticated=false. Developer callback registration still needs confirmation and one official user login. The browser-control connection failed, so it could not perform the portal change. Physical device migration, authenticated brokerage queries/market streaming and order behavior remain unverified. No IPA was built and no real order was submitted or cancelled.

# 2026-09-10: Locate extended sessions and retain observed minutes

- Rechecked the minute-history path: requests already set `needExtendedHoursData=true`; decoder and renderer retain valid overnight timestamps. The September 8 SNDU/QQQ raw-response comparison in `OVERNIGHT-DIAGNOSTIC.md` is historical evidence, not a fresh statement about today's coverage. No current authenticated diagnostic process was available; this change does not claim restored upstream SNDU history.
- The chart's existing session legend now locates the most recent loaded night/premarket/regular/postmarket session. It shows observed dates and counts so an older night cannot be mistaken for last night. Missing sessions show the loaded time range and a retry suggestion; the message remains available during daytime. The default latest-120 view, zoom/drag, crosshair, and return-to-latest remain available. Line charts report coverage without changing their full-range view.
- Observed stream minutes use a shared bounded merge (10 days / 15,000 bars). Same broker/symbol foreground transitions and fallback retain the current view's observations; changing source resets them. Gaps behind the latest REST bar can use actual retained observations within the loaded history window. Completed REST candles take precedence, and provisional OHLC/unknown volume remain explicitly provisional. No interpolation, disk cache, alternate provider, new dependencies, or empty-history seeding was added; closing the detail view/App still loses its in-memory observations.
- TypeScript, 196 mobile tests and 35 server/integration tests passed (231 total). New fixtures cover a 480-minute night across midnight, older night dates, winter offsets, missing sessions, more than two hours of observations, bounds, authoritative REST replacement and larger-period aggregation. iOS JavaScript/Hermes export passed (776 modules); no IPA built. No lint script exists; `git diff --check` passed.
- Browser demo verified light/dark layouts, absent-night message, premarket navigation from the last 120 bars to the earlier 330-bar session and return to latest. This is demo UI evidence, not real Schwab data or physical iPhone verification. No real orders or fresh OAuth flow were initiated.
- Desktop Node microbenchmark (50 warm runs, 10,000 REST bars): 120 retained bars median 1.39ms / p95 2.15ms; 10,000 retained median 3.29ms / p95 4.23ms, cold 70.34ms. A 10,000-observation gap-fill case was median 3.04ms / p95 4.56ms. Timezone caches and indexed lookups avoid repeated per-bar linear REST searches; these figures are not an iPhone frame-time guarantee.

# 2026-09-10: Central server authorization for two devices

- Added `server/` using Node built-ins only. One SchwabBroker owns authorization, concurrent refreshes and the durable unknown-operation marker. AES-256-GCM vault writes are serialized and atomic; a process lock rejects a second owner. Offline reconciliation requires an explicit operator flag after checking Schwab, and cannot run alongside the server.
- Each device has an independent bearer key. The gateway exposes an explicit RPC allowlist, binds frozen one-use reviews to the originating device, serializes preparation/writes, rejects browser origins, and never returns broker credentials. The registered HTTPS callback can complete authorization on the server; returning from the browser to the App refreshes status. Automatic browser close/deep-link return is not implemented.
- Added Settings connection transport selector and ServerBroker. Server-mode restoration does not initialize direct authorization or seed bundled Schwab credentials. Forgetting the device connection is local only. Shared market long-poll preserves the existing quote/chart callbacks, handles abort/release/retry, and uses one upstream socket for the union of active symbols. TTL and bounded buffers release idle resources. Refactored the existing stream parser rather than adding a second decoder or dependencies.
- Integration found and fixed optional JSON RPC arguments becoming null: ordinary order preparation must omit an absent replacement ID. Actual ServerBroker -> local HTTP gateway -> actual SchwabBroker tests cover this path, unmodified server order snapshots, OAuth state/replay, one token refresh for two clients, independent disconnect, and shared market delivery. All upstream brokerage responses and credentials in these tests are fictional.
- TypeScript check and 188 mobile tests passed. 28 server tests plus 7 cross-client integrations passed (35 total). Actual `server/init.mjs` and `server/start.mjs` startup smoke verified loopback-only authenticated status and encrypted storage without contacting Schwab. No lint script is configured; diff whitespace checks passed. Node emits an existing module-type performance warning when importing mobile TypeScript.
- iOS JavaScript/Hermes export passed (775 modules); this does not build/sign an IPA. Browser demo verified the shared settings page at 402x874 in light/dark appearance, with web credential entry/actions disabled and an empty error log. Build iOS Apps skills are installed but no XcodeBuildMCP simulator tool is callable in this Windows session.
- Not deployed: actual server address/SSH access/HTTPS setup are still missing. Live Schwab callback registration, two physical devices, native SecureStore/background behavior and real trading remain unverified. No real orders, paid/cloud builds, or IPA were created. Deployment and migration steps: `../server/README.md` and `MULTI-DEVICE.md`.

# 2026-09-09: Settings and optional quick trading

- Connection is nested under Settings. Quick mode defaults off, persists in local AsyncStorage, and its switch is unavailable until preferences load or while an action is pending. Settings follows the existing palette and uses a dependency-free vector icon.
- Quick buy/sell skips only the UI review: the same broker prepare/submit chain still checks funds, holdings, order state, account identity, context generation, and snapshot expiry. It reuses the shared action lock and does not retry uncertain writes. Single-order cancellation has its own explicit button; row taps remain detail navigation. Replacement keeps review.
- TypeScript and all 174 tests passed, including six quick-order regressions for frozen identity, preparation failures, context changes, wrong identity/expiry, and unknown outcomes. No lint script exists; git diff --check passed.
- Browser demo at 402x874: Settings and nested connection navigation, off-by-default switch, preference survives full reload, one-click AAPL buy and sell each create one pending order, one-click cancellation removes that order from the cancelable list (3 to 2), and disabling quick mode restores the confirmation page. Dark/light layouts inspected; browser error log empty. Test preference restored off and demo reset afterward.
- OAuth automatic return is not implemented: the fixed loopback HTTPS callback does not satisfy Expo's custom-scheme session callback or Apple's associated-domain HTTPS callback requirements. Awaiting a user-controlled HTTPS callback address before registering and integrating a return route. Current manual flow remains usable.
- No new dependencies, real brokerage writes, cloud builds, or IPA. Physical iPhone and live quick orders remain unverified. Changes simplify confirmation navigation, not broker validation.
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
# 0.6.1 急速下单修复

- 服务器核对时间原先直接与手机时间比较；离线集成测试复现了时钟偏差导致急速下单在 submit 前失败。ServerBroker 现在以本机请求开始时间供界面计算有效期，服务器仍独立执行到期、设备归属和一次性提交检查。
- 急速下单按钮旁显示处理状态和提交回执；提交成功后清空数量及金额。后续读取失败保留订单号，不把刷新失败误报为提交失败，不自动重试交易。
- 本地验证：212 项 mobile 测试、9 项中央网关集成测试、TypeScript、6 项 IPA 配置注入测试、git diff --check 均通过。集成测试仅使用虚构账户和 loopback 模拟券商。
- 用户确认先前查询到的成交来自关闭急速模式后的普通下单；这些成交不构成急速模式成功的证据。手机此次具体失败原因尚无错误文本，不能断言均由时钟偏差引起。
- 浏览器验证工具本次连接失败，未完成 iPhone 界面/真实急速交易验证。未向真实账户提交、修改或撤销任何订单。
# 0.6.2 账户自动更新（源码）

- 账户页可见且 App 在前台时自动读取余额和持仓，每次请求结束后等待 5 秒；离页/后台停止，重新进入立即读取，错误时退避至最多 60 秒。
- 复用串行轮询工具，默认行情刷新节奏不变。账户读取按刷新代际去重并串行化；交易开始、切换账户或连接后，旧响应不能覆盖新数据，交易后的刷新不会复用交易前的余额。
- 账户页移除顶部刷新按钮，改用原生 RefreshControl 下拉刷新；后台轮询不锁住导航或交易按钮，页面显示最近更新时间和读取失败状态。
- 216 项 mobile 测试及 TypeScript 通过。没有真实交易测试；原生下拉手势待手机验证。
- 0.6.1 build 8 IPA 在这项需求到达前已完成，仅包含极速模式修复；0.6.2 尚未构建 IPA。本地市价自动追价的后续实现见下方记录。

# 0.6.2 自定义本地市价追价（源码）

- 买卖订单类型新增本地市价单，价格边界为相对启动时卖一（买入）/买一（卖出）的最大不利偏离百分比，时长为秒；两个输入初始留空，用户填写后保存在本设备 AsyncStorage。允许 0%（不接受更差价格），百分比须小于 100%，时长为 1–3600 秒整数。
- 复用 Broker 的账户核对、一次性 Prepared 和交易结果不明锁，不扩展券商订单类型或增加依赖。普通模式展示参数核对后启动，极速模式直接启动；固定初始边界和截止时间，不随新报价滚动放宽。真实执行要求实时且 10 秒内的买卖报价，时钟偏差也可能触发拒绝。
- 对尚未成交的部分监测报价，在边界内以 LIMIT/DAY 委托模拟市价追价。只有旧委托确认撤销且成交数量完整核对后才提交剩余股数；部分成交、撤单时成交、拒绝、外部修改、重复/缺失订单号以及网络结果不明都有独立停止路径。收到撤单回执不等同于撤单完成。
- 报价/状态轮询串行，追价至少间隔 2 秒；到时、超界、手动停止或失去当前上下文时停止追价并核实撤单。确认最多轮询约 15 秒，超时明确显示待核实和订单编号。前台执行不保证杀进程/断网后的自动撤单，不在下次启动恢复追价；最终以券商记录为准。此功能不扩展券商支持的交易时段。
- UI 只按当前订单类型展示对应回执，输入错误也显示在按钮附近。浏览器控制工具本次仍返回 nodeRepl.fetch 失败，未完成视觉或实体 iPhone 手势验收。没有真实交易，也没有构建 IPA。
- 验证：240 项 mobile 测试、TypeScript、Web 导出、iOS Hermes 导出、git diff --check 通过。新增 23 项追价状态机测试和 1 项实际 DemoBroker 买卖/盘后/超时撤单集成测试；所有成交、报价及撤单测试均为模拟数据。项目没有独立 lint 脚本。
