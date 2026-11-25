"""逐根 K 线回测。信号在收盘确认，下一根开盘成交，避免用到未来价格。"""

from __future__ import annotations

from simtrader.strategies import BuyHold, Strategy


class EngineError(Exception):
    pass


class _Tail:
    def __init__(self, values, end: int):
        self._values = values
        self._end = end

    def __len__(self) -> int:
        return self._end

    def __getitem__(self, idx):
        if isinstance(idx, slice):
            start, stop, step = idx.indices(self._end)
            return self._values[start:stop:step]
        if idx < 0:
            idx += self._end
        if idx < 0 or idx >= self._end:
            raise IndexError(idx)
        return self._values[idx]


class View:
    def __init__(self, i, opens, highs, lows, closes, volumes, position, cash, equity, symbol):
        self.i = i
        self.symbol = symbol
        self.position = position
        self.cash = cash
        self.equity = equity
        self.open = _Tail(opens, i + 1)
        self.high = _Tail(highs, i + 1)
        self.low = _Tail(lows, i + 1)
        self.close = _Tail(closes, i + 1)
        self.volume = _Tail(volumes, i + 1)

    @property
    def price(self) -> float:
        return float(self.close[-1])


class PositionBook:
    """把成交还原成回合。翻仓的一笔成交会拆成平仓和开仓。"""

    def __init__(self):
        self.qty = 0
        self.avg = 0.0
        self.entry_time = None
        self.entry_label = ""
        self.entry_index = None
        self.fee_pool = 0.0
        self.note = ""
        self.closed: list[dict] = []

    def apply(self, fill: dict) -> None:
        qty = int(fill["qty"])
        if qty <= 0:
            return
        signed = qty if fill["side"] == "buy" else -qty
        price = float(fill["price"])
        fee = float(fill["fee"])
        remaining = signed
        remaining_fee = fee
        if self.qty != 0 and (self.qty > 0) != (remaining > 0):
            close_qty = min(abs(self.qty), abs(remaining))
            portion = close_qty / abs(signed)
            fee_close = remaining_fee * portion
            entry_fee = self.fee_pool * (close_qty / abs(self.qty))
            side = "long" if self.qty > 0 else "short"
            gross = (price - self.avg) * close_qty if side == "long" else (self.avg - price) * close_qty
            pnl = gross - fee_close - entry_fee
            cost = self.avg * close_qty
            self.closed.append(self._trade(side, close_qty, price, pnl, cost, fill, open_trade=False))
            self.fee_pool -= entry_fee
            self.qty += close_qty if self.qty < 0 else -close_qty
            remaining += close_qty if remaining < 0 else -close_qty
            remaining_fee -= fee_close
            if self.qty == 0:
                self.avg = 0.0
                self.entry_time = None
                self.entry_label = ""
                self.entry_index = None
                self.fee_pool = 0.0
                self.note = ""
        if remaining != 0:
            add = abs(remaining)
            if self.qty == 0:
                self.avg = price
                self.qty = remaining
                self.entry_time = fill["t"]
                self.entry_label = fill["label"]
                self.entry_index = fill["bar_index"]
                self.fee_pool = remaining_fee
                self.note = fill.get("note") or ""
            else:
                self.avg = (self.avg * abs(self.qty) + price * add) / (abs(self.qty) + add)
                self.fee_pool += remaining_fee
                self.qty += remaining

    def _trade(self, side, qty, exit_price, pnl, cost, fill, open_trade: bool) -> dict:
        entry_index = self.entry_index
        exit_index = fill["bar_index"]
        return {
            "side": side,
            "entry_time": self.entry_time,
            "entry_label": self.entry_label,
            "exit_time": None if open_trade else fill["t"],
            "exit_label": None if open_trade else fill["label"],
            "qty": qty,
            "entry_price": self.avg,
            "exit_price": exit_price,
            "pnl": pnl,
            "return_pct": (pnl / cost) if cost else None,
            "bars_held": None if entry_index is None else exit_index - entry_index,
            "note": self.note,
            "open": open_trade,
        }

    def open_trade(self, last_bar: dict, last_index: int) -> dict | None:
        if self.qty == 0:
            return None
        price = float(last_bar["c"])
        side = "long" if self.qty > 0 else "short"
        qty = abs(self.qty)
        pnl = (price - self.avg) * qty if side == "long" else (self.avg - price) * qty
        pnl -= self.fee_pool
        fake_fill = {"t": last_bar["t"], "label": last_bar["label"], "bar_index": last_index}
        return self._trade(side, qty, price, pnl, self.avg * qty, fake_fill, open_trade=True)


