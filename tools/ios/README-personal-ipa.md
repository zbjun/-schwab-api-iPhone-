# 仅在本机制作个人 IPA

`personalize-ipa.py` 在已构建的**未签名 iPhone IPA** 内加入本人使用的 Schwab 应用配置。它不编译、不签名、不上传，也不连接券商。测试和真正原生构建的验证是两回事。

运行前，使用 `verify-ipa.py` 核对实际原生归档的版本、架构和未签名状态。目标 App 必须已经实现个人配置导入，并在 `Info.plist` 中带有整数 `THSPersonalConfigurationVersion = 1`；没有该标记的旧 0.4.0 包会被拒绝。

在项目根目录执行以下本地命令，文件名按实际的新构建选择：

```powershell
python tools/ios/personalize-ipa.py --input artifacts/THS-unsigned.ipa --output artifacts/THS-personal-unsigned.ipa --env-file .env
```

三个参数都必填。输出必须是尚不存在的独立文件，其父目录必须存在。原 IPA 保持不变。工具在临时副本上追加配置，核对已有条目的内容、权限、元数据和压缩记录未改变后，才原子发布新文件；失败时不会留下半成品。

本地文件只读取 `SCHWAB_CLIENT_ID` 与 `SCHWAB_CLIENT_SECRET` 两项。支持空行、注释、`export`、单/双引号和字面值；不执行变量替换、命令或反斜杠转义。其他项目（包括账户、access token、refresh token）全部忽略。凭据按现有 Swift 规则去除首尾空白后，必须为 1–512 个 UTF-8 字节，不含内部空白或控制字符，Client ID 不得含冒号；另行拒绝常见占位值。日志不会显示凭据值或原始文件内容。

仅新增以下二进制 plist：

```text
Payload/THS.app/SchwabPersonalConfiguration.plist
  schemaVersion: integer 1
  clientID: string
  clientSecret: string
```

此工具拒绝已签名或已经个人化的源包、多个 App、模拟器包、不安全或冲突的 ZIP 路径及符号链接。当前接受薄 arm64 主执行文件；通用 Mach-O 二进制需另外审查，工具不会猜测其签名状态。

输出仍然未签名，需要完成适当签名才能安装。**个人 IPA 内含应用凭据，接收该包的人可以提取；本机钥匙串导入不会删除包内副本。** 只在本人本机和本人掌控的签名流程中处理，不把个人输出或本地凭据文件提交仓库、上传通用构建附件，或混入演示截图资料包。

离线回归测试全部使用虚构凭据及合成 ZIP / Mach-O 命令表：

```powershell
python tools/ios/test-personalize-ipa.py
```

这些测试检查本地工具的变更范围和失败处理，不证明合成文件可执行，也不代替原生测试、签名安装或手机 Schwab 授权验证。
