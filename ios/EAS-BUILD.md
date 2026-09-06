# 在 EAS 构建现有 SwiftUI 应用

本配置把 Xcode 测试和打包移到 Expo EAS 的 Mac 构建机，保留现有 SwiftUI 代码。没有 Expo、React Native、CocoaPods 或其他运行依赖，也不支持用 Expo Go 打开此应用。`package.json` 和 `app.json` 只用于 EAS 项目识别；`package-lock.json` 记录零第三方依赖以满足 EAS 检查。App 的版本号仍由原生 Xcode 工程管理。

2026-09-06 已登录并连接个人 Free 项目 `@fried_chicken_cn/ths-ios-personal`，关闭了内部构建的未登录访问。上传预检的 49 个文件符合白名单，未发现本地应用凭据。完整原生构建尚待执行；不能把这些检查视为 Xcode 编译或真机验证通过。

本地已检查 JSON/YAML 与 Bash 语法，并用 EAS 使用的 `ignore` 5.3.0 和 Windows 实际目录复制复演验证上传集合。临时模拟工具验证了非 Mac 主机、测试失败、附件导出失败、归档失败时的退出状态和诊断保留；这些仅验证构建脚本的失败处理，不计作原生测试通过。

## 费用与账号

只使用个人 Free 方案及其剩余额度，不绑定付款方式、不升级套餐、不启用付费构建。免费额度和资格以登录后的 Expo Billing 页面为准；额度不足时停止，不自动重试或切换到付费方案。EAS 的免费方案在 2026-09-06 公布为每月最多 15 次 iOS 构建，单次最多 45 分钟；排队和超时仍可能影响这次完整测试。

## 第一次配置

在项目根目录使用 Node.js 与 EAS CLI 23.2.0。`eas.json` 固定这一版本；`npx` 会把 CLI 工具下载到 npm 缓存，不会给应用增加依赖：

```powershell
$env:EXPO_NO_DOTENV = '1'
npx eas-cli@23.2.0 login --browser
npx eas-cli@23.2.0 init
```

登录自己的 Expo 账户，确认使用 Free 方案。初始化时创建或选择自己的 `ths-ios-personal` 项目。CLI 会将真实的 `extra.eas.projectId` 写入 `app.json`，必要时补充 `owner`。仓库当前未预设这些字段，不要手工填入虚假的 ID。这个流程不需要 GitHub Actions、Apple 账号或签名证书。

创建项目后，先打开 Expo 项目设置，关闭 **Unauthenticated access to internal builds**，保存并核对后再上传或构建。EAS 的 internal 构建链接默认允许任何持有链接的人访问；关闭该选项后才要求有项目权限的 Expo 用户登录。`package.json` 的 `private: true` 只防止 npm 发布，不控制 Expo 权限。当前 app.json 和 `eas init` 没有这个隐私设置字段，不应填写旧的 `privacy: hidden`。只读 API 对应字段是 `internalDistributionBuildPrivacy`，关闭后的值应为 `PRIVATE`。

EAS 官方说明源码归档存放在私有云存储中供构建机读取。这个源码权限与上面的构建下载权限是两个设置；不共享构建/下载链接，也不将配置加入公开仓库。

不要运行 `expo prebuild` 或替换现有 `ios/` 工程，也不要加入 React Native 来绕过无关的默认构建步骤。本项目选择的是 `.eas/build/native-ios.yml` 自定义流程。

## 上传前检查

登录并初始化后，先在本地生成与上传相同的文件集合；这个 `archive` 检查不会启动云端构建：

```powershell
npx eas-cli@23.2.0 build:inspect --platform ios --profile native-unsigned --stage archive --output artifacts/eas-upload-inspection
```

不要加 `--force` 覆盖已有检查结果。检查目录中只应包含 `.easignore`、四个根 JSON 文件、`.eas/build/native-ios.yml`、Swift 源码与测试、原生工程/Info.plist/scheme，以及 `build-native.sh`、`generate-project.mjs`、`select-simulator.py`、`verify-ipa.py`。没有配置资源目录或个人凭据文件。

