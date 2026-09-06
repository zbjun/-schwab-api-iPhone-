# Schwab implementation reference

Checked 2026-09-06. Scope: personal, manually entered equity/ETF orders, order management, quotes and price history. This research used public documentation/source only; no account credentials or live brokerage requests were used.

## Evidence and version limits

The [official Trader API product](https://developer.schwab.com/products/trader-api--individual), [trading specification](https://developer.schwab.com/products/trader-api--individual/details/specifications/Retail%20Trader%20API%20Production) and [market-data specification](https://developer.schwab.com/products/trader-api--individual/details/specifications/Market%20Data%20Production) returned JavaScript pages without readable schemas. They remain the authoritative locations for later verification.

Below, **maintainer source** means current `master`/`main` source from schwab-py or Schwabdev, which is primary evidence for those clients, not official Schwab documentation. **Generated source** means Chalupa-Tech's third-party OpenAPI-generated Go client. These moving branches can change; no third-party library is being adopted by THS.

## Accounts and order endpoints

Origin: `https://api.schwabapi.com`. Per-account paths use the returned account **hash**, never the displayed account number.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/trader/v1/accounts/accountNumbers` | Array of `accountNumber` and `hashValue` strings |
| GET | `/trader/v1/accounts/{hash}/orders` | Order array; empty array is valid |
| GET | `/trader/v1/accounts/{hash}/orders/{orderId}` | One order object |
| POST | `/trader/v1/accounts/{hash}/orders` | Complete new-order JSON |
| PUT | `/trader/v1/accounts/{hash}/orders/{orderId}` | Complete replacement JSON |
| DELETE | `/trader/v1/accounts/{hash}/orders/{orderId}` | No request body |

Maintainer source: [schwab-py client](https://raw.githubusercontent.com/alexgolec/schwab-py/master/schwab/client/base.py). Hash length is not established as a contractual constant; preserve the exact returned value, validate it as a safe path component, and associate it with the selected account.

List query names are **`fromEnteredTime`**, **`toEnteredTime`**, `maxResults`, and optional single `status`. Send both bounds as UTC ISO-8601, e.g. `2026-09-01T00:00:00.000Z`. The generated source describes a default 3000 results; do not represent a capped result as complete account history. [Generated query model](https://raw.githubusercontent.com/Chalupa-Tech/go-schwab-api-individual/main/models/operations/getordersbypathparam.go).

Date-limit uncertainty: [schwab-py documentation](https://schwab-py.readthedocs.io/en/latest/client.html#accessing-existing-orders) says the start must be within 60 days, while the [generated orders implementation](https://raw.githubusercontent.com/Chalupa-Tech/go-schwab-api-individual/main/orders.go) says maximum range one year. A recent 30/60-day view fits both descriptions. The current broker limit and older working GTC-order visibility remain unverified.

## Equity order payload

Example only, not a request to trade:

```json
{
  "orderType": "LIMIT",
  "session": "NORMAL",
  "duration": "DAY",
  "orderStrategyType": "SINGLE",
  "price": "100.00",
  "orderLegCollection": [{
    "instruction": "BUY",
    "quantity": 1,
    "instrument": {"symbol": "AAPL", "assetType": "EQUITY"}
  }]
}
```

`SELL` closes a long holding. A market order uses `MARKET` and omits `price`; the maintainer templates use `DAY` and `NORMAL`. [Equity templates](https://raw.githubusercontent.com/alexgolec/schwab-py/master/schwab/orders/equities.py).

GTC is encoded **`GOOD_TILL_CANCEL`**. Equity legs use `EQUITY`. `NORMAL` selects the regular session; other enum values exist but their currently accepted combinations are outside this implementation reference. [Order enums](https://raw.githubusercontent.com/alexgolec/schwab-py/master/schwab/orders/common.py). ETFs appear as equity subtypes in the [generated asset-subtype model](https://raw.githubusercontent.com/Chalupa-Tech/go-schwab-api-individual/main/models/components/equityassetsubtype.go); do not send `ETF` as the order-leg asset type.

The maintainer recommends a decimal **string** for price. Do not silently round/truncate a user's instruction. Accepting whole shares and a limited precision is a THS product constraint, not proof that Schwab never supports fractional or more precise orders. [Price representation](https://schwab-py.readthedocs.io/en/latest/order-builder.html#price).

## Responses, cancellation and replacement

The generated implementation expects GET `200`, POST `201`, PUT `201`, DELETE `200`. Successful mutations need not contain JSON. PUT creates a replacement order; do not assume the old ID identifies the new order. [Generated orders implementation](https://raw.githubusercontent.com/Chalupa-Tech/go-schwab-api-individual/main/orders.go).

`Location` normally has the form `https://api.schwabapi.com/trader/v1/accounts/{hash}/orders/{numericId}`. The maintainer validates the returned hash against the requested account and allows a missing location. THS should additionally require the exact origin/path shape and avoid following a response URL blindly. [Location parser](https://raw.githubusercontent.com/alexgolec/schwab-py/master/schwab/utils.py).

Fields used by the order UI include numeric `orderId`, `price`, `quantity`, `filledQuantity`, `remainingQuantity`; string type/session/duration/status fields; timestamps; optional `cancelable`/`editable`; `orderLegCollection`; and execution activities. Decode absent values as unavailable and retain unknown status strings. [Generated order model](https://raw.githubusercontent.com/Chalupa-Tech/go-schwab-api-individual/main/models/components/order.go), [maintainer response examples](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/docs/pages-raw/api.md).

THS implementation decisions, not broker guarantees:

- Show an acknowledged request separately from a filled/canceled order; refresh order detail for the actual state.
- Never automatically replay POST/PUT after timeout, missing ID, malformed response or uncertain delivery. First reconcile using account orders. A missing location is not evidence that no order exists.
- Require explicit broker `cancelable == true` or `editable == true`, with fresh detail, before enabling the corresponding action. Pending cancellation/replacement remains pending.
- Until partial-fill replacement quantity semantics are verified, permit replacement only for supported, unfilled, single-leg orders. Rebuild the complete request rather than resending response-only fields.

Schwabdev also exposes `POST /trader/v1/accounts/{hash}/previewOrder`; this is separate from local confirmation and actual placement. A local estimate must not be labeled broker validation. [Maintainer client source](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/schwabdev/client.py).

## Price history

GET `/marketdata/v1/pricehistory`: `symbol`, `periodType`, `period`, `frequencyType`, `frequency`, optional `startDate`/`endDate` in **epoch milliseconds**, `needExtendedHoursData`, `needPreviousClose`. [Maintainer client source](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/schwabdev/client.py).

| Display preset | periodType | period | frequencyType | frequency |
| --- | --- | ---: | --- | ---: |
| 1 trading day | day | 1 | minute | 1 |
| 5 trading days | day | 5 | minute | 5 |
| 1 month | month | 1 | daily | 1 |
| 3 months | month | 3 | daily | 1 |
| 1 year | year | 1 | daily | 1 |

There is no `week` period type. Month periods allow 1/2/3/6 and daily/weekly frequencies; year allows 1/2/3/5/10/15/20 with daily/weekly/monthly; minute frequencies allow 1/5/10/15/30. These are parameter presets, not data-availability guarantees. [Maintainer history reference](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/docs/pages-raw/api.md).

Provide a deliberate end time: the raw endpoint's documented default is the previous trading day. With explicit start and end, omit `period`; the maintainer prose and helper implementation conflict on whether it should be included. Do not infer live ticks or current-session completeness from a successful history request. [Client history documentation](https://schwab-py.readthedocs.io/en/latest/client.html#price-history).

The result contains `symbol`, `empty`, `candles`, and optional previous-close fields. Candles contain numeric open/high/low/close/volume and a millisecond `datetime`. Empty candles need an empty state, not invented prices. Preserve missing previous close. [Generated candle-list model](https://raw.githubusercontent.com/Chalupa-Tech/go-schwab-api-individual/main/models/components/candlelist.go), [maintainer example](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/docs/pages-raw/api.md).

## Quotes and timing labels

The quote envelope includes `assetMainType`, optional `assetSubType`, `symbol`, `realtime`, optional `quoteType`, and `quote`/`reference`/`regular` groups. Treat the returned asset type as authoritative for the instrument rather than guessing from the ticker. [Generated equity response](https://raw.githubusercontent.com/Chalupa-Tech/go-schwab-api-individual/main/models/components/equityresponse.go).

`quote.securityStatus` is a string, not a verified closed enum. `quoteTime`, `tradeTime`, `bidTime` and `askTime` are distinct millisecond timestamps. Preserve this distinction; a fresh bid is not necessarily a fresh last trade. [Generated equity quote model](https://raw.githubusercontent.com/Chalupa-Tech/go-schwab-api-individual/main/models/components/quoteequity.go).

THS UI interpretation: `realtime` and a value such as `Normal` do not establish that the exchange is currently open or that a quote is recent. Display broker timestamps and local fetch time separately. Label measured HTTP intervals **行情读取耗时**, **历史数据读取耗时**, **订单请求回执耗时**. None measures exchange execution latency or guarantees the next request's performance. This distinction is an implementation decision; no live trading latency measurement was made for this reference.

## Still requiring device/broker verification

Current official schema/version; real account and market-data permissions; older working GTC-order coverage; partial-fill replacement quantity semantics; accepted precision and duration/session combinations; missing-Location handling in current production; price-history current-day coverage; actual iPhone connectivity and request timings. These limitations do not prevent fixture-based UI and request/response tests, but those tests cannot prove live brokerage behavior.

## 验证工具资料 — Xcode UI tests and screenshot export

Checked 2026-09-06 against Apple documentation, Apple/Swift build-engine source and GitHub runner documentation. This section supplies implementation inputs, not a claim that the new UI target has already run successfully.

### XCTest screenshot retention

Attach `XCTAttachment(screenshot: app.screenshot())`, assign a useful `name`, set `lifetime = .keepAlways`, then call `add(attachment)` from the test. The default deletes attachments from successful tests. [Apple attachment guide](https://developer.apple.com/documentation/XCTest/adding-attachments-to-tests-activities-and-issues), [Apple keepAlways reference](https://developer.apple.com/documentation/xctest/xctattachment/lifetime-swift.enum/keepalways).

### Export and artifact commands

Apple documents the modern `export attachments` command, introduced in Xcode 16, and directs users to its built-in help for exact arguments/output. The Apple web page does **not** provide the complete export argument table. Capture the installed Xcode 26 tool's help in CI before relying on optional flags. [Apple Xcode 16.3 release notes](https://developer.apple.com/documentation/Xcode-Release-Notes/xcode-16_3-release-notes).

```sh
xcrun xcresulttool help export attachments
xcrun xcresulttool export attachments \
  --path artifacts/THSTests.xcresult \
  --output-path artifacts/ui-screenshots
```

The complete command above is also used by [Sentry's own FaultOrdering project](https://github.com/getsentry/FaultOrdering#accessing-results); that is maintainer usage evidence, **not Apple documentation**. Exact behavior on the pinned Xcode 26.6 runner is to be confirmed by its help/output. Export all retained attachments so successful screenshot tests are included; do not add a failure-only filter.

Run export after the test step with an always-run condition, only when the `.xcresult` directory exists. Upload the whole export directory so image files and any generated metadata remain together. Keep the original `.xcresult` separately for diagnosis. GitHub's first-party artifact documentation supports named directory uploads and explicit retention. [GitHub artifact guide](https://docs.github.com/en/actions/tutorials/store-and-share-data).

```yaml
- name: Export test attachments
  if: always()
  run: |
    if [ -d artifacts/THSTests.xcresult ]; then
      xcrun xcresulttool help export attachments
      xcrun xcresulttool export attachments --path artifacts/THSTests.xcresult --output-path artifacts/ui-screenshots
    fi
- name: Upload UI screenshots
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: THS-UI-screenshots
    path: artifacts/ui-screenshots
    if-no-files-found: ignore
    retention-days: 7
```

### Minimal UI target shape

Apple's Swift build-engine [Darwin product specification](https://raw.githubusercontent.com/swiftlang/swift-build/main/Sources/SWBApplePlatform/Specs/DarwinProductTypes.xcspec) identifies `com.apple.product-type.bundle.ui-testing`. It enables `USES_XCTRUNNER`, declares `IsUITest`, and adds `XCTContainsUITests` to the test bundle's plist. Let the product type supply these defaults instead of treating it as a hosted unit-test target.

The upstream [iOS UI-test build test](https://raw.githubusercontent.com/swiftlang/swift-build/main/Tests/SWBBuildSystemTests/UnitTestBuildOperationTests.swift) uses a UI-test target with `TEST_TARGET_NAME` set to the app target name, its own bundle identifier/plist/source phase, and an explicit dependency on that app. It does not set hosted-unit-test `TEST_HOST` or `BUNDLE_LOADER`. The [XCTRunner producer](https://raw.githubusercontent.com/swiftlang/swift-build/main/Sources/SWBTaskConstruction/TaskProducers/OtherTaskProducers/XCTestProductTypeTaskProducer.swift) constructs the separate runner application.

THS mapping: UI target `THSUITests`; product `THSUITests.xctest`; `TEST_TARGET_NAME = THS`; unique `PRODUCT_BUNDLE_IDENTIFIER`; `GENERATE_INFOPLIST_FILE = YES` (or a real target plist); matching iOS deployment target/Swift version; only UI-test sources in its source phase; explicit target dependency on `THS`. Add the target to the shared scheme's test action and build-for-testing configuration. Encoding that dependency as `PBXTargetDependency`/`PBXContainerItemProxy` is the project's Xcode-file representation; Apple does not publish a complete `.pbxproj` schema in the pages reviewed.

### Simulator and signing limits

GitHub's [macOS 26 arm64 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md) currently lists `/Applications/Xcode_26.6.app` with iOS 26.5 simulator support. Retain the pinned `DEVELOPER_DIR` and choose an available concrete simulator UDID. The required destination shape is `platform=iOS Simulator,id=...`, not `generic/platform=iOS`; Apple documents simulator test destinations in [TN2339](https://developer.apple.com/library/archive/technotes/tn2339/_index.html).

Use the existing simulator invocation with `CODE_SIGNING_ALLOWED=NO` and, if needed, `CODE_SIGNING_REQUIRED=NO`; GitHub documents that these disable signing for command-line builds. [GitHub Swift build guidance](https://docs.github.com/en/code-security/tutorials/customize-code-scanning/prepare-code-for-analysis). That page concerns CodeQL compilation, so it is not proof that every UI-test runner can execute unsigned. Confirm build, runner launch, UI assertions and screenshot export in this CI run. If signing becomes a simulator-specific failure, inspect the actual Xcode error and runner settings before changing them. A successful simulator run does not validate physical-device signing, Keychain entitlements, Safari authorization or brokerage network behavior.
