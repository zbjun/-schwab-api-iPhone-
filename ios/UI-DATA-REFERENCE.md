# 行情界面数据依据

核对日期：2026-09-06。本轮使用公开文档与本地演示数据，未使用真实凭据或向券商发送订单。

## 接口依据

Schwab 官方开发者文档页面本轮仍未返回可读取的规范正文：[Developer Portal](https://developer.schwab.com/products/trader-api--individual/details/documentation)。以下维护者源码是客户端的实现参考，不作为券商官方保证，也不引入这些第三方库。

- 行情 `quotes` 的基本面字段支持 `peRatio` 与 `avg10DaysVolume`；市值和总股本使用独立 `instruments?symbol=...&projection=fundamental` 读取。维护者示例中的 `marketCap` 以原始美元数值表示，`sharesOutstanding` 为股数。[接口与响应示例](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/docs/pages-raw/api.md)、[请求源码](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/schwabdev/client.py)。
- 五个主标签的历史请求组合保留为：day/1/minute/1、year/1/daily/1、year/2/weekly/1、year/5/monthly/1、day/5/minute/5。显式传结束时间，关闭扩展时段，保留前收盘价。组合合法不保证当前交易日数据齐全。[历史接口参考](https://schwab-py.readthedocs.io/en/latest/client.html#price-history)。
- 账户 `currentBalances.buyingPower` 用于可买估算；持仓数量与已读取卖单剩余量用于可卖估算。近期订单查询有时间范围和结果上限，因此不能声称掌握所有历史 GTC 委托。既有订单约束见 [API-REFERENCE.md](API-REFERENCE.md)。

## 更多中的分钟 K 线

公开维护者文档与请求源码列出的历史 `frequencyType=minute` 支持 `1 / 5 / 10 / 15 / 30`；`periodType=day` 支持 `period=10`。此处没有发现可直接请求的 `60 / 120`，因此由本机聚合，不把这些数值发给接口。[参数说明](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/docs/pages-raw/api.md)、[price_history 请求实现](https://raw.githubusercontent.com/tylerebowers/Schwabdev/main/schwabdev/client.py)。这些是维护者一手实现参考，不是本轮实测的券商权限或数据保证。

| 显示周期 | 请求组合 periodType / period / frequencyType / frequency | 处理方式 |
| --- | --- | --- |
| 1 分钟 | day / 10 / minute / 1 | 直接使用接口蜡烛 |
| 5 分钟 | day / 10 / minute / 5 | 直接使用接口蜡烛 |
| 15 分钟 | day / 10 / minute / 15 | 直接使用接口蜡烛 |
| 30 分钟 | day / 10 / minute / 30 | 直接使用接口蜡烛 |
| 60 / 120 分钟 | day / 省略 period / minute / 1；显式 startDate / endDate | 从过去 30 日的 1 分钟蜡烛合成 |

60 / 120 分钟固定请求结束时刻之前的 `30 × 24` 小时，以整数毫秒传 `startDate/endDate`，省略 `period`；白名单仅开放这一个日期窗口组合，并要求非负整数日期、起点早于终点、窗口不超过 30 日。`day/10` 未得到“十个交易日”的明确保证，改为显式窗口可为 MA30 留出更多样本。`schwab-py` 维护者观察 1 分钟历史可回溯约 48 日，并在文档中建议指定起止时间时省略 `period`；其便捷封装源码仍附带 `period=1`，本实现选择文档约定。48 日是维护者观察，不是券商保证，30 日请求仍可能因新上市、停牌、缺口或权限缺少足够样本。[分钟历史文档](https://schwab-py.readthedocs.io/en/latest/client.html#price-history)、[维护者源码](https://raw.githubusercontent.com/alexgolec/schwab-py/master/schwab/client/base.py)。

- 合成时间以 `America/New_York` 日期和 09:30 开盘为锚点，自动随夏令时换算，不按 UTC 整点分桶，不跨交易日合并。普通交易日按 09:30–16:00 的 390 分钟处理；60 与 120 分钟的最后一桶均为 15:30–16:00，共 30 分钟。
- 每桶开价取首根、收价取末根、高低价取极值；成交量仅在每根源蜡烛都具有有效非负量且总和不溢出时相加，否则保留未知。历史接口先校验 OHLC 和日期，按时间去重并排序，同刻采用最后一条有效记录，重复记录不重复计量。合成进一步排除周末、扩展时段、非整分钟时间及尚未结束的源分钟。
- 已经过完的桶必须有全部连续源分钟，缺口桶不显示，不能补零或沿用前价。当前交易日尚在形成的桶，只在截至请求时刻的已完成分钟连续齐全时显示；不包含当下尚未完成的那一分钟。因此 60 / 120 分钟最新一根可能尚未收盘，其 OHLC 和 MA 会继续变化。
- 未接入交易所节假日及提前收盘日历；历史半日市最后一个不足上述标准边界的桶不合成，不能把缺失记录推断为提前收盘。接口未返回的数据、停牌或低流动性造成的分钟缺失均不会被补造。
- MA5/10/20/30 使用各显示周期实际返回或合成后的蜡烛收盘价，先按完整历史计算；样本不足不补齐。真实请求范围不保证每只证券有 30 根有效蜡烛。演示数据固定生成十个已完成工作日的分钟样本，120 分钟有 40 根，足够演示 MA30；演示日期不代表真实交易日历。

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
