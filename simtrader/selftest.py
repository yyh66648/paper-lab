"""不联网的引擎自检。"""

from __future__ import annotations

from simtrader.engine import PositionBook, run_backtest
from simtrader.indicators import sma_series
from simtrader.strategies import BuyHold, SmaCross, Strategy, strategy_catalog


def _bars(prices):
    rows = []
    for i, price in enumerate(prices):
        rows.append(
            {
                "t": 1_700_000_000 + i * 86400,
                "label": f"d{i}",
                "o": price,
                "h": price,
                "l": price,
                "c": price,
                "v": 1000,
            }
        )
    return rows


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def test_buy_hold():
    result = run_backtest(_bars([10, 11, 12, 13, 14]), BuyHold(), cash=10_000, commission_bps=0, slippage_bps=0)
    check(result["ending_position"] == 1000, f"仓位应为 1000，实际 {result['ending_position']}")
    check(abs(result["ending_equity"] - 14_000) < 1e-6, f"期末权益应为 14000，实际 {result['ending_equity']}")
    check(result["markers"][0]["price"] == 10, "买入持有应在第一根开盘成交")
    check(len([trade for trade in result["trades"] if not trade["open"]]) == 0, "持有到结束不应有已平仓回合")


def test_signal_fills_next_open():
    result = run_backtest(
        _bars([5, 5, 5, 5, 8, 8, 8, 8]),
        SmaCross({"fast": 2, "slow": 3}),
        cash=10_000,
        commission_bps=0,
        slippage_bps=0,
    )
    check(result["equity"][4]["position"] == 0, "信号出现的当根不应成交")
    check(result["markers"], "应有一笔成交")
    check(result["markers"][0]["t"] == result["equity"][5]["t"], "应在下一根开盘成交")
    check(result["markers"][0]["price"] == 8, f"成交价应为下一根开盘 8，实际 {result['markers'][0]['price']}")
    check(result["equity"][5]["position"] > 0, "成交后应有持仓")


def test_commission_does_not_overspend():
    result = run_backtest(_bars([100, 100, 100]), BuyHold(), cash=10_000, commission_bps=100, slippage_bps=0)
    check(result["ending_cash"] >= -1e-6, f"现金不应为负，实际 {result['ending_cash']}")
    check(result["ending_position"] == 99, f"1% 手续费下应买 99 股，实际 {result['ending_position']}")


def test_short_loss():
    class AlwaysShort(Strategy):
        id = "always_short"
        name = "测试做空"

        def on_start(self):
            return -1.0

        def on_bar(self, view):
            return -1.0

    result = run_backtest(_bars([10, 10, 12]), AlwaysShort(), cash=10_000, commission_bps=0, slippage_bps=0, allow_short=True)
    check(result["ending_position"] == -1000, f"应做空 1000 股，实际 {result['ending_position']}")
    check(abs(result["ending_equity"] - 8000) < 1e-6, f"价格上涨后空头应亏损，权益 {result['ending_equity']}")


def test_short_disabled():
    class AlwaysShort(Strategy):
        id = "always_short"
        name = "测试做空"

        def on_bar(self, view):
            return -1.0

    result = run_backtest(_bars([10, 11, 12]), AlwaysShort(), cash=10_000, commission_bps=0, slippage_bps=0)
    check(result["ending_position"] == 0, "未允许做空时不应持有空头")
    check(any("做空" in item for item in result["warnings"]), "应提示空头信号被忽略")


def test_view_hides_future():
    class Probe(Strategy):
        id = "probe"
        name = "探针"

        def on_bar(self, view):
            check(len(view.close) == view.i + 1, "策略看到了未来 K 线")
            try:
                view.close[view.i + 1]
            except IndexError:
                return 0.0
            raise AssertionError("未来价格可以被下标访问")

    run_backtest(_bars([1, 2, 3, 4, 5]), Probe(), cash=10_000, commission_bps=0, slippage_bps=0)


def test_round_trip_includes_fees():
    book = PositionBook()
    book.apply({"side": "buy", "qty": 10, "price": 100, "fee": 1, "t": 1, "label": "a", "bar_index": 0, "note": "开"})
    book.apply({"side": "sell", "qty": 10, "price": 110, "fee": 1, "t": 2, "label": "b", "bar_index": 3, "note": "平"})
    check(len(book.closed) == 1, "应形成一笔回合")
    check(abs(book.closed[0]["pnl"] - 98) < 1e-9, f"盈亏应扣双边手续费，实际 {book.closed[0]['pnl']}")
    check(book.closed[0]["bars_held"] == 3, "持有根数计算错误")


def test_penny_buy_stays_solvent():
    result = run_backtest(_bars([0.5, 0.5, 0.55]), BuyHold(), cash=100_000, commission_bps=10, slippage_bps=0)
    check(result["ending_cash"] >= -1e-6, f"低价股买入后现金为负：{result['ending_cash']}")
    check(result["ending_position"] > 1000, "低价股应能成交，而不是在逐股扣减里卡死")


