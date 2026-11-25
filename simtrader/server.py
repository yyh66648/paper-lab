"""本地网页服务。只监听 127.0.0.1，不对外网开放。"""

from __future__ import annotations

import json
import math
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from simtrader import __version__
from simtrader.data import DataError, get_bars, get_quote, search_symbols, validate_interval, validate_symbol
from simtrader.engine import EngineError, run_backtest
from simtrader.metrics import equity_rows_from_values, summarize
from simtrader.paper import place_order, reset_account, snapshot
from simtrader.strategies import create_strategy, describe_strategy, strategy_catalog

ROOT_WEB = __import__("pathlib").Path(__file__).resolve().parent.parent / "web"


def to_jsonable(value):
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return round(value, 6)
    if hasattr(value, "item"):
        return to_jsonable(value.item())
    return value


def _number(body: dict, key: str, default: float, low: float, high: float, label: str) -> float:
    try:
        value = float(body.get(key, default))
    except (TypeError, ValueError) as exc:
        raise DataError(f"{label}需要填数字。") from exc
    if value < low or value > high:
        raise DataError(f"{label}请设在 {low:g} 到 {high:g} 之间。")
    return value


def parse_run_spec(body: dict) -> dict:
    if not isinstance(body, dict):
        raise DataError("请求格式不正确。")
    symbol = validate_symbol(body.get("symbol") or "")
    interval = validate_interval(body.get("interval") or "1d")
    start = body.get("start") or ""
    end = body.get("end") or ""
    if not start or not end:
        raise DataError("请选择开始和结束日期。")
    benchmark = body.get("benchmark") or "self"
    if benchmark not in ("self", "SPY", "QQQ", "none"):
        raise DataError("基准只能是自身、SPY、QQQ，或不对比。")
    strategy_id = (body.get("strategy") or "").strip()
    if not strategy_id:
        raise DataError("请选择一个策略。")
    return {
        "symbol": symbol,
        "interval": interval,
        "start": start,
        "end": end,
        "strategy": strategy_id,
        "params": body.get("params") or {},
        "cash": _number(body, "cash", 100_000, 1000, 1_000_000_000, "初始资金"),
        "commission_bps": _number(body, "commission_bps", 1, 0, 100, "手续费"),
        "slippage_bps": _number(body, "slippage_bps", 5, 0, 200, "滑点"),
        "allow_short": bool(body.get("allow_short")),
        "benchmark": benchmark,
    }


def _clean_overlays(strategy) -> list[dict]:
    overlays = []
    for item in strategy.overlays() or []:
        values = []
        for value in item.get("values") or []:
            if value is None:
                values.append(None)
            else:
                number = float(value)
                values.append(None if math.isnan(number) or math.isinf(number) else round(number, 4))
        overlays.append({"name": item.get("name") or "指标", "color": item.get("color") or "#d6a25a", "values": values})
    return overlays


