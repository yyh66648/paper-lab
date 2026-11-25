"""内置策略，以及 strategies_user 目录里的自定义策略。

约定：
- on_start / on_bar 返回目标仓位。1 是满仓多头，0 是空仓，-1 是满仓空头。
- 返回 None 表示保持当前信号。
- 成交发生在下一根 K 线开盘。信号不变时不会为了再平衡而反复下单。
- prepare 可以预计算指标。第 i 个值只能依赖下标 <= i 的数据。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from simtrader.data import DataError
from simtrader.indicators import (
    bollinger_series,
    donchian_prior,
    ema_series,
    macd_series,
    rsi_series,
    sma,
    sma_series,
)

ROOT = Path(__file__).resolve().parent.parent
USER_DIR = ROOT / "strategies_user"


def coerce_params(schema: list[dict], raw: dict) -> dict:
    params = {}
    for spec in schema:
        key = spec["key"]
        label = spec.get("label") or key
        value = raw.get(key, spec.get("default"))
        kind = spec.get("type", "float")
        if kind == "bool":
            params[key] = bool(value)
            continue
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise DataError(f"参数「{label}」需要填数字。") from exc
        if kind == "int":
            number = int(round(number))
        minimum = spec.get("min")
        maximum = spec.get("max")
        if minimum is not None and number < minimum:
            number = int(minimum) if kind == "int" else float(minimum)
        if maximum is not None and number > maximum:
            number = int(maximum) if kind == "int" else float(maximum)
        params[key] = int(number) if kind == "int" else float(number)
    return params


class Strategy:
    id = "base"
    name = "未命名"
    description = ""
    params_schema: list[dict] = []

    def __init__(self, params=None):
        self.params = coerce_params(self.params_schema, params or {})
        self.note = ""

    def on_start(self):
        return None

    def prepare(self, closes, highs, lows, volumes):
        return None

    def on_bar(self, view):
        return None

    def overlays(self):
        return []

    def validate(self):
        return None


class BuyHold(Strategy):
    id = "buy_hold"
    name = "买入持有"
    description = "第一根 K 线开盘满仓，一直拿到样本结束。它不是交易系统，是用来比较的尺子。"

    def on_start(self):
        self.note = "买入持有"
        return 1.0

    def on_bar(self, view):
        return 1.0


class SmaCross(Strategy):
    id = "sma_cross"
    name = "双均线"
    description = "短均线高于长均线就满仓，否则空仓。趋势来了跟得上，震荡市会被来回打脸。"
    params_schema = [
        {"key": "fast", "label": "短均线", "type": "int", "default": 20, "min": 2, "max": 120, "step": 1},
        {"key": "slow", "label": "长均线", "type": "int", "default": 60, "min": 5, "max": 300, "step": 1},
    ]

    def validate(self):
        if self.params["fast"] >= self.params["slow"]:
            return "短均线周期应小于长均线，否则交叉没有方向。已按你填的参数照跑。"
        return None

    def prepare(self, closes, highs, lows, volumes):
        self.fast_line = sma_series(closes, self.params["fast"])
        self.slow_line = sma_series(closes, self.params["slow"])

    def on_bar(self, view):
        fast = self.fast_line[view.i]
        slow = self.slow_line[view.i]
        if fast is None or slow is None:
            return 0.0
        if fast > slow:
            self.note = "短均线在上方"
            return 1.0
        self.note = "短均线不在上方"
        return 0.0

    def overlays(self):
        return [
            {"name": f"SMA {self.params['fast']}", "color": "#d6a25a", "values": self.fast_line},
            {"name": f"SMA {self.params['slow']}", "color": "#7ea4c4", "values": self.slow_line},
        ]


class EmaCross(Strategy):
    id = "ema_cross"
    name = "EMA 交叉"
    description = "规则和双均线相同，用指数移动平均，最近的价格权重更高，信号会更早，也更容易反复。"
    params_schema = [
        {"key": "fast", "label": "短 EMA", "type": "int", "default": 12, "min": 2, "max": 120, "step": 1},
        {"key": "slow", "label": "长 EMA", "type": "int", "default": 26, "min": 5, "max": 300, "step": 1},
    ]

    def validate(self):
        if self.params["fast"] >= self.params["slow"]:
            return "短 EMA 应小于长 EMA。已按你填的参数照跑。"
        return None

    def prepare(self, closes, highs, lows, volumes):
        self.fast_line = ema_series(closes, self.params["fast"])
        self.slow_line = ema_series(closes, self.params["slow"])

    def on_bar(self, view):
        fast = self.fast_line[view.i]
        slow = self.slow_line[view.i]
        if fast is None or slow is None:
            return 0.0
        if fast > slow:
            self.note = "短 EMA 在上方"
            return 1.0
        self.note = "短 EMA 不在上方"
        return 0.0

    def overlays(self):
        return [
            {"name": f"EMA {self.params['fast']}", "color": "#d6a25a", "values": self.fast_line},
            {"name": f"EMA {self.params['slow']}", "color": "#7ea4c4", "values": self.slow_line},
        ]


class BollingerReversion(Strategy):
    id = "bollinger"
    name = "布林带回归"
    description = "收盘跌破下轨买入，回到中轨卖出。赌价格会回到均值；单边行情里会一直接飞刀。"
    params_schema = [
        {"key": "period", "label": "周期", "type": "int", "default": 20, "min": 5, "max": 120, "step": 1},
        {"key": "k", "label": "带宽倍数", "type": "float", "default": 2.0, "min": 0.5, "max": 4, "step": 0.1},
    ]

    def prepare(self, closes, highs, lows, volumes):
        self.mid, self.upper, self.lower = bollinger_series(closes, self.params["period"], self.params["k"])

    def on_bar(self, view):
        mid = self.mid[view.i]
        lower = self.lower[view.i]
        if mid is None or lower is None:
            return None
        if view.price < lower:
            self.note = "跌破下轨"
            return 1.0
        if view.price > mid:
            self.note = "回到中轨"
            return 0.0
        return None

    def overlays(self):
        return [
            {"name": "中轨", "color": "#d6a25a", "values": self.mid},
            {"name": "上轨", "color": "#8b97a7", "values": self.upper},
            {"name": "下轨", "color": "#8b97a7", "values": self.lower},
        ]


class RsiReversion(Strategy):
    id = "rsi"
    name = "RSI 回归"
    description = "RSI 低于超卖线买入，高于超买线卖出。阈值越极端，交易越少，错过的行情也越多。"
    params_schema = [
        {"key": "period", "label": "RSI 周期", "type": "int", "default": 14, "min": 2, "max": 60, "step": 1},
        {"key": "oversold", "label": "超卖线", "type": "float", "default": 30, "min": 5, "max": 50, "step": 1},
        {"key": "overbought", "label": "超买线", "type": "float", "default": 70, "min": 50, "max": 95, "step": 1},
    ]

    def validate(self):
        if self.params["oversold"] >= self.params["overbought"]:
            return "超卖线应低于超买线。已按你填的参数照跑。"
        return None

    def prepare(self, closes, highs, lows, volumes):
        self.rsi = rsi_series(closes, self.params["period"])

    def on_bar(self, view):
        value = self.rsi[view.i]
        if value is None:
            return None
        if value < self.params["oversold"]:
            self.note = "超卖"
            return 1.0
        if value > self.params["overbought"]:
            self.note = "超买"
            return 0.0
        return None


class DonchianBreakout(Strategy):
    id = "donchian"
    name = "唐奇安突破"
    description = "收盘突破前 N 日最高价买入，跌破前 M 日最低价卖出。信号少，亏的时候往往亏掉一整段通道。"
    params_schema = [
        {"key": "entry", "label": "突破周期", "type": "int", "default": 20, "min": 2, "max": 120, "step": 1},
        {"key": "exit", "label": "离场周期", "type": "int", "default": 10, "min": 2, "max": 120, "step": 1},
    ]

    def prepare(self, closes, highs, lows, volumes):
        self.upper, self.lower = donchian_prior(highs, lows, self.params["entry"], self.params["exit"])

    def on_bar(self, view):
        upper = self.upper[view.i]
        lower = self.lower[view.i]
        if upper is not None and view.price > upper:
            self.note = "突破上轨"
            return 1.0
        if lower is not None and view.price < lower:
            self.note = "跌破下轨"
            return 0.0
        return None

    def overlays(self):
        return [
            {"name": f"{self.params['entry']}日高", "color": "#d6a25a", "values": self.upper},
            {"name": f"{self.params['exit']}日低", "color": "#7ea4c4", "values": self.lower},
        ]


class MacdCross(Strategy):
    id = "macd"
    name = "MACD 交叉"
    description = "MACD 上穿信号线买入，下穿卖出。这是滞后指标，交叉出现时行情往往已经走了一段。"
    params_schema = [
        {"key": "fast", "label": "快线", "type": "int", "default": 12, "min": 2, "max": 60, "step": 1},
        {"key": "slow", "label": "慢线", "type": "int", "default": 26, "min": 5, "max": 120, "step": 1},
        {"key": "signal", "label": "信号线", "type": "int", "default": 9, "min": 2, "max": 40, "step": 1},
    ]

    def validate(self):
        if self.params["fast"] >= self.params["slow"]:
            return "快线应小于慢线。已按你填的参数照跑。"
        return None

    def prepare(self, closes, highs, lows, volumes):
        self.macd, self.signal = macd_series(
            closes, self.params["fast"], self.params["slow"], self.params["signal"]
        )

    def on_bar(self, view):
        i = view.i
        if i == 0 or self.macd[i] is None or self.signal[i] is None:
            return None
        if self.macd[i - 1] is None or self.signal[i - 1] is None:
            return None
        if self.macd[i - 1] <= self.signal[i - 1] and self.macd[i] > self.signal[i]:
            self.note = "金叉"
            return 1.0
        if self.macd[i - 1] >= self.signal[i - 1] and self.macd[i] < self.signal[i]:
            self.note = "死叉"
            return 0.0
        return None


class TrendPullback(Strategy):
    id = "trend_pullback"
    name = "趋势回撤"
    description = "价格在长均线之上、RSI 回落到买入线时进场；跌破长均线或 RSI 过热就离场。只想在上升趋势里买回调。"
    params_schema = [
        {"key": "trend", "label": "趋势均线", "type": "int", "default": 100, "min": 20, "max": 300, "step": 1},
        {"key": "rsi", "label": "RSI 周期", "type": "int", "default": 14, "min": 2, "max": 40, "step": 1},
        {"key": "buy", "label": "买入 RSI", "type": "float", "default": 40, "min": 10, "max": 60, "step": 1},
        {"key": "exit", "label": "离场 RSI", "type": "float", "default": 70, "min": 50, "max": 90, "step": 1},
    ]

    def validate(self):
        if self.params["buy"] >= self.params["exit"]:
            return "买入 RSI 应低于离场 RSI。已按你填的参数照跑。"
        return None

    def prepare(self, closes, highs, lows, volumes):
        self.trend = sma_series(closes, self.params["trend"])
        self.rsi = rsi_series(closes, self.params["rsi"])

    def on_bar(self, view):
        trend = self.trend[view.i]
        value = self.rsi[view.i]
        if trend is None or value is None:
            return None
        if view.price < trend:
            self.note = "跌破趋势"
            return 0.0
        if value >= self.params["exit"]:
            self.note = "过热离场"
            return 0.0
        if value <= self.params["buy"]:
            self.note = "趋势中回撤"
            return 1.0
        return None

    def overlays(self):
        return [{"name": f"SMA {self.params['trend']}", "color": "#d6a25a", "values": self.trend}]


BUILTINS = [
    BuyHold,
    SmaCross,
    EmaCross,
    BollingerReversion,
    RsiReversion,
    DonchianBreakout,
    MacdCross,
    TrendPullback,
]


def _load_user_classes(path: Path) -> list[type]:
    root = str(ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    module_name = f"userstrat_{path.stem}_{int(path.stat().st_mtime)}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise DataError("无法读取策略文件。")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    found = []
    for obj in vars(module).values():
        if isinstance(obj, type) and issubclass(obj, Strategy) and obj is not Strategy and getattr(obj, "id", "base") != "base":
            found.append(obj)
    return found


def strategy_catalog() -> tuple[list[type], list[str]]:
    classes = list(BUILTINS)
    seen = {cls.id for cls in classes}
    warnings = []
    if not USER_DIR.exists():
        return classes, warnings
    for path in sorted(USER_DIR.glob("*.py")):
        if path.name.startswith("_"):
            continue
        try:
            loaded = _load_user_classes(path)
        except Exception as exc:
            warnings.append(f"{path.name} 没有载入：{exc}")
            continue
        if not loaded:
            warnings.append(f"{path.name} 里没有找到策略类。")
        for cls in loaded:
            if cls.id in seen:
                warnings.append(f"{path.name} 的 id「{cls.id}」和已有策略重复，已跳过。")
                continue
            seen.add(cls.id)
            cls.origin = "user"
            classes.append(cls)
    return classes, warnings


def describe_strategy(cls: type) -> dict:
    return {
        "id": cls.id,
        "name": cls.name,
        "description": cls.description,
        "params": cls.params_schema,
        "origin": "user" if getattr(cls, "origin", "") == "user" or cls not in BUILTINS else "builtin",
    }


def create_strategy(strategy_id: str, params: dict | None) -> tuple[Strategy, str | None]:
    classes, _warnings = strategy_catalog()
    for cls in classes:
        if cls.id == strategy_id:
            strategy = cls(params or {})
            return strategy, strategy.validate()
    known = "、".join(cls.name for cls in classes)
    raise DataError(f"没有这个策略。当前可用：{known}。")


# 让自定义策略可以直接 from simtrader.strategies import sma
__all__ = ["Strategy", "sma", "create_strategy", "strategy_catalog"]
