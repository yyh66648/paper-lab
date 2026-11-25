"""A 股行情。日线、周线用腾讯前复权，分钟线用腾讯分时，搜索用东方财富。"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from simtrader.data import USER_AGENT, DataError, _finite

SH = ZoneInfo("Asia/Shanghai")
INDEX_ON_SH = {"000300", "000688"}
CLASS_OK = {"AStock", "Fund", "Index"}


def is_cn_symbol(symbol: str) -> bool:
    text = (symbol or "").strip().upper()
    if text.endswith((".SH", ".SZ", ".BJ")):
        return True
    if len(text) > 2 and text[:2] in {"SH", "SZ", "BJ"} and text[2:].isdigit():
        return True
    compact = text.replace(".", "")
    return compact.isdigit() and len(compact) == 6


def canonical_symbol(symbol: str) -> str:
    text = (symbol or "").strip().upper().replace(" ", "")
    if text.endswith((".SH", ".SZ", ".BJ")) and text[:-3].isdigit():
        return text
    if len(text) > 2 and text[:2] in {"SH", "SZ", "BJ"} and text[2:].isdigit():
        return f"{text[2:]}.{text[:2]}"
    digits = text.replace(".", "")
    if not (digits.isdigit() and len(digits) == 6):
        raise DataError("A 股代码应是 6 位数字，例如 600519，或带后缀 600519.SH。")
    if digits in INDEX_ON_SH or digits.startswith("399"):
        suffix = "SZ" if digits.startswith("399") else "SH"
    elif digits.startswith(("6", "5", "9")):
        suffix = "SH"
    elif digits.startswith(("4", "8")):
        suffix = "BJ"
    else:
        suffix = "SZ"
    return f"{digits}.{suffix}"


def tencent_symbol(symbol: str) -> str:
    code, suffix = canonical_symbol(symbol).split(".")
    return {"SH": "sh", "SZ": "sz", "BJ": "bj"}[suffix] + code


def _exchange_name(suffix: str) -> str:
    return {"SH": "上交所", "SZ": "深交所", "BJ": "北交所"}.get(suffix, suffix)


def _fetch(url: str, encoding: str = "utf-8") -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Referer": "https://gu.qq.com/"})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return resp.read().decode(encoding, errors="replace")
    except Exception as exc:
        raise DataError(f"连接 A 股行情失败：{exc}") from exc


def _stamp(text: str, interval: str) -> tuple[int, str]:
    if interval in ("1d", "1wk"):
        dt = datetime.strptime(text[:10], "%Y-%m-%d").replace(hour=15, tzinfo=SH)
        return int(dt.timestamp()), dt.strftime("%Y-%m-%d")
    dt = datetime.strptime(text[:12], "%Y%m%d%H%M").replace(tzinfo=SH)
    return int(dt.timestamp()), dt.strftime("%Y-%m-%d %H:%M")


def _bar_from_row(row: list, interval: str) -> dict | None:
    if len(row) < 6:
        return None
    try:
        ts, label = _stamp(str(row[0]), interval)
        opened, closed, high, low = float(row[1]), float(row[2]), float(row[3]), float(row[4])
        volume = float(row[5] or 0)
    except (TypeError, ValueError):
        return None
    if not all(_finite(value) and value > 0 for value in (opened, closed, high, low)):
        return None
    return {"t": ts, "label": label, "o": opened, "h": high, "l": low, "c": closed, "v": volume}


def _needed_count(interval: str, start: str, end: str) -> int:
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    days = max(1, (end_dt - start_dt).days + 5)
    if interval == "1wk":
        return min(1200, max(30, days // 5 + 8))
    if interval == "1d":
        return min(2500, max(40, int(days * 0.75) + 10))
    if interval == "1h":
        return 800
    return 480


def _tencent_bars(symbol: str, interval: str, count: int) -> tuple[list[dict], bool]:
    code = tencent_symbol(symbol)
    if interval in ("1d", "1wk"):
        period = "day" if interval == "1d" else "week"
        urls = [
            f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},{period},,,{count},qfq",
            f"https://ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},{period},,,{count},qfq",
        ]
        keys = ("qfqday", "day", "qfqweek", "week")
    else:
        period = {"1h": "m60", "15m": "m15", "5m": "m5"}[interval]
        urls = [
            f"https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={code},{period},,{count}",
            f"https://web.ifzq.gtimg.cn/appstock/app/kline/mkline?param={code},{period},,{count}",
        ]
        keys = (period,)
    last_error: Exception | None = None
    for url in urls:
        try:
            payload = json.loads(_fetch(url))
        except (DataError, json.JSONDecodeError) as exc:
            last_error = exc
            continue
        node = (payload.get("data") or {}).get(code) or {}
        rows = next((node.get(key) for key in keys if node.get(key)), None)
        if not rows:
            last_error = DataError("这个 A 股代码没有返回 K 线。")
            continue
        bars = [bar for row in rows if (bar := _bar_from_row(row, interval))]
        adjusted = any(key.startswith("qfq") and node.get(key) for key in keys)
        if bars:
            return bars, adjusted
    if interval == "1d":
        sina = _sina_daily(code, count)
        if sina:
            return sina, False
    raise last_error or DataError("A 股行情暂时不可用。")


def _sina_daily(code: str, count: int) -> list[dict]:
    url = (
        "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
        f"CN_MarketData.getKLineData?symbol={code}&scale=240&ma=no&datalen={count}"
    )
    try:
        payload = json.loads(_fetch(url))
    except (DataError, json.JSONDecodeError):
        return []
    bars = []
    for row in payload or []:
        bar = _bar_from_row(
            [row.get("day"), row.get("open"), row.get("close"), row.get("high"), row.get("low"), row.get("volume")],
            "1d",
        )
        if bar:
            bars.append(bar)
    return bars


def fetch_cn_bars(symbol: str, interval: str, start: datetime, end: datetime) -> dict:
    display = canonical_symbol(symbol)
    code, suffix = display.split(".")
    name = code
    try:
        name = quote_cn(display)["name"] or code
    except DataError:
        name = code
    start_key = start.strftime("%Y-%m-%d")
    end_key = end.strftime("%Y-%m-%d")
    count = _needed_count(interval, start_key, end_key)
    bars, adjusted = _tencent_bars(display, interval, count)
    warning = None
    if bars and bars[0]["label"][:10] > start_key:
        warning = "行情源没有更早的数据，已使用能拿到的区间。"
    if interval in ("5m", "15m", "1h"):
        warning = " ".join(part for part in (warning, "A 股分钟线只有最近一段。") if part)
    return {
        "symbol": display,
        "name": name,
        "exchange": _exchange_name(suffix),
        "currency": "CNY",
        "timezone": "Asia/Shanghai",
        "instrument": "EQUITY",
        "source": "腾讯行情",
        "adjusted": adjusted,
        "warning": warning,
        "bars": bars,
    }


def quote_cn(symbol: str) -> dict:
    display = canonical_symbol(symbol)
    code = tencent_symbol(display)
    text = _fetch(f"https://qt.gtimg.cn/q={code}", encoding="gbk")
    if "~" not in text:
        raise DataError("没有这只 A 股的现价。")
    fields = text.split("~")
    if len(fields) < 33:
        raise DataError("现价返回不完整。")
    try:
        price = float(fields[3])
        prev = float(fields[4])
    except ValueError as exc:
        raise DataError("现价无法解析。") from exc
    change = price - prev if prev else None
    pct = None
    try:
        pct = float(fields[32]) / 100.0
    except ValueError:
        if prev:
            pct = change / prev
    return {
        "symbol": display,
        "name": fields[1] or display,
        "exchange": _exchange_name(display.split(".")[1]),
        "currency": "CNY",
        "price": price,
        "previous_close": prev,
        "change": change,
        "change_pct": pct,
        "market_time": fields[30],
        "source": "腾讯行情",
    }


def search_cn(query: str, limit: int = 8) -> list[dict]:
    text = (query or "").strip()
    if not text:
        return []
    url = "https://searchapi.eastmoney.com/api/suggest/get?" + urllib.parse.urlencode(
        {"input": text, "type": "14", "count": max(limit * 3, 12)}
    )
    try:
        payload = json.loads(_fetch(url))
    except json.JSONDecodeError as exc:
        raise DataError("A 股搜索结果无法解析。") from exc
    rows = ((payload.get("QuotationCodeTable") or {}).get("Data")) or []
    found = []
    type_name = {"AStock": "股票", "Fund": "基金", "Index": "指数"}
    for item in rows:
        if item.get("Classify") not in CLASS_OK:
            continue
        quote_id = str(item.get("QuoteID") or "")
        code = str(item.get("Code") or "")
        if not code.isdigit() or "." not in quote_id:
            continue
        market_num = quote_id.split(".", 1)[0]
        suffix = {"1": "SH", "0": "SZ"}.get(market_num)
        if suffix is None:
            continue
        found.append(
            {
                "symbol": f"{code}.{suffix}",
                "name": item.get("Name") or code,
                "exchange": _exchange_name(suffix),
                "type": type_name.get(item.get("Classify"), "A股"),
                "market": "cn",
            }
        )
        if len(found) >= limit:
            break
    return found