def execute_backtest(spec: dict, bars: list[dict] | None = None, bench_bars: list[dict] | None = None, meta: dict | None = None) -> dict:
    started = time.perf_counter()
    if bars is None:
        meta = get_bars(spec["symbol"], spec["interval"], spec["start"], spec["end"])
        bars = meta["bars"]
    warnings = [meta.get("warning")] if meta and meta.get("warning") else []
    strategy, param_warning = create_strategy(spec["strategy"], spec["params"])
    if param_warning:
        warnings.append(param_warning)
    bench_label = f"买入持有 {spec['symbol']}"
    bench_symbol = spec["symbol"]
    if spec["benchmark"] in ("SPY", "QQQ"):
        try:
            bench_meta = get_bars(spec["benchmark"], spec["interval"], spec["start"], spec["end"])
            bench_bars = bench_meta["bars"]
            bench_symbol = spec["benchmark"]
            bench_label = f"买入持有 {spec['benchmark']}"
            if bench_meta.get("warning"):
                warnings.append(bench_meta["warning"])
            overlap = [bar for bar in bench_bars if bars[0]["t"] <= bar["t"] <= bars[-1]["t"]]
            if len(overlap) < 2:
                warnings.append(f"{spec['benchmark']} 在这个区间没有足够行情，已改和自身买入持有对比。")
                bench_bars = None
                bench_symbol = spec["symbol"]
                bench_label = f"买入持有 {spec['symbol']}"
        except DataError as exc:
            warnings.append(f"基准 {spec['benchmark']} 加载失败（{exc}），已改和自身买入持有对比。")
            bench_bars = None
    raw = run_backtest(
        bars,
        strategy,
        cash=spec["cash"],
        commission_bps=spec["commission_bps"],
        slippage_bps=spec["slippage_bps"],
        allow_short=spec["allow_short"],
        bench_bars=bench_bars,
        symbol=spec["symbol"],
    )
    warnings.extend(raw["warnings"])
    if spec["benchmark"] == "none":
        for row in raw["equity"]:
            row["bench"] = None
    metrics = summarize(spec["cash"], raw["equity"], raw["trades"], raw["fees"], spec["interval"])
    metrics["ending_cash"] = raw["ending_cash"]
    metrics["ending_position"] = raw["ending_position"]
    benchmark = None
    if spec["benchmark"] != "none":
        bench_rows = equity_rows_from_values(raw["equity"], raw["bench_equity"], spec["cash"])
        benchmark = {
            "symbol": bench_symbol,
            "label": bench_label,
            "metrics": summarize(spec["cash"], bench_rows, [], raw["bench_fees"], spec["interval"]),
        }
    payload = {
        "symbol": (meta or {}).get("symbol") or spec["symbol"],
        "name": (meta or {}).get("name") or spec["symbol"],
        "exchange": (meta or {}).get("exchange") or "",
        "currency": (meta or {}).get("currency") or "USD",
        "interval": spec["interval"],
        "source": (meta or {}).get("source") or "",
        "adjusted": bool((meta or {}).get("adjusted")),
        "cached": bool((meta or {}).get("cached")),
        "warning": " ".join(warnings) if warnings else None,
        "warnings": warnings,
        "bars": bars if meta is not None else None,
        "metrics": metrics,
        "benchmark": benchmark,
        "equity": raw["equity"],
        "trades": raw["trades"],
        "markers": raw["markers"],
        "overlays": _clean_overlays(strategy),
        "ending_signal": raw["ending_signal"],
        "strategy": {"id": strategy.id, "name": strategy.name, "params": strategy.params},
        "assumptions": {
            "cash": spec["cash"],
            "commission_bps": spec["commission_bps"],
            "slippage_bps": spec["slippage_bps"],
            "allow_short": spec["allow_short"],
            "fill": "下一根开盘",
        },
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
    }
    if meta is None:
        payload.pop("bars")
    return payload


