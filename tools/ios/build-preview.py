"""Build a local gallery from unmodified, explicitly named XCTest screenshots."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import shutil


PAGES = {
    "01-accounts": ("账户与持仓", "净值、现金与购买力，以及持仓入口。"),
    "02-watchlist": ("自选行情", "跟随系统明暗，最新价、涨跌幅与涨跌额对齐展示。"),
    "03-trade": ("股票 / ETF 交易", "选择买卖方向、订单类型、数量与价格。"),
    "04-orders": ("订单列表", "查看近期订单，按状态筛选并进入详情。"),
    "05-connection": ("连接与演示", "iPhone 直连 Schwab；演示数据与真实账户分开。"),
    "06-stock-detail-chart": ("分时行情", "价格折线与金黄色均价估算线随系统配色，顶部展示报价和统计。"),
    "07-limit-order-review": ("下单核对", "提交前核对账户、数量、价格及预估金额。"),
    "08-canceled-demo-order": ("撤单结果", "模拟撤单后的订单详情。"),
    "09-replacement-review": ("修改订单", "修改未成交的简单订单，重新核对后确认。"),
    "10-invalid-quantity": ("输入校验", "无效数量会被拦截，不能进入提交确认。"),
    "11-daily-candles": ("日 K", "日蜡烛图、MA5/10/20/30 与成交量。"),
    "12-weekly-candles": ("周 K", "按周 OHLC 绘制蜡烛，均线以周为周期。"),
    "13-monthly-candles": ("月 K", "按月 OHLC 绘制蜡烛，均线以月为周期。"),
    "14-five-day-chart": ("五日走势", "五个交易日折线，黄色均价估算在每天重新计算。"),
    "15-watchlist-charts": ("多股同列", "自选列表左滑切换；每只股票独立显示分时走势。"),
    "16-inline-buy": ("图下买卖", "交易区在 K 线下方展开，可买和可卖股数随账户状态估算。"),
    "17-inline-keyboard": ("输入时查看 K 线", "键盘弹出后图表仍保持在交易区上方，表单单独滚动。"),
    "18-inline-review": ("按金额买入核对", "1000 美元预算按 200 美元限价换算为 5 整股，核对仍在图下。"),
    "19-watchlist-dark": ("深色自选", "手机切换深色后，自选列表自动跟随系统变化。"),
    "20-detail-dark": ("深色 K 线", "深色下保留清晰的蜡烛、MA 和涨跌颜色。"),
    "21-detail-light": ("浅色 K 线", "保持同一行情页面，切回系统浅色后背景和线条自动适配。"),
    "22-minute-menu": ("更多周期", "1、5、15、30、60、120 分钟蜡烛图均可在更多中选择。"),
    "23-minute-1": ("1 分钟 K 线", "最近 120 根分钟蜡烛，MA5/10/20/30 使用完整历史计算。"),
    "24-minute-5": ("5 分钟 K 线", "五分钟 OHLC 蜡烛与四条均线、成交量。"),
    "25-minute-15": ("15 分钟 K 线", "十五分钟蜡烛，均线按当前周期计算。"),
    "26-minute-30": ("30 分钟 K 线", "三十分钟蜡烛与 MA5/10/20/30。"),
    "27-minute-60": ("60 分钟 K 线", "按美东常规交易时段合成小时蜡烛，跨交易日重新分组。"),
    "28-minute-120": ("120 分钟 K 线", "两小时蜡烛与四条均线；每日收盘前的不足周期单独保留。"),
    "29-inline-cancel-orders": ("图下撤单", "买 / 卖 / 撤并列，撤单区只列出当前账户、当前股票的可撤委托。"),
    "30-inline-cancel-review": ("撤单核对", "核对选中的一笔委托，确认区仍位于主图下方。"),
    "31-inline-cancel-result": ("图下撤单结果", "模拟撤单后刷新委托，结果提示保留在图下。"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screenshots", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--run", required=True, help="Verified GitHub Actions run ID")
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"\d+", args.run) or not re.fullmatch(r"[0-9a-f]{7,40}", args.commit):
        parser.error("Use a numeric run ID and hexadecimal commit ID.")
    source = args.screenshots.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    pages = {}
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    for test in manifest:
        for item in test["attachments"]:
            name = item["suggestedHumanReadableName"].split("_0_", 1)[0]
            if name not in PAGES or item.get("isAssociatedWithFailure"):
                continue
            original = (source / item["exportedFileName"]).resolve()
            if not original.is_relative_to(source) or original.suffix.lower() != ".png":
                raise ValueError("Unexpected screenshot path")
            image_name = name + ".png"
            shutil.copyfile(original, output / image_name)
            title, description = PAGES[name]
            pages[name] = dict(name=name, title=title, description=description, image=image_name,
                               device=item["deviceName"], test=test["testIdentifier"],
                               sha256=hashlib.sha256(original.read_bytes()).hexdigest())
    missing = sorted(PAGES.keys() - pages.keys())
    if missing:
        raise SystemExit("Missing native screenshots: " + ", ".join(missing))
    order = ["02-watchlist", "19-watchlist-dark", "15-watchlist-charts", "06-stock-detail-chart", "11-daily-candles",
             "12-weekly-candles", "13-monthly-candles", "14-five-day-chart", "16-inline-buy",
             "22-minute-menu", "23-minute-1", "24-minute-5", "25-minute-15", "26-minute-30", "27-minute-60", "28-minute-120",
             "20-detail-dark", "21-detail-light", "17-inline-keyboard", "18-inline-review",
             "29-inline-cancel-orders", "30-inline-cancel-review", "31-inline-cancel-result", "01-accounts", "03-trade", "04-orders",
             "07-limit-order-review", "08-canceled-demo-order", "09-replacement-review", "10-invalid-quantity", "05-connection"]
    ordered = [pages[name] for name in order]
    metadata = dict(version="0.4.0", run=args.run, commit=args.commit, pages=ordered)
    (output / "evidence.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    buttons = "\n".join(
        f'<button class="page-button" type="button" data-index="{index}" aria-pressed="false">'
        f'<span class="number">{index + 1:02}</span><span>{html.escape(page["title"])}</span></button>'
        for index, page in enumerate(ordered)
    )
    document = TEMPLATE.replace("{{BUTTONS}}", buttons)
    document = document.replace("{{DATA}}", json.dumps(metadata, ensure_ascii=False).replace("<", "\\u003c"))
    document = document.replace("{{RUN}}", args.run).replace("{{COMMIT}}", args.commit[:7])
    (output / "index.html").write_text(document, encoding="utf-8")
    print(json.dumps({"screenshots": len(ordered), "output": str(output / "index.html")}, ensure_ascii=False))


TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>THS · iPhone 原生界面预览</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#172435;background:#f4f6fa;color-scheme:light}
*{box-sizing:border-box}body{margin:0}button,a{-webkit-tap-highlight-color:transparent}button{font:inherit;cursor:pointer}
.shell{max-width:1220px;margin:0 auto;padding:36px 32px 24px}.eyebrow{font-size:12px;letter-spacing:2px;font-weight:750;color:#326bbb}
h1{font-size:32px;letter-spacing:-1px;margin:10px 0}header p{color:#637083;line-height:1.8;margin:6px 0 24px}.badge{display:inline-block;font-size:12px;padding:5px 10px;border-radius:20px;background:#e6efff;color:#2261b9;vertical-align:middle;margin-left:10px;letter-spacing:0}
main{display:grid;grid-template-columns:270px minmax(280px,1fr) 240px;gap:36px;align-items:start}.nav{display:grid;gap:5px;padding-top:4px;max-height:75vh;overflow-y:auto}
.page-button{display:flex;gap:14px;align-items:center;text-align:left;border:1px solid transparent;background:transparent;padding:13px 14px;border-radius:13px;color:#546074;font-size:14px}
.page-button:hover{background:#edf1f7}.page-button[aria-pressed=true]{background:white;color:#185fbe;border-color:#dbe7f8;box-shadow:0 4px 14px #17406908;font-weight:650}.number{font-size:11px;letter-spacing:1px;color:#93a0b1;font-variant-numeric:tabular-nums}
.viewer{text-align:center}.screenshot-button{border:0;padding:0;background:none;display:inline-block;max-width:100%;border-radius:32px;box-shadow:0 18px 50px #253b5722;overflow:hidden;line-height:0}
#screen{display:block;width:auto;max-width:100%;height:min(70vh,720px);object-fit:contain;background:#fff}.hint{font-size:12px;color:#8590a1;margin:14px 0}.details{padding-top:8px}h2{font-size:21px;margin:0 0 12px}.details p{font-size:14px;line-height:1.85;color:#647184;margin:0 0 20px}.context{border-top:1px solid #dce2eb;padding-top:18px;font-size:12px;line-height:1.9;color:#8390a1}.pager{display:flex;gap:8px;margin:22px 0}.pager button{background:#fff;border:1px solid #dce4ef;border-radius:10px;padding:8px 13px;color:#475e7a}.pager button:disabled{opacity:.35;cursor:default}
footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid #dce2eb;padding-top:18px;margin-top:28px;font-size:12px;line-height:1.8;color:#8994a4}a{color:#3976c7;text-decoration:none}a:hover{text-decoration:underline}
dialog{border:0;background:#172435ed;border-radius:14px;padding:48px 12px 12px;max-width:96vw;max-height:96vh}dialog::backdrop{background:#142033bb}dialog img{max-width:90vw;max-height:82vh;object-fit:contain;display:block}#close{position:absolute;top:10px;right:12px;color:white;background:transparent;border:1px solid #ffffff66;border-radius:6px;padding:5px 12px}
@media(max-width:1020px){main{grid-template-columns:225px 1fr;gap:24px}.details{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:0 30px}.details .context{grid-column:2;grid-row:1/4}.details .pager{margin-top:0}#screen{height:68vh}}
@media(max-width:620px){.shell{padding:24px 18px}h1{font-size:26px}main{display:flex;flex-direction:column;gap:22px}.nav{display:flex;overflow:auto;width:100%;padding-bottom:8px}.page-button{flex-shrink:0;padding:10px 12px}.number{display:none}.viewer{width:100%}#screen{height:65vh;max-width:100%}.details{display:block;width:100%}.context{display:none}footer{display:block}.badge{font-size:10px}header p{font-size:13px}}
</style>
<div class="shell">
<header><div class="eyebrow">THS / PERSONAL TRADING</div><h1>你的 iPhone 交易 App<span class="badge">0.4.0</span></h1><p>股票 / ETF · iPhone 直连 Schwab · 以下为原生模拟器截图，展示的账户、行情和订单均为演示数据。</p></header>
<main><nav class="nav" aria-label="选择页面">{{BUTTONS}}</nav>
<section class="viewer" aria-label="原生页面截图"><button class="screenshot-button" type="button" aria-label="放大当前截图"><img id="screen" alt=""></button><p class="hint">点击图片放大 · 使用 ← → 切换页面</p></section>
<aside class="details"><h2 id="title"></h2><p id="description"></p><div class="pager"><button id="previous" type="button" aria-label="上一页">← 上一页</button><button id="next" type="button" aria-label="下一页">下一页 →</button></div><div class="context">截图来自 <span id="device"></span><br>保留原始图像，未绘制替代界面。<br><br>本页用于查看界面，不能操作交易。<br>后续在你的 iPhone 16 Pro 上安装调试。</div></aside></main>
<footer><span>原生 SwiftUI · 无第三方 App 依赖</span><span><a href="https://github.com/zbjun/ths-ios-personal/actions/runs/{{RUN}}" target="_blank" rel="noreferrer">构建验证</a> · {{COMMIT}}</span></footer>
</div><dialog id="zoom"><button type="button" id="close">关闭 ✕</button><img id="large-screen" alt=""></dialog>
<script>
const evidence={{DATA}};
let current=0;
const buttons=[...document.querySelectorAll('.page-button')];
function show(index){current=Math.max(0,Math.min(evidence.pages.length-1,index));const page=evidence.pages[current];document.getElementById('screen').src=page.image;document.getElementById('screen').alt=page.title+'，原生 iPhone 演示截图';document.getElementById('title').textContent=page.title;document.getElementById('description').textContent=page.description;document.getElementById('device').textContent=page.device;buttons.forEach((button,i)=>button.setAttribute('aria-pressed',i===current));document.getElementById('previous').disabled=current===0;document.getElementById('next').disabled=current===evidence.pages.length-1;}
buttons.forEach(button=>button.addEventListener('click',()=>show(Number(button.dataset.index))));
document.getElementById('previous').addEventListener('click',()=>show(current-1));document.getElementById('next').addEventListener('click',()=>show(current+1));
const zoom=document.getElementById('zoom');document.querySelector('.screenshot-button').addEventListener('click',()=>{const enlarged=document.getElementById('large-screen');enlarged.src=evidence.pages[current].image;enlarged.alt=evidence.pages[current].title;zoom.showModal();});document.getElementById('close').addEventListener('click',()=>zoom.close());
document.addEventListener('keydown',event=>{if(zoom.open)return;if(event.key==='ArrowRight'){event.preventDefault();show(current+1);}if(event.key==='ArrowLeft'){event.preventDefault();show(current-1);}});show(0);
</script></html>
"""

if __name__ == "__main__":
    main()