def test_split_and_annualization():
    from simtrader.metrics import infer_bars_per_year, split_report

    start = 1_700_000_000
    times = [start + i * 86400 for i in range(300)]
    per_year = infer_bars_per_year(times, "1d", 300)
    check(300 < per_year < 400, f"连续日线应按真实密度年化，得到 {per_year}")
    equity = 100.0
    rows = []
    for i, ts in enumerate(times):
        equity *= 1.001 if i < 210 else 0.999
        rows.append({"t": ts, "label": f"d{i}", "equity": equity, "drawdown": 0, "position": 1, "close": 1})
    report = split_report(100, rows, "1d")
    check(report is not None, "样本应能切开")
    check(report["in_sample"]["total_return"] > 0, "前半段应是盈利")
    check(report["out_of_sample"]["total_return"] < 0, "后半段应是亏损")


def test_cn_symbols():
    from simtrader.cn import canonical_symbol, is_cn_symbol, tencent_symbol

    check(is_cn_symbol("600519") and not is_cn_symbol("NVDA"), "A 股代码识别错误")
    check(canonical_symbol("600519") == "600519.SH", canonical_symbol("600519"))
    check(canonical_symbol("sz000001") == "000001.SZ", canonical_symbol("sz000001"))
    check(tencent_symbol("000300") == "sh000300", tencent_symbol("000300"))
    check(canonical_symbol("300750") == "300750.SZ", canonical_symbol("300750"))


def test_lot_and_t1():
    bars = _bars([10, 10, 10])
    result = run_backtest(bars, BuyHold(), cash=10_000, commission_bps=0, slippage_bps=0, lot=100)
    check(result["ending_position"] == 1000, f"整手买入应为 1000 股，实际 {result['ending_position']}")
    check(result["ending_position"] % 100 == 0, "持仓应是整手")

    thin = run_backtest(_bars([333, 333]), BuyHold(), cash=10_000, commission_bps=0, slippage_bps=0, lot=100)
    check(thin["ending_position"] == 0, f"买不起一手应空仓，实际 {thin['ending_position']}")

    t1_bars = _bars([100, 88, 89])
    t1_bars[0] = {**t1_bars[0], "o": 100, "h": 100, "l": 85, "c": 88}
    result = run_backtest(t1_bars, BuyHold(), cash=10_000, commission_bps=0, slippage_bps=0, stop_loss_pct=10, t_plus_one=True)
    stops = [m for m in result["markers"] if m["note"] == "止损"]
    check(stops and stops[0]["label"] == "d1", f"T+1 应推迟到 d1，实际 {[m['label'] for m in stops]}")

    free = run_backtest(t1_bars, BuyHold(), cash=10_000, commission_bps=0, slippage_bps=0, stop_loss_pct=10, t_plus_one=False)
    stops_free = [m for m in free["markers"] if m["note"] == "止损"]
    check(stops_free and stops_free[0]["label"] == "d0", "不限制时当天应止损")


def test_stop_loss_and_take_profit():
    bars = _bars([100, 100, 90])
    bars[2] = {**bars[2], "o": 100, "h": 100, "l": 88, "c": 90}
    result = run_backtest(bars, BuyHold(), cash=10_000, commission_bps=0, slippage_bps=0, stop_loss_pct=10)
    stops = [m for m in result["markers"] if m["note"] == "止损"]
    check(stops, "应触发出损")
    check(abs(stops[0]["price"] - 90) < 1e-6, f"止损价应为 90，实际 {stops[0]['price']}")
    check(result["ending_position"] == 0, "止损后应空仓")


def test_indicators_and_plugins():
    check(sma_series([1, 2, 3, 4], 2) == [None, 1.5, 2.5, 3.5], "SMA 序列不正确")
    classes, warnings = strategy_catalog()
    ids = {cls.id for cls in classes}
    check("volume_sma" in ids, f"示例策略没有载入：{warnings}")
    check(not warnings, f"策略目录有警告：{warnings}")


def run_all() -> None:
    tests = [
        test_buy_hold,
        test_signal_fills_next_open,
        test_commission_does_not_overspend,
        test_short_loss,
        test_short_disabled,
        test_view_hides_future,
        test_round_trip_includes_fees,
        test_penny_buy_stays_solvent,
        test_split_and_annualization,
        test_cn_symbols,
        test_lot_and_t1,
        test_stop_loss_and_take_profit,
        test_indicators_and_plugins,
    ]
    for test in tests:
        test()
        print(f"ok  {test.__name__}")
    print(f"自检通过，{len(tests)} 项。")


if __name__ == "__main__":
    run_all()
