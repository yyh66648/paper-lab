/* 测止损止盈。 */
const path = require("path");
const root = path.join(__dirname, "..");
const Engine = require(path.join(root, "docs", "engine.js"));

const bar = (i, o, h, l, c) => ({ t: 1700000000 + i * 86400, label: `d${i}`, o, h, l, c, v: 1000 });

function hold(prices) {
  return new (Engine.BUILTINS[0])({});
}

let failed = 0;
const check = (cond, msg) => {
  if (!cond) { failed++; console.log("FAIL " + msg); }
};

// 1. 止损：买入后跌 10% 触发
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 95, 89, 90)];
  const raw = Engine.runBacktest(bars, hold(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, stopLossPct: 10,
  });
  const stopMarker = raw.markers.find((m) => m.note === "止损");
  check(!!stopMarker, "应触发出损");
  check(stopMarker && Math.abs(stopMarker.price - 90) < 1e-6, `止损价应是 90，实际 ${stopMarker?.price}`);
  check(raw.endingPosition === 0, `止损后应空仓，实际 ${raw.endingPosition}`);
  // 100 买入 100 股，90 卖出，权益 9000
  check(Math.abs(raw.endingEquity - 9000) < 1e-6, `权益应 9000，实际 ${raw.endingEquity}`);
  const trade = raw.trades[0];
  check(trade && trade.exitNote === "止损", `成交记录应标注止损，实际 ${trade?.exitNote}`);
  console.log(`止损 ok：${trade.entryPrice} → ${trade.exitPrice}，盈亏 ${trade.pnl}，备注「${trade.note}」`);
}

// 2. 止盈：上涨 20% 触发
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 120, 125, 118, 124)];
  const raw = Engine.runBacktest(bars, hold(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, takeProfitPct: 20,
  });
  const tp = raw.markers.find((m) => m.note === "止盈");
  check(!!tp, "应触发止盈");
  check(tp && Math.abs(tp.price - 120) < 1e-6, `止盈价应是 120，实际 ${tp?.price}`);
  check(Math.abs(raw.endingEquity - 12000) < 1e-6, `权益应 12000，实际 ${raw.endingEquity}`);
  console.log(`止盈 ok：${tp.price}`);
}

// 3. 缺口跳空：开盘已经低于止损价，按开盘价成交
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 80, 82, 78, 81)];
  const raw = Engine.runBacktest(bars, hold(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, stopLossPct: 10,
  });
  const stopMarker = raw.markers.find((m) => m.note === "止损");
  check(!!stopMarker, "跳空也应止损");
  check(Math.abs(stopMarker.price - 80) < 1e-6, `跳空应按开盘 80 成交，实际 ${stopMarker?.price}`);
  console.log(`跳空 ok：按开盘 ${stopMarker.price} 而不是 90`);
}

// 4. 不设止损时行为不变
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 60, 50, 55)];
  const raw = Engine.runBacktest(bars, hold(), { cash: 10000, commissionBps: 0, slippageBps: 0 });
  check(raw.endingPosition === 100, `不设止损应继续持有，实际 ${raw.endingPosition}`);
  check(!raw.markers.some((m) => m.note === "止损" || m.note === "止盈"), "不设阈值不该平仓");
  console.log("不设止损 ok");
}

// 5. 止损后策略继续给满仓信号，应该能重新买入
{
  const bars = [
    bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100),
    bar(2, 100, 100, 85, 88), bar(3, 90, 92, 89, 91), bar(4, 91, 95, 90, 94),
  ];
  const raw = Engine.runBacktest(bars, hold(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, stopLossPct: 10,
  });
  const buys = raw.markers.filter((m) => m.side === "buy");
  check(buys.length >= 2, `止损后应重新买入，买单数 ${buys.length}`);
  console.log(`重新进场 ok：${buys.length} 次买入`);
}

// 6. 止损不能被同根 K 线的信号绕过：当根平掉后不再立刻按信号建仓
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 100, 89, 90)];
  const raw = Engine.runBacktest(bars, hold(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, stopLossPct: 10,
  });
  check(raw.endingPosition === 0, `止损当根不应又建仓，实际 ${raw.endingPosition}`);
  console.log("当根不重复下单 ok");
}

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log("\n止损止盈全部通过。");
