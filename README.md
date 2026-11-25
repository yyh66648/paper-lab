# 纸面实验室

美股和 A 股的策略回测台。不需要券商账户，也不会下真实订单。

## 在线版

https://yyh66648.github.io/paper-lab/

纯静态，回测全部在浏览器里算，不经过任何服务器。美股是每天预抓的复权快照（约 60 只常见股票和 ETF），A 股在页面上切过去后实时直连腾讯，可以查任意 6 位代码。

## 本地跑

静态版直接开 `docs/index.html` 能用，但要通过 HTTP 打开才读得到数据文件：

```bat
python -m http.server 8765 -d docs
```

然后打开 http://127.0.0.1:8765 。

带 Python 后端的版本（任意美股代码、服务端回测、本地纸面账户）：

```bat
python run.py
```

然后打开 http://127.0.0.1:8765 。只监听本机。按 Ctrl+C 停止。

如果 `python` 不在 PATH 里，用你机器上的 Python 3.12 运行 `run.py` 即可。不需要安装第三方包，标准库加上 numpy 就够。

不联网的引擎自检：

```bat
python run.py --selftest
```

## 两种版本的差别

| | 在线静态版 | 本地 Python 版 |
|---|---|---|
| 回测在哪算 | 浏览器（`docs/engine.js`） | 服务端（`simtrader/engine.py`） |
| 美股范围 | 预抓的固定清单 | 任意代码 |
| A 股 | 实时直连，任意代码 | 同样直连 |
| 手动模拟账户 | 存在浏览器 localStorage | 存在 `data/paper_account.json` |
| 自定义策略 | 需要改 `docs/engine.js` | 放进 `strategies_user/` 即可 |

两个引擎的成交规则相同，我用同一份 NVDA 数据对比过，收益、回撤、夏普和成交笔数一致（`scripts/parity.js`）。

## 行情怎么更新

在线版的美股数据由 `.github/workflows/update-data.yml` 每个交易日跑一次，调用 `scripts/fetch_data.py` 抓 Yahoo 复权数据写进 `docs/data/`。也可以手动触发。

## 怎么用

1. 左侧搜代码或点自选，加载日 K / 周 K / 小时 / 分钟线。
2. 右侧选策略、改参数、设初始资金、手续费和滑点。
3. 点「运行回测」。买卖点画在 K 线上，下面是绩效和成交。绩效会拆开前 70% 和后 30%，用来看后面还赚不赚。
4. 「跑全部策略」用各自的默认参数、同一套费用做横向比较。点一行会按那套默认参数重跑。
5. 「加入对比」把当前净值叠上去，最多 5 条。
6. 「参数扫描」对一个数字参数做最多 36 组对比，点结果行会按那组参数重跑。
7. 「手动模拟」按最新价立刻记账，和回测不是同一套撮合。

快捷键：Ctrl+Enter 运行回测。图表可滚轮缩放、拖拽平移、双击复位。

## 成交规则

- 信号在当根收盘确认，下一根开盘成交。策略看不到未来 K 线。
- 买入价加滑点，卖出价减滑点，两边都收手续费。1 bp = 0.01%。
- 默认满仓或空仓，不使用杠杆。勾选「允许做空」后，策略可以返回 -1。
- 信号不变就不再平衡，避免每天微调产生手续费。
- 价格默认使用复权价，拆股不会被看成暴跌。复权价近似包含分红，不是精确的现金分红再投资。
- 分钟线大约只能回溯 60 天，小时线大约 700 天。这是行情源的限制。

## 行情从哪来

美股优先用 Yahoo Finance。A 股日K、周K用腾讯前复权，分钟线也用腾讯，名称搜索用东方财富。代码可以写 `600519` 或 `600519.SH`。这些都是非官方接口，可能延迟或缺失，结果缓存在 `data/cache`。

连不上时，如果 `data/imports/NVDA.csv` 存在，日 K 会改用这个文件。表头：

```text
date,open,high,low,close,volume
2024-01-02,100,102,99,101,1000000
```

## 加一个自己的策略

复制 `strategies_user/volume_sma.py`，改类名和 `id`，保存后刷新页面。

```python
from simtrader.strategies import Strategy

class MyStrategy(Strategy):
    id = "my_strategy"
    name = "我的策略"
    description = "一句话说清买卖规则。"
    params_schema = [
        {"key": "period", "label": "周期", "type": "int", "default": 20, "min": 2, "max": 200, "step": 1},
    ]

    def on_bar(self, view):
        # 返回 1 满仓，0 空仓，-1 满仓做空，None 表示保持。
        # view.close / high / low / volume 只包含当前和以前的 K 线。
        if len(view.close) < self.params["period"]:
            return 0.0
        return 1.0 if view.price > max(view.close[-self.params["period"]:-1]) else 0.0
```

`prepare(closes, highs, lows, volumes)` 可以预计算指标，但第 i 个值只能依赖下标小于等于 i 的数据。`overlays()` 返回要画在价格图上的线。

## 这不是什么

不是券商，不能真买卖。回测收益不代表以后还能赚到。默认没有杠杆，也不模拟永续合约的资金费率。夏普按无风险利率 0 计算。