def execute_sweep(body: dict) -> dict:
    spec = parse_run_spec(body)
    key = (body.get("sweep_key") or "").strip()
    classes, _warnings = strategy_catalog()
    schema = next((describe_strategy(cls)["params"] for cls in classes if cls.id == spec["strategy"]), [])
    param = next((item for item in schema if item["key"] == key), None)
    if param is None or param.get("type") == "bool":
        raise DataError("请选择一个数字参数来扫描。")
    try:
        min_v = float(body.get("sweep_min"))
        max_v = float(body.get("sweep_max"))
        step = float(body.get("sweep_step"))
    except (TypeError, ValueError) as exc:
        raise DataError("扫描的最小、最大和步长都要填数字。") from exc
    if step <= 0 or max_v < min_v:
        raise DataError("步长必须大于 0，且最大值不能小于最小值。")
    count = int(round((max_v - min_v) / step)) + 1
    if count > 36:
        raise DataError("一次最多扫描 36 组，请加大步长。")
    if count < 1:
        raise DataError("扫描区间是空的。")
    kind = param.get("type", "float")
    values = []
    for i in range(count):
        value = min_v + i * step
        values.append(int(round(value)) if kind == "int" else round(value, 4))
    meta = get_bars(spec["symbol"], spec["interval"], spec["start"], spec["end"])
    bench_bars = None
    if spec["benchmark"] in ("SPY", "QQQ"):
        try:
            bench_bars = get_bars(spec["benchmark"], spec["interval"], spec["start"], spec["end"])["bars"]
        except DataError:
            bench_bars = None
    rows = []
    best_sharpe = None
    best_return = None
    for value in values:
        params = dict(spec["params"])
        params[key] = value
        trial = dict(spec)
        trial["params"] = params
        trial["benchmark"] = "none" if spec["benchmark"] == "none" else spec["benchmark"]
        result = execute_backtest(trial, bars=meta["bars"], bench_bars=bench_bars, meta=meta)
        metrics = result["metrics"]
        rows.append({"value": value, "metrics": metrics})
        if metrics.get("sharpe") is not None and (best_sharpe is None or metrics["sharpe"] > best_sharpe["metrics"]["sharpe"]):
            best_sharpe = rows[-1]
        if metrics.get("total_return") is not None and (
            best_return is None or metrics["total_return"] > best_return["metrics"]["total_return"]
        ):
            best_return = rows[-1]
    return {
        "key": key,
        "label": param.get("label") or key,
        "rows": rows,
        "best_sharpe": None if best_sharpe is None else best_sharpe["value"],
        "best_return": None if best_return is None else best_return["value"],
        "warning": meta.get("warning"),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        text = fmt % args
        if "/api/" in text or " 4" in text or " 5" in text:
            print(f"[paperlab] {text}")

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self._api_get(parsed)
            else:
                self._static(parsed.path)
        except (DataError, EngineError) as exc:
            self._json({"error": str(exc)}, 400)
        except Exception as exc:
            traceback.print_exc()
            self._json({"error": f"服务器内部错误：{exc}"}, 500)

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            body = self._read_json()
            if parsed.path == "/api/backtest":
                spec = parse_run_spec(body)
                meta = get_bars(spec["symbol"], spec["interval"], spec["start"], spec["end"])
                self._json(execute_backtest(spec, bars=meta["bars"], meta=meta))
            elif parsed.path == "/api/sweep":
                self._json(execute_sweep(body))
            elif parsed.path == "/api/paper/order":
                qty = body.get("qty")
                try:
                    qty = int(qty)
                except (TypeError, ValueError) as exc:
                    raise DataError("股数要是整数。") from exc
                self._json(
                    place_order(
                        body.get("symbol") or "",
                        body.get("side") or "",
                        qty,
                        _number(body, "commission_bps", 1, 0, 100, "手续费"),
                        _number(body, "slippage_bps", 5, 0, 200, "滑点"),
                    )
                )
            elif parsed.path == "/api/paper/reset":
                cash = _number(body, "cash", 100_000, 1000, 1_000_000_000, "重置资金")
                self._json(reset_account(cash))
            else:
                self._json({"error": "没有这个接口。"}, 404)
        except (DataError, EngineError) as exc:
            self._json({"error": str(exc)}, 400)
        except Exception as exc:
            traceback.print_exc()
            self._json({"error": f"服务器内部错误：{exc}"}, 500)

    def _api_get(self, parsed):
        query = parse_qs(parsed.query)
        def one(name, default=""):
            return (query.get(name) or [default])[0]

        if parsed.path == "/api/health":
            self._json({"ok": True, "name": "纸面实验室", "version": __version__})
        elif parsed.path == "/api/search":
            self._json({"results": search_symbols(one("q"))})
        elif parsed.path == "/api/quote":
            self._json(get_quote(one("symbol")))
        elif parsed.path == "/api/bars":
            self._json(get_bars(one("symbol"), one("interval") or "1d", one("start"), one("end")))
        elif parsed.path == "/api/strategies":
            classes, warnings = strategy_catalog()
            self._json({"strategies": [describe_strategy(cls) for cls in classes], "warnings": warnings})
        elif parsed.path == "/api/paper":
            self._json(snapshot())
        else:
            self._json({"error": "没有这个接口。"}, 404)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise DataError("请求太大。")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as exc:
            raise DataError("请求不是合法的 JSON。") from exc
        if not isinstance(data, dict):
            raise DataError("请求格式不正确。")
        return data

    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(to_jsonable(payload), ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return

    def _static(self, path: str) -> None:
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/")
        file = (ROOT_WEB / rel).resolve()
        root = ROOT_WEB.resolve()
        if not file.is_relative_to(root) or not file.is_file():
            if path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            self.send_error(404)
            return
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(file.suffix, "application/octet-stream")
        data = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


def serve(host: str = "127.0.0.1", port: int = 8765) -> None:
    httpd = None
    last_error = None
    for candidate in range(port, port + 6):
        try:
            httpd = ThreadingHTTPServer((host, candidate), Handler)
            port = candidate
            break
        except OSError as exc:
            last_error = exc
    if httpd is None:
        raise SystemExit(f"端口 {port} 到 {port + 5} 都被占用：{last_error}")
    print(f"纸面实验室已启动： http://{host}:{port}")
    print("只在本机可用。按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
