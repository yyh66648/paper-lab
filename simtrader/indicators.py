"""因果指标。序列函数的第 i 个值只使用下标 <= i 的价格。"""

from __future__ import annotations


def sma(values, n: int):
    if values is None or n <= 0 or len(values) < n:
        return None
    window = values[-n:]
    return float(sum(window) / n)


def sma_series(values, n: int) -> list:
    out = [None] * len(values)
    if n <= 0:
        return out
    total = 0.0
    for i, value in enumerate(values):
        total += float(value)
        if i >= n:
            total -= float(values[i - n])
        if i >= n - 1:
            out[i] = total / n
    return out


def ema_series(values, n: int) -> list:
    out = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    k = 2.0 / (n + 1.0)
    ema = sum(float(v) for v in values[:n]) / n
    out[n - 1] = ema
    for i in range(n, len(values)):
        ema = float(values[i]) * k + ema * (1.0 - k)
        out[i] = ema
    return out


def rsi_series(values, n: int) -> list:
    out = [None] * len(values)
    if n <= 0 or len(values) <= n:
        return out
    gain_sum = 0.0
    loss_sum = 0.0
    for i in range(1, n + 1):
        delta = float(values[i]) - float(values[i - 1])
        if delta >= 0:
            gain_sum += delta
        else:
            loss_sum -= delta
    avg_gain = gain_sum / n
    avg_loss = loss_sum / n
    out[n] = _rsi(avg_gain, avg_loss)
    for i in range(n + 1, len(values)):
        delta = float(values[i]) - float(values[i - 1])
        gain = delta if delta > 0 else 0.0
        loss = -delta if delta < 0 else 0.0
        avg_gain = (avg_gain * (n - 1) + gain) / n
        avg_loss = (avg_loss * (n - 1) + loss) / n
        out[i] = _rsi(avg_gain, avg_loss)
    return out


def _rsi(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def bollinger_series(values, n: int, k: float) -> tuple[list, list, list]:
    mid = sma_series(values, n)
    upper = [None] * len(values)
    lower = [None] * len(values)
    if n <= 0:
        return mid, upper, lower
    for i in range(n - 1, len(values)):
        mu = mid[i]
        if mu is None:
            continue
        window = values[i - n + 1 : i + 1]
        var = sum((float(x) - mu) ** 2 for x in window) / n
        sd = var ** 0.5
        upper[i] = mu + k * sd
        lower[i] = mu - k * sd
    return mid, upper, lower


def macd_series(values, fast: int, slow: int, signal: int) -> tuple[list, list]:
    fast_line = ema_series(values, fast)
    slow_line = ema_series(values, slow)
    macd = [None] * len(values)
    usable = []
    usable_at = []
    for i, (a, b) in enumerate(zip(fast_line, slow_line)):
        if a is None or b is None:
            continue
        macd[i] = a - b
        usable.append(macd[i])
        usable_at.append(i)
    signal_line = [None] * len(values)
    seeded = ema_series(usable, signal)
    for idx, value in zip(usable_at, seeded):
        signal_line[idx] = value
    return macd, signal_line


def donchian_prior(highs, lows, entry_n: int, exit_n: int) -> tuple[list, list]:
    """前 N 根（不含当根）的最高价 / 最低价。当根收盘突破它，才算突破。"""
    upper = [None] * len(highs)
    lower = [None] * len(lows)
    for i in range(len(highs)):
        if i >= entry_n:
            upper[i] = max(float(x) for x in highs[i - entry_n : i])
        if i >= exit_n:
            lower[i] = min(float(x) for x in lows[i - exit_n : i])
    return upper, lower
