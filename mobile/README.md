# THS Expo / React Native · 0.5.5

最新源码包含紧凑买卖撤面板：报价可点选填价，时段与有效期并排，按金额入口位于数量旁，图表按面板内容调整空间。这部分修改未重新生成 IPA。2026-09-08 的真实 API 检查确认：SNDU 返回了较早的夜盘分钟线，但 9 月 1–4 日夜盘均为零根；同一参数下 QQQ 有对应夜盘数据。缺失段不能在客户端凭空补全，具体原因仍未确认；详见[原始数据覆盖检查](OVERNIGHT-DIAGNOSTIC.md)。只读诊断工具见 [`../tools/schwab-connect/README.md`](../tools/schwab-connect/README.md)。

这是新的 Expo / React Native 客户端。Windows 上运行 Metro，iPhone 用 Expo Go 扫码；日常 JavaScript、TypeScript 和界面修改使用 Fast Refresh，不调用 EAS、不消耗 iOS 云端构建配额。原来的 `../ios/` SwiftUI 项目和 0.4.3 IPA 保留。

界面已按原生 0.4.2 还原：居中标题、底部胶囊导航、分组卡片、自选列表和图下买卖撤。后来增加的盘前盘后、均线、缩放拖动均保留；验收记录见 `VERIFICATION.md`。

图表长按约 0.45 秒显示十字线；继续左右移动可逐根选价，左上角大价格显示对应价格（蜡烛图为收盘价），下方显示带正负号的涨跌百分比（分时/五日相对图表昨收基准，K 线相对上一根收盘价）；时间保留在图表下方。松手保留选点，再轻点图表退出并恢复最新报价；普通拖动恢复平移，双指仍可缩放。

## 在手机打开

1. 从 App Store 安装或更新 **Expo Go**。本工程使用 Expo SDK 57；手机需要支持该 SDK 的 Expo Go。
2. iPhone 与电脑连接同一个局域网。电脑可在项目根目录运行 `./tools/Start-ExpoGo.ps1`（自动选择私有局域网地址），或在 `mobile/` 运行 `npm start`。保持终端及电脑开启。
3. 用 iPhone 相机扫描终端的 Expo Go 二维码，允许 Expo Go 访问本地网络。连接地址以当前终端输出为准。
4. 默认进入演示模式。浏览器 `http://127.0.0.1:8081` 也能预览，浏览器只允许演示。

本机首次启动已经完成；扫码图在 `../artifacts/THS-Expo-Go-QR.png`。电脑和手机不在同一局域网时，该地址不可访问。

## 真实 Schwab 直连

- 将本机生成的 `../artifacts/THS-Expo-personal-config.json` 私下传到 iPhone“文件”。在 App 的“设置 → Schwab 连接 → Schwab 直连 → 从文件导入个人配置”选择它，无需逐项输入 Client ID / Secret。
- 此文件含个人应用凭据。它不进入 Git、Metro 代码或云端构建；导入后使用 SecureStore 保存到手机。手机重启 App 会恢复连接模式和已有配置。
- 用开发者门户已登记的回调地址 `https://127.0.0.1`。点击“在浏览器登录 Schwab”，完成本人登录及授权。
- 跳转到本机回调后，Safari 可能显示无法访问；复制地址栏完整网址，返回 App 粘贴并点击“完成授权”。Expo Go 不提供此项目的专属 URL scheme 自动回跳，因此沿用手动回调方式。
- 真实读写由 iPhone 直接访问 `api.schwabapi.com`。无需自建域名或服务器。当前本机验证使用虚构数据，没有调用真实订单接口。

## 两台设备共享服务器授权

最新源码新增“设置 → Schwab 连接 → 服务器共享”。服务器使用现有 Client ID / Secret，统一保存并刷新 Schwab 令牌。每台手机仅保存 HTTPS 服务器地址和各自的设备密钥；服务器已授权时，另一台刷新连接即可使用。忘记本机连接不注销另一台设备。

服务部署说明见 [`../server/README.md`](../server/README.md)，验收边界见 [多设备连接](MULTI-DEVICE.md)。目前完成本地实现，尚未部署到用户服务器，也没有进行双真机验收。需要实际服务器地址、访问方式及 HTTPS 回调地址；本轮不生成 IPA。

服务器模式复用当前交易核对、快速模式和结果不明锁定。两台设备共享写操作锁，核对只允许发起设备提交且只能使用一次。另一台重新核对可能使较早的核对失效，届时需本人重新核对。行情由服务器共享上游连接，再向设备分发；手机不接收 Schwab 令牌。迁移后请停止旧直连客户端刷新同一应用会话。

## 功能与边界

底部连接入口已移入“设置 → Schwab 连接”。设置中的快速模式默认关闭，开关保存在本机。开启后，输入价格和股数，点买入/卖出即在后台核对并提交；单笔撤单按钮直接发送撤单请求，点订单行仍只查看详情。关闭时恢复原有核对页，修改订单仍需核对。快速模式复用已有账户/数量校验、冻结订单快照、操作锁和未知结果锁定，不会自动重试失败提交。

**直连模式仍需手动回调；服务器模式可自动接收回调。** 部署服务器并登记实际 `https://你的域名/oauth/callback` 后，Schwab 官方页面完成登录会回调服务器，无需再粘贴授权链接。成功页面提示返回 App，App 回到前台后刷新共享授权状态。浏览器自动关闭或自动跳回 App 尚未接通；未部署的本地代码不能代替实际回调登记。账号密码始终在 Schwab 官方页面填写，不由 App 收集。参考：[Expo WebBrowser](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/)、[Apple HTTPS callback](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/callback/https(host:path:))。

