"""行情：美股走 Yahoo Finance，A 股走腾讯 / 东方财富，另支持本地 CSV。"""

from __future__ import annotations

import csv
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "cache"
IMPORT_DIR = ROOT / "data" / "imports"
NY = ZoneInfo("America/New_York")

INTERVALS = ("1d", "1wk", "1h", "15m", "5m")
INTRADAY_LIMIT_DAYS = {"5m": 55, "15m": 55, "1h": 700}
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


class DataError(Exception):
    pass


def validate_symbol(symbol: str) -> str:
    raw = (symbol or "").strip().upper()
    if not raw or len(raw) > 15:
        raise DataError("请输入代码，例如 NVDA 或 600519。")
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-^")
    if any(ch not in allowed for ch in raw):
        raise DataError("代码只允许字母、数字、点、连字符。")
    return raw


def validate_interval(interval: str) -> str:
    interval = (interval or "1d").strip()
    if interval not in INTERVALS:
        raise DataError("不支持的周期。可用：日K、周K、1小时、15分钟、5分钟。")
    return interval


def parse_date(value: str) -> datetime:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except (TypeError, ValueError) as exc:
        raise DataError("日期格式应为 YYYY-MM-DD。") from exc
    return parsed.replace(tzinfo=NY)


def _label(ts: int, interval: str) -> str:
    dt = datetime.fromtimestamp(ts, NY)
    if interval in ("1d", "1wk"):
        return dt.strftime("%Y-%m-%d")
    return dt.strftime("%Y-%m-%d %H:%M")