def _clamp_weight(weight: float, allow_short: bool) -> float:
    if not allow_short:
        return max(0.0, min(1.0, weight))
    return max(-1.0, min(1.0, weight))


def _execute(cash, position, target_pct, open_px, commission_rate, slippage_bps, allow_short):
    if open_px is None or open_px <= 0:
        return cash, position, None
    target_pct = _clamp_weight(float(target_pct), allow_short)
    equity = cash + position * open_px
    if equity <= 0:
        return cash, position, None
    slip = slippage_bps / 10000.0
    size_px = open_px * (1.0 + slip if target_pct >= 0 else 1.0 - slip)
    if size_px <= 0:
        return cash, position, None
    desired = int(equity * target_pct / size_px)
    delta = desired - int(position)
    if delta == 0:
        return cash, position, None
    side_sign = 1 if delta > 0 else -1
    fill_px = open_px * (1.0 + slip if delta > 0 else 1.0 - slip)
    qty = abs(delta)
    if side_sign > 0:
        unit = fill_px * (1.0 + commission_rate)
        affordable = int(cash / unit) if unit > 0 else 0
        qty = min(qty, max(0, affordable))
    if qty <= 0:
        return cash, position, None
    fee = qty * fill_px * commission_rate
    cash = cash - side_sign * qty * fill_px - fee
    position = int(position) + side_sign * qty
    return cash, position, {
        "side": "buy" if side_sign > 0 else "sell",
        "qty": qty,
        "price": fill_px,
        "fee": fee,
    }


def run_backtest(
    bars: list[dict],
    strategy: Strategy,
    cash: float = 100_000.0,
    commission_bps: float = 1.0,
    slippage_bps: float = 5.0,
    allow_short: bool = False,
    bench_bars: list[dict] | None = None,
    symbol: str = "",
    include_benchmark: bool = True,
) -> dict:
    if len(bars) < 2:
        raise EngineError("K 线不足，无法回测。")
    opens = [bar["o"] for bar in bars]
    highs = [bar["h"] for bar in bars]
    lows = [bar["l"] for bar in bars]
    closes = [bar["c"] for bar in bars]
    volumes = [bar["v"] for bar in bars]
    if hasattr(strategy, "prepare"):
        strategy.prepare(closes, highs, lows, volumes)

    commission_rate = commission_bps / 10000.0
    result = _simulate(
        bars, strategy, float(cash), commission_rate, slippage_bps, allow_short, symbol=symbol
    )
    if include_benchmark:
        bench_source = bars if bench_bars is None else _align(bars, bench_bars)
        benchmark = _simulate(
            bench_source,
            BuyHold(),
            float(cash),
            commission_rate,
            slippage_bps,
            False,
            symbol="",
        )
        bench_values = benchmark["equity_values"]
        bench_fees = benchmark["fees"]
    else:
        bench_values = [None] * len(bars)
        bench_fees = 0.0
    drawdowns = _drawdowns(float(cash), result["equity_values"])
    equity = []
    for i, bar in enumerate(bars):
        equity.append(
            {
                "t": bar["t"],
                "label": bar["label"],
                "equity": result["equity_values"][i],
                "bench": bench_values[i],
                "drawdown": drawdowns[i],
                "position": result["positions"][i],
                "close": bar["c"],
            }
        )
    warnings = list(result["warnings"])
    if result["pending"] is not None:
        warnings.append("最后一根 K 线出现了新信号。按规则要下一根开盘才成交，所以这笔没有算进样本。")
    return {
        "equity": equity,
        "trades": result["trades"],
        "markers": result["markers"],
        "warnings": warnings,
        "fees": result["fees"],
        "ending_equity": result["equity_values"][-1],
        "ending_cash": result["cash"],
        "ending_position": result["position"],
        "ending_signal": result["last_signal"],
        "bench_equity": bench_values,
        "bench_fees": bench_fees,
    }


