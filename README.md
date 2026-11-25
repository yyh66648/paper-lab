# 纸面实验室

本地美股策略回测台。不需要券商账户，也不会下真实订单。

## 启动

在这个目录打开终端，运行：

```bat
python run.py
```

然后打开 http://127.0.0.1:8765 。只监听本机。按 Ctrl+C 停止。

如果 `python` 不在 PATH 里，用你机器上的 Python 3.12 运行 `run.py` 即可。不需要安装第三方包，标准库加上 numpy 就够。

不联网的引擎自检：

```bat
python run.py --selftest
```

## 怎么用

1. 左侧搜代码或点自选，加载日 K / 周 K / 小时 / 分钟线。
2. 右侧选策略、改参数、设初始资金、手续费和滑点。
3. 点「运行回测」。买卖点画在 K 线上，下面是绩效和成交。
4. 「加入对比」把当前净值叠上去，最多 5 条。
5. 「参数扫描」对一个数字参数做最多 36 组对比，点结果行会按那组参数重跑。
6. 「手动模拟」按最新价立刻记账，和回测不是同一套撮合。

快捷键：Ctrl+Enter 运行回测。图表可滚轮缩放、拖拽平移、双击复位。

## 成交规则

- 信号在当根收盘确认，下一根开盘成交。策略看不到未来 K 线。
- 买入价加滑点，卖出价减滑点，两边都收手续费。1 bp = 0.01%。
- 默认满仓或空仓，不使用杠杆。勾选「允许做空」后，策略可以返回 -1。
- 信号不变就不再平衡，避免每天微调产生手续费。
- 价格默认使用复权价，拆股不会被看成暴跌。复权价近似包含分红，不是精确的现金分红再投资。
- 分钟线大约只能回溯 60 天，小时线大约 700 天。这是行情源的限制。

## 行情从哪来

优先用 Yahoo Finance 的图表接口，结果缓存在 `data/cache`。这是非官方接口，可能延迟、缺失，或某一天连不上。

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
