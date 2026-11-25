"""抓取美股日线、周线，写成 docs/data 下的静态 JSON，供 GitHub Pages 使用。

A 股不预抓：浏览器直接连腾讯，接口允许跨域，可以查任意代码。
"""

from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from simtrader.data import DataError, fetch_yahoo  # noqa: E402

OUT = ROOT / "docs" / "data"
NY = timezone(timedelta(hours=-5))
WORKERS = 5

US_SYMBOLS = [
    ("NVDA", "英伟达"), ("AAPL", "苹果"), ("MSFT", "微软"), ("GOOGL", "谷歌"),
    ("AMZN", "亚马逊"), ("META", "Meta"), ("TSLA", "特斯拉"), ("AVGO", "博通"),
    ("AMD", "AMD"), ("INTC", "英特尔"), ("MU", "美光"), ("NFLX", "奈飞"),
    ("ORCL", "甲骨文"), ("CRM", "Salesforce"), ("ADBE", "Adobe"), ("CSCO", "思科"),
    ("QCOM", "高通"), ("TXN", "德州仪器"), ("AMAT", "应用材料"), ("LRCX", "泛林"),
    ("ASML", "阿斯麦"), ("ARM", "ARM"), ("SMCI", "超微"), ("PLTR", "Palantir"),
    ("COIN", "Coinbase"), ("MSTR", "MicroStrategy"), ("JPM", "摩根大通"), ("BAC", "美国银行"),
    ("GS", "高盛"), ("V", "Visa"), ("MA", "万事达"), ("WMT", "沃尔玛"),
    ("COST", "好市多"), ("HD", "家得宝"), ("MCD", "麦当劳"), ("KO", "可口可乐"),
    ("PEP", "百事"), ("PFE", "辉瑞"), ("JNJ", "强生"), ("UNH", "联合健康"),
    ("XOM", "埃克森美孚"), ("CVX", "雪佛龙"), ("DIS", "迪士尼"), ("BA", "波音"),
    ("CAT", "卡特彼勒"), ("GE", "通用电气"), ("UBER", "优步"), ("SHOP", "Shopify"),
]

US_ETFS = [
    ("SPY", "标普500 ETF"), ("QQQ", "纳指100 ETF"), ("IWM", "罗素2000 ETF"),
    ("DIA", "道指 ETF"), ("SOXX", "半导体 ETF"), ("SMH", "半导体 ETF"),
    ("XLE", "能源 ETF"), ("XLF", "金融 ETF"), ("XLV", "医疗 ETF"),
    ("ARKK", "ARK 创新 ETF"), ("TLT", "20年美债 ETF"), ("GLD", "黄金 ETF"),
]

INTERVALS = [
    ("1d", 4 * 365, "day"),
    ("1wk", 8 * 365, "week"),
]


def clean_bars(bars: list[dict]) -> list[dict]:
    out = []
    for bar in bars:
        for key in ("o", "h", "l", "c"):
            bar[key] = round(float(bar[key]), 4)
        bar["v"] = round(float(bar.get("v") or 0), 0)
        out.append({"t": bar["t"], "label": bar["label"], "o": bar["o"], "h": bar["h"], "l": bar["l"], "c": bar["c"], "v": bar["v"]})
    return out


def fetch(symbol: str, interval: str, days: int) -> dict:
    end = datetime.now(NY)
    start = end - timedelta(days=days)
    return fetch_yahoo(symbol, interval, start, end)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(NY).strftime("%Y-%m-%d")
    jobs = []
    for symbol, cn_name in US_SYMBOLS + US_ETFS:
        for interval, days, _label in INTERVALS:
            jobs.append((symbol, cn_name, interval, days))

    results = {}
    failures = []

    def load_existing(symbol: str, interval: str, cn_name: str):
        """当天已经抓过的文件直接复用，只补缺的。"""
        path = OUT / f"{symbol}_{interval}.json"
        if not path.exists():
            return None, False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None, False
        if len(data.get("bars") or []) < 2:
            return None, False
        age_hours = (time.time() - path.stat().st_mtime) / 3600
        data["name"] = data.get("name") or cn_name
        return data, age_hours < 12

    def run(job):
        symbol, cn_name, interval, days = job
        existing, fresh = load_existing(symbol, interval, cn_name)
        if existing and fresh:
            return job, existing, None
        try:
            data = fetch(symbol, interval, days)
        except DataError as exc:
            if existing:
                return job, existing, f"{symbol} {interval} 用旧缓存：{exc}"
            return job, None, f"{symbol} {interval}: {exc}"
        bars = clean_bars(data["bars"])
        if len(bars) < 2:
            return job, existing, f"{symbol} {interval}: 数据不足"
        payload = {
            "symbol": symbol,
            "name": data.get("name") or cn_name,
            "display_name": cn_name,
            "exchange": data.get("exchange") or "",
            "currency": "USD",
            "source": f"Yahoo Finance 复权（预抓 {stamp}）",
            "adjusted": bool(data.get("adjusted")),
            "interval": interval,
            "bars": bars,
        }
        (OUT / f"{symbol}_{interval}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        return job, payload, None

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(run, job) for job in jobs]
        for done, future in enumerate(as_completed(futures), 1):
            job, payload, error = future.result()
            symbol, _cn, interval, _days = job
            if error:
                failures.append(error)
            if payload:
                results[(symbol, interval)] = payload
            if done % 20 == 0:
                print(f"  {done}/{len(jobs)}", flush=True)

    symbols = []
    is_etf = {symbol for symbol, _ in US_ETFS}
    for symbol, cn_name in US_SYMBOLS + US_ETFS:
        daily = results.get((symbol, "1d"))
        if not daily or len(daily["bars"]) < 2:
            failures.append(f"{symbol}: 没有日线数据")
            continue
        bars = daily["bars"]
        last, prev = bars[-1], bars[-2]
        symbols.append(
            {
                "symbol": symbol,
                "name": cn_name,
                "exchange": "US",
                "currency": "USD",
                "type": "ETF" if symbol in is_etf else "股票",
                "updated": stamp,
                "price": last["c"],
                "previous_close": prev["c"],
                "change": round(last["c"] - prev["c"], 4),
                "change_pct": round(last["c"] / prev["c"] - 1, 6) if prev["c"] else None,
                "last_bar": last["label"],
            }
        )

    index = {
        "updated": stamp,
        "source": "Yahoo Finance（GitHub Actions 预抓）",
        "note": "美股是预抓的固定清单。A 股请在页面上切到 A 股，可以查任意代码。",
        "symbols": symbols,
    }
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"写入 {len(symbols)} 个标的，{len(failures)} 个失败")
    for item in failures[:20]:
        print("  失败", item)


if __name__ == "__main__":
    main()
