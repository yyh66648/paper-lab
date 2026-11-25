"""手动纸面账户。按最新价立即成交，和回测的下一根开盘成交不是同一套规则。"""

from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from simtrader.data import DataError, get_quote, validate_symbol

ROOT = Path(__file__).resolve().parent.parent
ACCOUNT_PATH = ROOT / "data" / "paper_account.json"
LOCK = threading.Lock()
NY = ZoneInfo("America/New_York")


def _default(cash: float = 100_000.0) -> dict:
    return {
        "cash": float(cash),
        "initial_cash": float(cash),
        "positions": {},
        "orders": [],
        "fees": 0.0,
    }


def _load() -> dict:
    if not ACCOUNT_PATH.exists():
        return _default()
    try:
        data = json.loads(ACCOUNT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _default()
    data.setdefault("positions", {})
    data.setdefault("orders", [])
    data.setdefault("fees", 0.0)
    data.setdefault("initial_cash", data.get("cash", 100_000.0))
    return data


def _save(account: dict) -> None:
    ACCOUNT_PATH.parent.mkdir(parents=True, exist_ok=True)
    ACCOUNT_PATH.write_text(json.dumps(account, ensure_ascii=False, indent=2), encoding="utf-8")


def _quote_price(symbol: str) -> float | None:
    try:
        quote = get_quote(symbol)
    except DataError:
        return None
    return quote.get("price")


def snapshot(mark: bool = True) -> dict:
    with LOCK:
        account = _load()
    positions = []
    market_value = 0.0
    unrealized = 0.0
    missing = []
    for symbol, pos in account["positions"].items():
        last = _quote_price(symbol) if mark else pos.get("last")
        if last is None:
            missing.append(symbol)
            last = pos.get("last")
        value = (last or 0) * pos["qty"]
        market_value += value
        upl = None
        if last is not None:
            upl = (last - pos["avg_price"]) * pos["qty"]
            unrealized += upl
        positions.append(
            {
                "symbol": symbol,
                "qty": pos["qty"],
                "avg_price": pos["avg_price"],
                "last": last,
                "market_value": value if last is not None else None,
                "unrealized": upl,
                "unrealized_pct": ((last / pos["avg_price"] - 1.0) if last and pos["avg_price"] else None),
            }
        )
    equity = account["cash"] + market_value
    warning = None
    if missing:
        warning = "这些持仓暂时没有现价：" + "、".join(missing)
    return {
        "cash": account["cash"],
        "initial_cash": account["initial_cash"],
        "equity": equity,
        "pnl": equity - account["initial_cash"],
        "market_value": market_value,
        "unrealized": unrealized,
        "fees": account.get("fees") or 0.0,
        "positions": positions,
        "orders": list(reversed(account["orders"][-40:])),
        "warning": warning,
    }


def place_order(symbol: str, side: str, qty: int, commission_bps: float = 1.0, slippage_bps: float = 5.0) -> dict:
    symbol = validate_symbol(symbol)
    if side not in ("buy", "sell"):
        raise DataError("方向只能是买入或卖出。")
    if qty <= 0 or qty > 1_000_000:
        raise DataError("股数要是 1 到 100 万之间的整数。")
    quote = get_quote(symbol)
    price = quote.get("price")
    if not price or price <= 0:
        raise DataError("拿不到现价，这笔模拟单没有成交。")
    slip = slippage_bps / 10000.0
    fill = price * (1.0 + slip if side == "buy" else 1.0 - slip)
    fee = qty * fill * commission_bps / 10000.0
    with LOCK:
        account = _load()
        pos = account["positions"].get(symbol, {"qty": 0, "avg_price": 0.0, "last": price})
        if side == "buy":
            cost = qty * fill + fee
            if cost > account["cash"] + 1e-6:
                raise DataError(
                    f"现金不够。这笔大约需要 ${cost:,.2f}，账户还有 ${account['cash']:,.2f}。"
                )
            new_qty = int(pos["qty"]) + qty
            pos["avg_price"] = (pos["avg_price"] * pos["qty"] + fill * qty) / new_qty if new_qty else 0.0
            pos["qty"] = new_qty
            pos["last"] = price
            account["positions"][symbol] = pos
            account["cash"] -= cost
        else:
            if qty > int(pos["qty"]):
                raise DataError(f"{symbol} 只有 {int(pos['qty'])} 股，不能卖出 {qty} 股。手动模拟不做空。")
            account["cash"] += qty * fill - fee
            pos["qty"] = int(pos["qty"]) - qty
            pos["last"] = price
            if pos["qty"] <= 0:
                account["positions"].pop(symbol, None)
            else:
                account["positions"][symbol] = pos
        account["fees"] = float(account.get("fees") or 0) + fee
        account["orders"].append(
            {
                "time": datetime.now(NY).strftime("%Y-%m-%d %H:%M"),
                "symbol": symbol,
                "side": side,
                "qty": qty,
                "price": fill,
                "quote": price,
                "fee": fee,
                "name": quote.get("name") or symbol,
            }
        )
        account["orders"] = account["orders"][-200:]
        _save(account)
    return snapshot()


def reset_account(cash: float = 100_000.0) -> dict:
    if cash < 1000 or cash > 1_000_000_000:
        raise DataError("重置资金请设在 1,000 到 10 亿之间。")
    with LOCK:
        _save(_default(cash))
    return snapshot(mark=False)