def _align(primary: list[dict], other: list[dict]) -> list[dict]:
    aligned = []
    j = 0
    last = None
    for bar in primary:
        while j < len(other) and other[j]["t"] <= bar["t"]:
            last = other[j]
            j += 1
        if last is None:
            aligned.append({**bar, "o": None, "h": None, "l": None, "c": None, "v": 0})
        else:
            aligned.append(
                {
                    "t": bar["t"],
                    "label": bar["label"],
                    "o": last["o"],
                    "h": last["h"],
                    "l": last["l"],
                    "c": last["c"],
                    "v": last.get("v") or 0,
                }
            )
    return aligned


def _drawdowns(initial: float, equities: list[float]) -> list[float]:
    peak = initial
    out = []
    for equity in equities:
        peak = max(peak, equity)
        out.append(equity / peak - 1.0 if peak else 0.0)
    return out


def _simulate(bars, strategy, cash, commission_rate, slippage_bps, allow_short, symbol) -> dict:
    opens = [bar.get("o") for bar in bars]
    highs = [bar.get("h") for bar in bars]
    lows = [bar.get("l") for bar in bars]
    closes = [bar.get("c") for bar in bars]
    volumes = [bar.get("v") or 0 for bar in bars]
    position = 0
    pending = strategy.on_start()
    last_signal = 0.0 if pending is None else _clamp_weight(float(pending), allow_short)
    if pending is not None:
        pending = last_signal
    pending_note = getattr(strategy, "note", "") or ""
    book = PositionBook()
    markers = []
    warnings = []
    fees = 0.0
    equity_values = []
    positions = []
    clamped = False

    for i, bar in enumerate(bars):
        if pending is not None and bar.get("o"):
            cash, position, fill = _execute(
                cash, position, pending, bar["o"], commission_rate, slippage_bps, allow_short
            )
            if fill is not None:
                fill.update(
                    {
                        "t": bar["t"],
                        "label": bar["label"],
                        "bar_index": i,
                        "note": pending_note,
                    }
                )
                fees += fill["fee"]
                book.apply(fill)
                markers.append(
                    {
                        "t": bar["t"],
                        "label": bar["label"],
                        "side": fill["side"],
                        "price": fill["price"],
                        "qty": fill["qty"],
                        "note": pending_note,
                    }
                )
            pending = None
            pending_note = ""

        mark = bar["c"] if bar.get("c") else (opens[i] or 0)
        equity = cash + position * (mark or 0)
        equity_values.append(equity)
        positions.append(position)
        view = View(i, opens, highs, lows, closes, volumes, position, cash, equity, symbol)
        try:
            signal = strategy.on_bar(view)
        except Exception as exc:
            raise EngineError(f"策略在 {bar.get('label') or i} 出错：{exc}") from exc
        if signal is None:
            continue
        try:
            raw = float(signal)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"策略必须返回目标仓位（0 到 1 的数字），收到的是 {signal!r}。") from exc
        clipped = _clamp_weight(raw, allow_short)
        if not clamped and abs(clipped - raw) > 1e-9:
            clamped = True
            if not allow_short and raw < 0:
                warnings.append("策略给出了空头仓位，但当前没有允许做空，已按空仓处理。")
            else:
                warnings.append("策略仓位超出 -1 到 1，已截断。默认不使用杠杆。")
        if abs(clipped - last_signal) > 1e-9:
            pending = clipped
            pending_note = getattr(strategy, "note", "") or ""
            last_signal = clipped

    trades = list(book.closed)
    open_trade = book.open_trade(bars[-1], len(bars) - 1)
    if open_trade is not None:
        trades.append(open_trade)
    return {
        "equity_values": equity_values,
        "positions": positions,
        "trades": trades,
        "markers": markers,
        "warnings": warnings,
        "fees": fees,
        "cash": cash,
        "position": position,
        "last_signal": last_signal,
        "pending": pending,
    }
