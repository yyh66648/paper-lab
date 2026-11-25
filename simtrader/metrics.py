"""绩效统计。夏普按无风险利率 0 计算，年化用美股常规交易根数。"""

from __future__ import annotations

import math

import numpy as np

BARS_PER_YEAR = {
    "1d": 252,
    "1wk": 52,
    "1h": 1638,
    "15m": 6552,
    "5m": 19656,
}


def summarize(initial: float, equity_rows: list[dict], trades: list[dict], fees: float, interval: str) -> dict:
    equities = [float(row["equity"]) for row in equity_rows]
    times = [int(row["t"]) for row in equity_rows]
    ending = equities[-1] if equities else initial
    total_return = ending / initial - 1.0 if initial else None
    years = 0.0
    if len(times) >= 2:
        years = max(0.0, (times[-1] - times[0]) / (365.25 * 86400))
    cagr = None
    if years > 1 / 365.25 and initial > 0 and ending > 0:
        cagr = (ending / initial) ** (1.0 / years) - 1.0

    returns = []
    prev = initial
    for equity in equities:
        if prev > 0:
            returns.append(equity / prev - 1.0)
        prev = equity
    volatility = sharpe = sortino = None
    bars_per_year = BARS_PER_YEAR.get(interval, 252)
    if len(returns) >= 2:
        arr = np.asarray(returns, dtype=float)
        std = float(arr.std(ddof=1))
        mean = float(arr.mean())
        if std > 0:
            volatility = std * math.sqrt(bars_per_year)
            sharpe = mean / std * math.sqrt(bars_per_year)
        downside = float(np.sqrt(np.mean(np.minimum(arr, 0.0) ** 2)))
        if downside > 0:
            sortino = mean / downside * math.sqrt(bars_per_year)

    drawdowns = [float(row.get("drawdown") or 0.0) for row in equity_rows]
    max_drawdown = min(drawdowns) if drawdowns else 0.0
    calmar = cagr / abs(max_drawdown) if cagr is not None and max_drawdown < 0 else None
    closed = [trade for trade in trades if not trade.get("open")]
    wins = [trade for trade in closed if (trade.get("pnl") or 0) > 0]
    losses = [trade for trade in closed if (trade.get("pnl") or 0) < 0]
    gross_profit = sum(trade["pnl"] for trade in wins)
    gross_loss = sum(trade["pnl"] for trade in losses)
    profit_factor = gross_profit / abs(gross_loss) if gross_loss < 0 else None
    holds = [trade["bars_held"] for trade in closed if trade.get("bars_held") is not None]
    returns_closed = [trade["return_pct"] for trade in closed if trade.get("return_pct") is not None]
    exposure = 0.0
    if equity_rows:
        exposure = sum(1 for row in equity_rows if row.get("position")) / len(equity_rows)
    last = equity_rows[-1] if equity_rows else {}
    ending_weight = None
    if last.get("equity"):
        ending_weight = float(last.get("position") or 0) * float(last.get("close") or 0) / float(last["equity"])
    return {
        "total_return": total_return,
        "cagr": cagr,
        "volatility": volatility,
        "sharpe": sharpe,
        "sortino": sortino,
        "max_drawdown": max_drawdown,
        "max_drawdown_days": _underwater_days(times, equities, initial),
        "calmar": calmar,
        "win_rate": (len(wins) / len(closed)) if closed else None,
        "profit_factor": profit_factor,
        "trades": len(closed),
        "open_trades": sum(1 for trade in trades if trade.get("open")),
        "wins": len(wins),
        "losses": len(losses),
        "avg_trade_return": (sum(returns_closed) / len(returns_closed)) if returns_closed else None,
        "avg_hold_bars": (sum(holds) / len(holds)) if holds else None,
        "exposure": exposure,
        "fees": float(fees or 0),
        "ending_equity": ending,
        "ending_weight": ending_weight,
        "years": years,
    }


def equity_rows_from_values(template: list[dict], values: list[float], initial: float) -> list[dict]:
    peak = initial
    rows = []
    for row, equity in zip(template, values):
        peak = max(peak, equity)
        rows.append(
            {
                "t": row["t"],
                "equity": equity,
                "drawdown": (equity / peak - 1.0) if peak else 0.0,
                "position": 1 if equity != initial else 0,
                "close": row.get("close") or 0,
            }
        )
    return rows


def _underwater_days(times: list[int], equities: list[float], initial: float) -> int:
    if not times:
        return 0
    peak = initial
    start = None
    longest = 0.0
    for ts, equity in zip(times, equities):
        if equity >= peak - 1e-8:
            peak = equity
            if start is not None:
                longest = max(longest, ts - start)
                start = None
        elif start is None:
            start = ts
    if start is not None:
        longest = max(longest, times[-1] - start)
    return int(round(longest / 86400))
