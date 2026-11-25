/* 测空头方向的止损止盈，验证价格方向没有写反。 */
const path = require("path");
const Engine = require(path.join(path.join(__dirname, ".."), "docs", "engine.js"));

const bar = (i, o, h, l, c) => ({ t: 1700000000 + i * 86400, label: `d${i}`, o, h, l, c, v: 1000 });

class AlwaysShort extends Engine.Strategy {
  onStart() { return -1; }
  onBar() { return -1; }
}
AlwaysShort.id = "test_short";
AlwaysShort.name = "测试空头";
AlwaysShort.paramsSchema = [];

let failed = 0;
const check = (cond, msg) => { if (!cond) { failed++; console.log("FAIL " + msg); } };

// 空头：价格上涨 10% 应止损
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 110, 112, 108, 111)];
  const raw = Engine.runBacktest(bars, new AlwaysShort(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, allowShort: true, stopLossPct: 10,
  });
  const stop = raw.markers.find((m) => m.note === "止损");
  check(!!stop, "空头价格上涨应触发止损");
  check(stop && Math.abs(stop.price - 110) < 1e-6, `空头止损价应 110，实际 ${stop?.price}`);
  check(stop && stop.side === "buy", "空头止损应买回平仓");
  check(raw.endingPosition === 0, "止损后应空仓");
  // 100 做空 100 股，110 买回，亏 1000，权益 9000
  check(Math.abs(raw.endingEquity - 9000) < 1e-6, `权益应 9000，实际 ${raw.endingEquity}`);
  console.log(`空头止损 ok：${stop.price} 买回，权益 ${raw.endingEquity}`);
}

// 空头：价格下跌 20% 应止盈
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 80, 82, 78, 79)];
  const raw = Engine.runBacktest(bars, new AlwaysShort(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, allowShort: true, takeProfitPct: 20,
  });
  const tp = raw.markers.find((m) => m.note === "止盈");
  check(!!tp, "空头价格下跌应触发止盈");
  check(tp && Math.abs(tp.price - 80) < 1e-6, `空头止盈价应 80，实际 ${tp?.price}`);
  check(Math.abs(raw.endingEquity - 12000) < 1e-6, `权益应 12000，实际 ${raw.endingEquity}`);
  console.log(`空头止盈 ok：${tp.price} 买回，权益 ${raw.endingEquity}`);
}

// 空头跳空：开盘已高于止损价，按开盘价买回
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 115, 118, 114, 116)];
  const raw = Engine.runBacktest(bars, new AlwaysShort(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, allowShort: true, stopLossPct: 10,
  });
  const stop = raw.markers.find((m) => m.note === "止损");
  check(stop && Math.abs(stop.price - 115) < 1e-6, `跳空应按开盘 115 买回，实际 ${stop?.price}`);
  console.log(`空头跳空 ok：按开盘 ${stop.price} 而非 110`);
}

// 同根同时触及止损和止盈时，优先按止损（保守）
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 115, 85, 100)];
  const raw = Engine.runBacktest(bars, new AlwaysShort(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, allowShort: true, stopLossPct: 10, takeProfitPct: 10,
  });
  const markers = raw.markers.filter((m) => m.note === "止损" || m.note === "止盈");
  check(markers.length === 1 && markers[0].note === "止损", `应优先止损，实际 ${markers.map((m) => m.note)}`);
  console.log(`双向触及 ok：优先 ${markers[0]?.note}`);
}

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log("\n空头止损止盈全部通过。");
