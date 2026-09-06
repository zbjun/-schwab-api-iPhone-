# 行情界面数据依据

核对日期：2026-09-06。本轮使用公开文档与本地演示数据，未使用真实凭据或向券商发送订单。

## 接口依据

Schwab 官方开发者文档页面本轮仍未返回可读取的规范正文：[Developer Portal](https://developer.schwab.com/products/trader-api--individual/details/documentation)。以下维护者源码是客户端的实现参考，不作为券商官方保证，也不引入这些第三方库。

- 行情 `quotes` 的基本面字段支持 `peRatio` 与 `avg10DaysVolume`；市值和总股本使用独立 `instruments?symbol=...&projection=fundamental` 读取。维护者示例中的 `marketCap` 以原始美元数值表示，`sharesOutstanding` 为股数。[接口与响应示例](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/docs/pages-raw/api.md)、[请求源码](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/schwabdev/client.py)。
- 历史蜡烛使用五个明确组合：day/1/minute/1、year/1/daily/1、year/2/weekly/1、year/5/monthly/1、day/5/minute/5。显式传结束时间，关闭扩展时段，保留前收盘价。组合合法不保证当前交易日数据齐全。[历史接口参考](https://schwab-py.readthedocs.io/en/latest/client.html#price-history)。
- 账户 `currentBalances.buyingPower` 用于可买估算；持仓数量与已读取卖单剩余量用于可卖估算。近期订单查询有时间范围和结果上限，因此不能声称掌握所有历史 GTC 委托。既有订单约束见 [API-REFERENCE.md](API-REFERENCE.md)。

## 本机计算与口径

这些计算由 THS 实现，并非券商直接提供的指标：

- 黄色均价估算：分钟 OHLC 的典型价 `(高 + 低 + 收) / 3` 按成交量加权，按纽约日期重新计算。未知成交量使当日后续均价不可用，零成交量沿用已知均价。
- MA5/10/20/30：当前蜡烛周期的完整收盘价窗口；样本不足时不填充。
- 换手估算：报价成交量 / 基本面总股本 × 100%。与按流通股本计算的换手率可能不同，基本面更新也可能滞后。
- 量比估算：最近完整分时数据的每分钟成交量，除以前五日日均成交量 / 390。要求从纽约09:30开始的连续完整分钟数据；不使用当天日 K 作为前五日样本，不以十日均量冒充五日。390分钟是普通交易日假设，半日市存在偏差；数据不足时显示破折号。
- 可买：当前购买力 / 输入限价，向下取整；市价仅按参考价估算。证券融资比例、费用、未完成委托及行情变化使其不能作为券商承诺。
- 可卖：当前整股持仓扣除已读取、尚未终结的卖单剩余数量；无法解析的相关委托使估算不可用。修改现有订单时排除原订单占用。
- 按金额买入：美元预算 / 限价，向下取整后生成普通限价整股指令。预算不含费用，显示最终股数并保留提交前核对。

原生模拟器与固定响应测试验证实现与布局；真实行情权限、字段现状、手机网络及券商接单行为留待用户设备连接后核实。