自选列表／左滑多股同列、账户持仓、行情详情、分时／五日、日周月及 1/5/15/30/60/120 分钟 K 线、MA5/10/20/30、扩展时段底色、价量对齐、横拖／双指缩放、系统明暗色、图下买卖撤、账户核对、简单订单修改和撤销均移植为 React Native。

买卖支持整股股票／ETF，常规时段可选四种订单类型；盘前、盘后和连续延长时段只支持限价。盘前/盘后为 DAY，常规限价和连续延长时段可选 DAY/GTC；连续延长时段不包含夜盘。按金额买入按明确限价换算整股，金额不含费用。最大可卖数依据已查询订单估算：订单读取窗口最近 30 天、最多 200 条，不能证明更早 GTC 委托不存在。达到查询上限时拒绝准备新交易。

行情详情优先使用 Schwab WebSocket 推送；每 250ms 合并一次界面更新，当前周期的蜡烛随成交价更新，保留期间最高／最低价。推送不可用时回退到报价轮询。离开页面或进入后台停止订阅；最新蜡烛的短动画在静止、后台及减少动态效果模式下停止。

行情图使用完整宽度，报价与统计保留买一/卖一价格。已移除五档侧栏及深度订阅，推送仅用于报价与 K 线。

深度字段参考 [schwab-py 作者的实现说明](https://schwab-py.readthedocs.io/en/stable/streaming.html#level-two-order-book)；该作者明确指出深度流的公开官方资料不完整，字段解释包含逆向验证，因此本项目不承诺全市场覆盖。

## 0.6.0 服务器共享自用包

本版本支持在本机向云端生成的未签名 IPA 加入服务器设备配置。为两个设备分别生成自用包，首次启动自动将各自的设备连接保存到 Keychain 并切换到服务器共享模式；沿用已有手动服务器连接，显式断开后不会再次自动导入。服务器当前已完成授权时，手机无需再次登录 Schwab。券商要求重新授权时仍需在官方页面完成一次授权，两台设备共享结果。

使用 `python scripts/personalize-ipa.py INPUT.ipa OUTPUT.ipa --server-device ../artifacts/server-device-configs/device-1.json` 生成设备一的自用包，设备二使用另一份设备文件。云端构建不包含这些私有文件。每个包仍需本人签名后安装；签名时保持原应用标识可用于覆盖升级。

下面的 0.5.5 记录保留旧直连包的构建和迁移方式。

## 独立 IPA

`eas.json` 的 `unsigned` 配置使用 Expo 云端 macOS/Xcode，将本目录预构建为原生 iOS 项目，编译 Release，嵌入 Hermes bundle，并输出 `THS-0.5.5-unsigned.ipa`。这是真机包，需要使用自己的证书签名后安装；安装后不依赖 Expo Go、Metro 或电脑。提交源码不会触发 IPA 构建。

在 `mobile/` 运行（先确认账号免费构建额度）：

```powershell
$env:EAS_NO_VCS='1'
$env:EAS_PROJECT_ROOT=(Get-Location).Path
$env:EXPO_NO_DOTENV='1'
npx eas-cli@23.2.0 build --platform ios --profile unsigned --non-interactive
```

`EAS_PROJECT_ROOT` 限定为本目录，`.easignore` 只允许应用源码、资源及构建脚本上传。不要从仓库根目录运行此命令，根目录仍是旧 SwiftUI 构建配置。构建脚本与 IPA 校验器位于 `scripts/`，无需上传签名证书或 Schwab 凭据。

应用标识为 `app.personal.ths.expo`，与旧 SwiftUI 包不同。独立安装的 App 与 Expo Go 不共享配置。通用包需导入个人配置；自用包可用 `scripts/personalize-ipa.py` 在本机追加配置，首次启动自动保存到 SecureStore。配置不会提交 GitHub 或上传云端构建，已有会话优先且显式重置后不自动恢复。两种包都需要本人完成 Schwab 授权，沿用上文的手动粘贴回调方式。

下单会重新核对账户及报价；普通模式显示确认页，快速模式由本人点击买入/卖出按钮后直接核对并提交。提交不会自动重试；不确定结果保留交易锁定直到本人在券商核实。模拟模式与真实模式隔离。缺失数据保持空缺，不以模拟值填入真实账户。

## 本地验证

```powershell
cd mobile
npm ci
npm run typecheck
npm test
npx expo-doctor
npm run export:ios
npm run export:web
npm start
```

自选中蓝色名称/代码表示当前账户有持仓；金色 `24` 表示隔夜交易参考名单中的证券。列表和多股同列共用标记。点击列表上方说明可查看来源日期与限制。当前参考覆盖标普 500 成分及 Schwab 官网列举的 SPY、QQQ、TLT，未覆盖完整资格表，未标记不代表不支持。名单保存在 `src/overnightReference.ts`，核对日期超过 30 天后暂停显示；标记不启用本 App 隔夜订单。完整资格以 [Schwab 指引](https://www.schwab.com/stocks/extended-hours-trading)中的 thinkorswim 公共自选名单为准。

`export:ios` 验证 iOS JavaScript / Hermes bundle，不生成或签名 IPA，也不验证真机网络、键盘或多指手势。手机首次真实登录和实机调试需要用户在本人设备上完成。

SDK 57 的当前依赖审计包含上游构建工具 `uuid/xcode` 链的 moderate 提示；没有使用 `npm audit fix --force` 提示的 Expo 46 降级。具体审计报告保存在本机 `../artifacts/expo-audit.json`。

参考：[Expo Go 与开发构建](https://docs.expo.dev/develop/development-builds/introduction/)、[OAuth 限制](https://docs.expo.dev/guides/authentication/)、[SDK 57](https://docs.expo.dev/versions/v57.0.0/)。
