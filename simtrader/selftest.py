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
        test_indicators_and_plugins,
    ]
    for test in tests:
        test()
        print(f"ok  {test.__name__}")
    print(f"自检通过，{len(tests)} 项。")


if __name__ == "__main__":
    run_all()