`.easignore` 默认拒绝全部文件，再逐项允许必需文件；同时明确拒绝 `.env`、`.secrets/`、token、证书、个人描述文件、旧 IPA、`artifacts/`、`reports/`、`tools/schwab-connect/`、Git 历史和本机状态。`SchwabPersonalConfiguration.plist` 在任何目录中都禁止上传。通用 Info.plist 中的 `THSPersonalConfigurationVersion = 1` 只是配置格式标记，必须保留，不含私人数据。`EXPO_NO_DOTENV=1` 防止工具意外导入本地环境文件。不要把 Schwab Client ID、Client Secret、令牌或 Apple 证书配置成 Expo 环境变量。

App 源码目录也逐项列入白名单。后续新增源码子目录时，要将该目录本身加入 `.easignore` 的允许规则并重新检查上传集合；不要用放行整个 `ios/` 的方式处理缺文件。EAS 的目录复制检查没有尾随 `/`，允许目录的规则也刻意不加尾随 `/`。

## 使用剩余免费额度构建

确认本地上传集合与 Free 额度后执行一次：

```powershell
npx eas-cli@23.2.0 build --platform ios --profile native-unsigned
```

该命令会将白名单源码上传到 Expo，并消耗一次构建额度。它不使用 GitHub Actions，也不会提供苹果签名。保持当前账户的免费方案；若服务提示升级或收费，不接受该操作。

流程会校验工程、选择可用的 iPhone 模拟器、运行全部单元/UI 测试，再生成 Release 真机归档和未签名 IPA。任一测试失败时，不再生成可交付 IPA；普通失败仍会上传 `.xcresult`、截图附件、日志及 `build-status.json`，平台强制终止的作业可能来不及上传。只有测试、归档、IPA 校验与附件导出成功才上传应用文件。

构建机固定为 `macos-tahoe-26.5-xcode-26.6`，使用免费方案支持的 `medium` 机型。自定义流程只调用现有工具和 `xcodebuild`，跳过 Expo 的默认安装、prebuild、pods 与签名步骤。`ios.withoutCredentials=true` 是 EAS 正式支持的配置。

## 下载后交付

成功页面的应用产物是 `THS-unsigned.ipa`，Bundle ID 为 `app.personal.ths`。附加诊断产物含完整原生测试证据、截图、校验报告和 SHA-256。应先下载核对结果，再在本机注入用户自己的配置，最后使用自己的签名工具签名安装。私人配置在云端构建后添加，不应进入 Expo、GitHub 或通用 IPA。

当前流程不改动已有的 0.4.0 包和本地预览。需要实际通过原生测试后，才能用新版本替换旧交付。

## 核实依据

- [EAS 自定义构建 schema](https://docs.expo.dev/custom-builds/schema/)：checkout、自定义命令、`always()` 和分类型产物上传。
- [eas.json 配置](https://docs.expo.dev/eas/json/)：iOS `withoutCredentials`、`config`、`scheme`、本地版本号。
- [EAS 构建机镜像](https://docs.expo.dev/build-reference/infrastructure/) 与 [当前免费方案](https://expo.dev/pricing)。
- [内部构建下载权限](https://docs.expo.dev/build/internal-distribution/) 与 [源码归档私有存储](https://github.com/expo/fyi/blob/main/eas-build-archive.md)。
- 核实的发布版为 EAS CLI `23.2.0`，npm 元数据中的源码 revision 是 `74292d2ace404759ab8936d5aa1369e15d4b4f9d`。其 [非 Expo 配置分支](https://github.com/expo/eas-cli/blob/74292d2ace404759ab8936d5aa1369e15d4b4f9d/packages/eas-cli/src/project/expoConfig.ts)、[可缺省的 React Native 版本](https://github.com/expo/eas-cli/blob/74292d2ace404759ab8936d5aa1369e15d4b4f9d/packages/eas-cli/src/build/metadata.ts) 与 [EAS 目录复制实现](https://github.com/expo/eas-cli/blob/74292d2ace404759ab8936d5aa1369e15d4b4f9d/packages/eas-cli/src/vcs/local.ts) 是无运行依赖和上传集合检查的依据。云端实际编译仍待首次运行验证。
