"""示例策略。改这个文件，或复制一份再改类名和 id。保存后刷新页面就能在策略列表里看到。

on_bar 只能看当前及以前的 K 线。想画到图上，在 prepare 里预计算，再用 overlays 返回。
"""

from simtrader.indicators import sma, sma_series
from simtrader.strategies import Strategy


class VolumeConfirmedSma(Strategy):
    id = "volume_sma"
    name = "放量均线"
    description = "短均线在长均线上方，并且成交量高于均量时买入；已持仓后不再要求放量。短均线跌破长均线就卖出。这是一个可以直接改的示例。"
    params_schema = [
        {"key": "fast", "label": "短均线", "type": "int", "default": 10, "min": 2, "max": 80, "step": 1},
        {"key": "slow", "label": "长均线", "type": "int", "default": 30, "min": 5, "max": 200, "step": 1},
        {"key": "vol_n", "label": "均量周期", "type": "int", "default": 20, "min": 2, "max": 80, "step": 1},
        {"key": "vol_mult", "label": "放量倍数", "type": "float", "default": 1.2, "min": 0.5, "max": 5, "step": 0.1},
    ]

    def validate(self):
        if self.params["fast"] >= self.params["slow"]:
            return "短均线应小于长均线。已按你填的参数照跑。"
        return None

    def prepare(self, closes, highs, lows, volumes):
        self.fast_line = sma_series(closes, self.params["fast"])
        self.slow_line = sma_series(closes, self.params["slow"])

    def on_bar(self, view):
        fast = self.fast_line[view.i]
        slow = self.slow_line[view.i]
        vol_ma = sma(view.volume, self.params["vol_n"])
        if fast is None or slow is None or vol_ma is None:
            return 0.0
        if fast <= slow:
            self.note = "均线空头"
            return 0.0
        if view.position > 0 or view.volume[-1] >= vol_ma * self.params["vol_mult"]:
            self.note = "趋势持有" if view.position > 0 else "放量跟随"
            return 1.0
        self.note = "量能不足"
        return 0.0

    def overlays(self):
        return [
            {"name": f"SMA {self.params['fast']}", "color": "#d6a25a", "values": self.fast_line},
            {"name": f"SMA {self.params['slow']}", "color": "#7ea4c4", "values": self.slow_line},
        ]
