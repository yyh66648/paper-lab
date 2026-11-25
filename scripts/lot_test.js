/* 测整手和 T+1。 */
const path = require("path");
const root = path.join(__dirname, "..");
const Engine = require(path.join(root, "docs", "engine.js"));

const bar = (i, o, h, l, c) => ({ t: 1700000000 + i * 86400, label: `d${i}`, o, h, l, c, v: 1000 });
const hold = () => new (Engine.BUILTINS[0])({});

let failed = 0;
const check = (cond, msg) => { if (!cond) { failed++; console.log("FAIL " + msg); } };

// 1. 整手：10 元股票，1 万股本金，每手 100 股，最多买 1000 股
{
  const bars = [bar(0, 10, 10, 10, 10), bar(1, 10, 10, 10, 10), bar(2, 10, 10, 10, 10)];
  for (const [lot, expect] of [[1, 1000], [100, 1000], [1000, 1000]]) {
    const raw = Engine.runBacktest(bars, hold(), { cash: 10000, commissionBps: 0, slippageBps: 0, lot });
    check(raw.endingPosition === expect, `lot=${lot} 持仓应 ${expect}，实际 ${raw.endingPosition}`);
    check(raw.endingPosition % lot === 0, `lot=${lot} 持仓应是整手`);
  }
  // 1 万本金买 333 元股票，100 股一手，只能买 30 股？不行——不足一手就不买
  const pricey = Engine.runBacktest([bar(0, 333, 333, 333, 333), bar(1, 333, 333, 333, 333)], hold(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, lot: 100,
  });
  check(pricey.endingPosition % 100 === 0, `高价股也应整手，实际 ${pricey.endingPosition}`);
  check(pricey.endingPosition === 0, `买不起一手应空仓，实际 ${pricey.endingPosition}`);
  console.log(`整手 ok：10 元股 ${Engine.runBacktest(bars, hold(), { cash: 10000, commissionBps: 0, slippageBps: 0, lot: 100 }).endingPosition} 股；333 元股 ${pricey.endingPosition} 股`);
}

// 2. T+1：第 0 根开盘买入，当天就跌破止损线，但不许卖，要等第 1 根
{
  const bars = [bar(0, 100, 100, 85, 88), bar(1, 88, 90, 86, 89)];
  const raw = Engine.runBacktest(bars, hold(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, stopLossPct: 10, tPlusOne: true,
  });
  const stop = raw.markers.find((m) => m.note === "止损");
  check(!!stop, "第二天应能止损");
  check(stop && stop.label === "d1", `T+1 应推迟到 d1 平仓，实际 ${stop?.label}`);
  console.log(`T+1 ok：买入当天不卖，${stop.label} 才平仓`);
}

// 3. 不开 T+1 时当天就能止损，作为对照
{
  const bars = [bar(0, 100, 100, 85, 88), bar(1, 88, 90, 86, 89)];
  const raw = Engine.runBacktest(bars, hold(), {
    cash: 10000, commissionBps: 0, slippageBps: 0, stopLossPct: 10, tPlusOne: false,
  });
  const stop = raw.markers.find((m) => m.note === "止损");
  check(stop && stop.label === "d0", `不开 T+1 应在 d0 平仓，实际 ${stop?.label}`);
  console.log(`对照 ok：不限制时 ${stop.label} 平仓`);
}

// 4. lot 默认 1，不影响原有行为
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100)];
  const raw = Engine.runBacktest(bars, hold(), { cash: 10000, commissionBps: 0, slippageBps: 0 });
  check(raw.endingPosition === 100, `默认应 100 股，实际 ${raw.endingPosition}`);
  console.log("默认 lot=1 ok");
}

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log("\n整手和 T+1 通过。");