def _fetch(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json,text/plain,*/*"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        raise DataError(f"行情源返回 HTTP {exc.code}。") from exc
    except urllib.error.URLError as exc:
        raise DataError(f"连接行情源失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise DataError("连接行情源超时。") from exc


def _yahoo_chart_url(symbol: str, interval: str, period1: int, period2: int, host: str) -> str:
    query = urllib.parse.urlencode(
        {
            "period1": period1,
            "period2": period2,
            "interval": interval,
            "includeAdjustedClose": "true",
            "includePrePost": "false",
            "events": "div|split",
        }
    )
    return f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}?{query}"


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _parse_yahoo(payload: dict, interval: str) -> dict:
    chart = payload.get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        desc = err.get("description") if isinstance(err, dict) else str(err)
        raise DataError(desc or "Yahoo 没有返回这个代码的行情。")
    results = chart.get("result") or []
    if not results:
        raise DataError("Yahoo 没有返回这个代码的行情。代码可能不存在，或该周期没有数据。")
    result = results[0]
    meta = result.get("meta") or {}
    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    adj = ((result.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") or []
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    bars = []
    for i, ts in enumerate(timestamps):
        o = opens[i] if i < len(opens) else None
        h = highs[i] if i < len(highs) else None
        l = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        if not all(_finite(x) and x > 0 for x in (o, h, l, c)):
            continue
        adjusted = adj[i] if i < len(adj) else None
        if _finite(adjusted) and adjusted > 0:
            ratio = adjusted / c
            if _finite(ratio) and ratio > 0:
                o, h, l, c = o * ratio, h * ratio, l * ratio, float(adjusted)
        volume = volumes[i] if i < len(volumes) else 0
        bars.append(
            {
                "t": int(ts),
                "label": _label(int(ts), interval),
                "o": float(o),
                "h": float(h),
                "l": float(l),
                "c": float(c),
                "v": float(volume or 0),
            }
        )
    if not bars:
        raise DataError("这个区间没有可用的 K 线。")
    return {
        "symbol": meta.get("symbol") or "",
        "name": meta.get("longName") or meta.get("shortName") or meta.get("symbol") or "",
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        "currency": meta.get("currency") or "USD",
        "timezone": meta.get("exchangeTimezoneName") or "America/New_York",
        "instrument": meta.get("instrumentType") or "",
        "source": "Yahoo Finance",
        "adjusted": True,
        "bars": bars,
    }


def _symbol_variants(symbol: str) -> list[str]:
    variants = [symbol]
    if "." in symbol:
        variants.append(symbol.replace(".", "-"))
    if "-" in symbol:
        variants.append(symbol.replace("-", "."))
    unique = []
    for item in variants:
        if item not in unique:
            unique.append(item)
    return unique


def fetch_yahoo(symbol: str, interval: str, start: datetime, end: datetime) -> dict:
    period1 = int(start.timestamp())
    period2 = int(end.timestamp()) + 3600
    last_error: Exception | None = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for sym in _symbol_variants(symbol):
            url = _yahoo_chart_url(sym, interval, period1, period2, host)
            try:
                parsed = _parse_yahoo(json.loads(_fetch(url).decode("utf-8")), interval)
            except DataError as exc:
                last_error = exc
                continue
            except json.JSONDecodeError:
                last_error = DataError("行情源返回了无法解析的内容。")
                continue
            parsed["symbol"] = parsed.get("symbol") or sym
            return parsed
    raise last_error or DataError("无法获取行情。")


def _parse_csv_time(raw: str) -> int:
    text = raw.strip().replace("/", "-")
    if text.endswith("Z"):
        text = text[:-1]
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(text, fmt).replace(tzinfo=NY).timestamp())
        except ValueError:
            continue
    raise DataError(f"无法解析 CSV 日期：{raw}")


def load_csv(symbol: str) -> dict | None:
    candidates = [IMPORT_DIR / f"{symbol}.csv", IMPORT_DIR / f"{symbol.replace('-', '.')}.csv"]
    path = next((item for item in candidates if item.exists()), None)
    if path is None:
        return None
    bars = []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise DataError(f"{path.name} 没有表头。")
        fields = {name.strip().lower(): name for name in reader.fieldnames}

        def column(*names: str) -> str | None:
            for name in names:
                if name in fields:
                    return fields[name]
            return None

        c_date = column("date", "datetime", "time", "timestamp")
        c_open = column("open", "o")
        c_high = column("high", "h")
        c_low = column("low", "l")
        c_close = column("close", "adj close", "adj_close", "c")
        c_vol = column("volume", "vol", "v")
        if not all([c_date, c_open, c_high, c_low, c_close]):
            raise DataError("CSV 需要表头 date,open,high,low,close，volume 可选。")
        for row in reader:
            raw_date = (row.get(c_date) or "").strip()
            if not raw_date:
                continue
            ts = _parse_csv_time(raw_date)
            try:
                bars.append(
                    {
                        "t": ts,
                        "label": _label(ts, "1d" if " " not in raw_date else "1h"),
                        "o": float(row[c_open]),
                        "h": float(row[c_high]),
                        "l": float(row[c_low]),
                        "c": float(row[c_close]),
                        "v": float(row[c_vol] or 0) if c_vol else 0.0,
                    }
                )
            except (TypeError, ValueError) as exc:
                raise DataError(f"{path.name} 有无法解析的数字：{raw_date}") from exc
    if not bars:
        raise DataError(f"{path.name} 里没有数据行。")
    bars.sort(key=lambda bar: bar["t"])
    return {
        "symbol": symbol,
        "name": f"{symbol}（本地 CSV）",
        "exchange": "CSV",
        "currency": "USD",
        "timezone": "America/New_York",
        "instrument": "IMPORT",
        "source": f"本地 CSV {path.name}",
        "adjusted": False,
        "bars": bars,
    }


def _cache_path(symbol: str, interval: str, start: str, end: str) -> Path:
    safe = symbol.replace("^", "_").replace(".", "_")
    return CACHE_DIR / f"{safe}_{interval}_{start}_{end}.json"


def _read_cache(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_cache(path: Path, payload: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _join_warning(*parts: str | None) -> str | None:
    text = " ".join(part for part in parts if part)
    return text or None


def _clamp_range(interval: str, start: datetime, end: datetime) -> tuple[datetime, datetime, str | None]:
    if end <= start:
        raise DataError("结束日期必须晚于开始日期。")
    limit = INTRADAY_LIMIT_DAYS.get(interval)
    if limit is None:
        return start, end, None
    earliest = end - timedelta(days=limit)
    if start >= earliest:
        return start, end, None
    return earliest, end, f"{interval} 行情最多回溯约 {limit} 天，已自动缩短区间。"


def _finalize(payload: dict, warning: str | None, start: datetime, end: datetime) -> dict:
    # 只留请求区间内的 K 线。左右各留 6 小时，兼容时区取整，但不会把下一根交易日带进来。
    start_ts = int(start.timestamp()) - 6 * 3600
    end_ts = int(end.timestamp()) + 6 * 3600
    seen = set()
    bars = []
    for bar in payload.get("bars") or []:
        ts = int(bar["t"])
        if ts < start_ts or ts > end_ts or ts in seen:
            continue
        if not all(_finite(bar.get(key)) and bar[key] > 0 for key in ("o", "h", "l", "c")):
            continue
        seen.add(ts)
        bars.append(bar)
    bars.sort(key=lambda bar: bar["t"])
    if len(bars) < 2:
        raise DataError("这个区间的 K 线不足 2 根。换一个更长的区间，或确认代码是否正确。")
    out = {key: value for key, value in payload.items() if not key.startswith("_")}
    out["bars"] = bars
    out["count"] = len(bars)
    out["warning"] = warning or payload.get("warning")
    out["start"] = bars[0]["label"]
    out["end"] = bars[-1]["label"]
    return out


def get_bars(symbol: str, interval: str, start: str, end: str) -> dict:
    symbol = validate_symbol(symbol)
    interval = validate_interval(interval)
    start_dt = parse_date(start)
    end_dt = parse_date(end).replace(hour=23, minute=59, second=59)
    start_dt, end_dt, clamp_warning = _clamp_range(interval, start_dt, end_dt)
    start_key = start_dt.strftime("%Y-%m-%d")
    end_key = end_dt.strftime("%Y-%m-%d")
    path = _cache_path(symbol, interval, start_key, end_key)
    cached = _read_cache(path)
    fresh_enough = False
    if cached is not None:
        age = time.time() - path.stat().st_mtime
        ttl = 20 * 60 if end_dt.date() >= datetime.now(NY).date() - timedelta(days=4) else 24 * 3600
        fresh_enough = age <= ttl
    if cached is not None and fresh_enough:
        cached["cached"] = True
        return _finalize(cached, clamp_warning, start_dt, end_dt)

    try:
        if _is_cn(symbol):
            from simtrader.cn import fetch_cn_bars

            fresh = fetch_cn_bars(symbol, interval, start_dt, end_dt)
        else:
            fresh = fetch_yahoo(symbol, interval, start_dt, end_dt)
    except DataError as exc:
        if cached is not None:
            cached["cached"] = True
            warning = _join_warning(clamp_warning, f"实时行情失败（{exc}），已改用本地缓存。")
            return _finalize(cached, warning, start_dt, end_dt)
        if interval == "1d":
            imported = load_csv(symbol)
            if imported is not None:
                warning = _join_warning(
                    clamp_warning,
                    f"实时行情失败（{exc}），已改用 data/imports/{symbol}.csv。",
                )
                return _finalize(imported, warning, start_dt, end_dt)
        raise

    fresh["warning"] = _join_warning(clamp_warning, fresh.get("warning"))
    fresh["cached"] = False
    _write_cache(path, fresh)
    return _finalize(fresh, clamp_warning, start_dt, end_dt)


def _is_cn(symbol: str) -> bool:
    from simtrader.cn import is_cn_symbol

    return is_cn_symbol(symbol)


def _looks_cn_query(text: str) -> bool:
    if any("\u4e00" <= ch <= "\u9fff" for ch in text):
        return True
    compact = text.strip().upper().replace(".", "")
    return _is_cn(text) or (compact.isdigit() and len(compact) == 6)


def search_symbols(query: str, market: str = "", limit: int = 8) -> list[dict]:
    text = (query or "").strip()
    if not text:
        return []
    market = (market or "").lower()
    found = []
    errors = []
    if market == "cn" or _looks_cn_query(text):
        try:
            from simtrader.cn import search_cn

            found.extend(search_cn(text, limit))
        except DataError as exc:
            errors.append(exc)
    if market != "cn" and len(found) < limit:
        try:
            found.extend(_search_yahoo(text, limit - len(found)))
        except DataError as exc:
            errors.append(exc)
    if found:
        return found[:limit]
    if errors:
        raise errors[0]
    return []


def _search_yahoo(text: str, limit: int) -> list[dict]:
    url = "https://query2.finance.yahoo.com/v1/finance/search?" + urllib.parse.urlencode(
        {"q": text, "quotesCount": max(limit * 3, 10), "newsCount": 0}
    )
    try:
        payload = json.loads(_fetch(url).decode("utf-8"))
    except DataError as exc:
        raise DataError("搜索暂时不可用，可以直接输入代码再加载。") from exc
    except json.JSONDecodeError as exc:
        raise DataError("搜索结果无法解析，可以直接输入代码再加载。") from exc
    found = []
    for item in payload.get("quotes") or []:
        kind = item.get("quoteType") or ""
        if kind not in ("EQUITY", "ETF"):
            continue
        symbol = (item.get("symbol") or "").upper()
        if not symbol or symbol.startswith("^") or "." in symbol:
            continue
        found.append(
            {
                "symbol": symbol,
                "name": item.get("shortname") or item.get("longname") or symbol,
                "exchange": item.get("exchDisp") or item.get("exchange") or "",
                "type": "股票" if kind == "EQUITY" else "ETF",
            }
        )
        if len(found) >= limit:
            break
    return found


def get_quote(symbol: str) -> dict:
    symbol = validate_symbol(symbol)
    if _is_cn(symbol):
        from simtrader.cn import quote_cn

        return quote_cn(symbol)
    end = datetime.now(NY)
    start = end - timedelta(days=12)
    last_error: Exception | None = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        for sym in _symbol_variants(symbol):
            url = _yahoo_chart_url(sym, "1d", int(start.timestamp()), int(end.timestamp()) + 3600, host)
            try:
                payload = json.loads(_fetch(url).decode("utf-8"))
                result = (payload.get("chart") or {}).get("result") or []
                if not result:
                    raise DataError("没有这只股票的现价。")
                meta = result[0].get("meta") or {}
            except (DataError, json.JSONDecodeError, KeyError) as exc:
                last_error = exc if isinstance(exc, DataError) else DataError("现价暂时不可用。")
                continue
            price = meta.get("regularMarketPrice")
            prev = meta.get("chartPreviousClose") or meta.get("previousClose")
            change = change_pct = None
            if _finite(price) and _finite(prev) and prev:
                change = float(price) - float(prev)
                change_pct = change / float(prev)
            return {
                "symbol": meta.get("symbol") or sym,
                "name": meta.get("shortName") or meta.get("longName") or sym,
                "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
                "currency": meta.get("currency") or "USD",
                "price": float(price) if _finite(price) else None,
                "previous_close": float(prev) if _finite(prev) else None,
                "change": change,
                "change_pct": change_pct,
                "market_time": meta.get("regularMarketTime"),
                "source": "Yahoo Finance",
            }
    raise last_error or DataError("现价暂时不可用。")
