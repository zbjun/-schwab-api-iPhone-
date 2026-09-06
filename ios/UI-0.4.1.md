# 0.4.1 K线缩放与拖动

已实现日、周、月和六种分钟 K 线双指缩放、单指左右拖动的代码，尚待原生验证。分时、五日及自选分时图保留已有交互。没有新增 App 依赖。

## 操作

- 双指展开会放大蜡烛，合拢会显示更多；以双指中心定位，蜡烛、MA5/10/20/30 和成交量共用时间窗口。
- 单指向右拖查看更早历史，向左拖回较新的数据。主图和成交量区域均支持手势，轻点可查看对应价格。
- 单指纵向拖动仍滚动行情详情。图下买卖撤展开后保留当前窗口，上方主图仍可缩放拖动。
- 点击“最新”恢复最近最多 120 根。切换证券、周期或手动刷新时恢复初始窗口。
- 缩放宽度为 12–600 根，边缘可显示部分蜡烛；不足时显示实际数据量。可拖动范围限当前已经读取的历史，抵达边界后停止，不补造历史或额外发起网络请求。
- MA 使用完整已读取历史计算，随后截取可见窗口；纵轴按当前可见价格及 MA 调整。

## 文件与复用

| 文件 | 改动 |
| --- | --- |
| THS/Models/CandleViewport.swift | 纯坐标模型：缩放锚点、拖动方向、边界及数据数量变化 |
| THS/Views/CandleGestureSurface.swift | 系统手势识别，与父页面纵向滚动区分方向 |
| THS/Views/MarketChartView.swift | 复用原有蜡烛、MA、成交量绘制，共用可见窗口 |
| THS/Views/StockDetailView.swift | 详情持有窗口，展开交易区域时保留位置 |
| THSTests/CandleViewportTests.swift | 缩放、拖动、异常输入和连续操作的边界测试 |
| THSUITests/TradingFlowTests.swift | 真实触摸缩放、拖动、页面滚动及图下交易验证 |
| tools/ios/generate-project.mjs | 注册源文件并生成 0.4.1 / build 5 工程 |
| tools/ios/build-preview.py | 导出新增手势状态的原生截图预览 |

## 验证

应用提交 `c8f7ad72f67324fdbb2345432a894476717353a2` 已推送。工程一致性、脚本语法及空白检查通过；新增 16 项模型测试和 2 项真实触摸 UI 测试，全套为 123 项单元测试、12 项界面测试。代码审查确认完整历史 MA 与全局索引、价量共用窗口和图下布局状态保留。

[构建 34032987136](https://github.com/zbjun/ths-ios-personal/actions/runs/34032987136) 未分配 runner、未执行任何步骤。GitHub 原因提示为近期账户付款失败或需要提高 Actions 支出上限，不能据此判断具体是哪一项。需要用户在 Billing & plans 处理后重新运行原生验证；本机 Windows 没有 Swift/Xcode，无法替代此验证。诊断记录保存在 `artifacts/gesture-run-startup-failure.json`。

尚未生成 0.4.1 原生截图或安装包，现有 0.4.0 交付文件和本地预览保持可用。恢复后应执行完整测试、原生画面复核和 Release 归档，再签名安装到 iPhone 16 Pro。还需真机检查双指中心漂移、横拖后轻点及手势流畅度。

手势使用 Apple 的 [方向开始判断](https://developer.apple.com/documentation/uikit/uigesturerecognizerdelegate/gesturerecognizershouldbegin(_:)) 与 [失败依赖](https://developer.apple.com/documentation/uikit/uigesturerecognizerdelegate/gesturerecognizer(_:shouldberequiredtofailby:))，在绘图区内区分横向浏览和纵向页面滚动。仅图表自身 pan/pinch 允许同时识别，未对父页面开放同时识别；[Apple 同时识别规则](https://developer.apple.com/documentation/uikit/uigesturerecognizerdelegate/gesturerecognizer(_:shouldrecognizesimultaneouslywith:))。
