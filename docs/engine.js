/* 纸面实验室 · 纯浏览器回测引擎。
   与 simtrader/engine.py 语义一致：信号收盘确认、下一根开盘成交、含滑点与手续费。 */

const IND = {
  sma(values, n) {
    if (!values || n <= 0 || values.length < n) return null;
    let total = 0;
    for (let i = values.length - n; i < values.length; i++) total += Number(values[i]);
    return total / n;
  },
  smaSeries(values, n) {
    const out = new Array(values.length).fill(null);
    if (n <= 0) return out;
    let total = 0;
    for (let i = 0; i < values.length; i++) {
      total += Number(values[i]);
      if (i >= n) total -= Number(values[i - n]);
      if (i >= n - 1) out[i] = total / n;
    }
    return out;
  },
  emaSeries(values, n) {
    const out = new Array(values.length).fill(null);
    if (n <= 0 || values.length < n) return out;
    const k = 2 / (n + 1);
    let seed = 0;
    for (let i = 0; i < n; i++) seed += Number(values[i]);
    let ema = seed / n;
    out[n - 1] = ema;
    for (let i = n; i < values.length; i++) {
      ema = Number(values[i]) * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  },
  rsiSeries(values, n) {
    const out = new Array(values.length).fill(null);
    if (n <= 0 || values.length <= n) return out;
    let gainSum = 0;
    let lossSum = 0;
    for (let i = 1; i <= n; i++) {
      const delta = Number(values[i]) - Number(values[i - 1]);
      if (delta >= 0) gainSum += delta;
      else lossSum -= delta;
    }
    let avgGain = gainSum / n;
    let avgLoss = lossSum / n;
    out[n] = rsiOf(avgGain, avgLoss);
    for (let i = n + 1; i < values.length; i++) {
      const delta = Number(values[i]) - Number(values[i - 1]);
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = rsiOf(avgGain, avgLoss);
    }
    return out;
  },
  bollingerSeries(values, n, k) {
    const mid = IND.smaSeries(values, n);
    const upper = new Array(values.length).fill(null);
    const lower = new Array(values.length).fill(null);
    if (n <= 0) return { mid, upper, lower };
    for (let i = n - 1; i < values.length; i++) {
      const mu = mid[i];
      if (mu === null) continue;
      let sq = 0;
      for (let j = i - n + 1; j <= i; j++) {
        const d = Number(values[j]) - mu;
        sq += d * d;
      }
      const sd = Math.sqrt(sq / n);
      upper[i] = mu + k * sd;
      lower[i] = mu - k * sd;
    }
    return { mid, upper, lower };
  },
  macdSeries(values, fast, slow, signal) {
    const fastLine = IND.emaSeries(values, fast);
    const slowLine = IND.emaSeries(values, slow);
    const macd = new Array(values.length).fill(null);
    const usable = [];
    const usableAt = [];
    for (let i = 0; i < values.length; i++) {
      if (fastLine[i] === null || slowLine[i] === null) continue;
      macd[i] = fastLine[i] - slowLine[i];
      usable.push(macd[i]);
      usableAt.push(i);
    }
    const signalLine = new Array(values.length).fill(null);
    const seeded = IND.emaSeries(usable, signal);
    for (let i = 0; i < usableAt.length; i++) signalLine[usableAt[i]] = seeded[i];
    return { macd, signal: signalLine };
  },
  donchianPrior(highs, lows, entryN, exitN) {
    const upper = new Array(highs.length).fill(null);
    const lower = new Array(lows.length).fill(null);
    for (let i = 0; i < highs.length; i++) {
      if (i >= entryN) {
        let m = -Infinity;
        for (let j = i - entryN; j < i; j++) m = Math.max(m, Number(highs[j]));
        upper[i] = m;
      }
      if (i >= exitN) {
        let m = Infinity;
        for (let j = i - exitN; j < i; j++) m = Math.min(m, Number(lows[j]));
        lower[i] = m;
      }
    }
    return { upper, lower };
  },
};

function rsiOf(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function coerceParams(schema, raw) {
  const params = {};
  for (const spec of schema || []) {
    const label = spec.label || spec.key;
    const value = raw && raw[spec.key] !== undefined && raw[spec.key] !== null ? raw[spec.key] : spec.default;
    if (spec.type === "bool") {
      params[spec.key] = Boolean(value);
      continue;
    }
    let num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`参数「${label}」需要填数字。`);
    if (spec.type === "int") num = Math.trunc(num);
    if (spec.min !== undefined && num < spec.min) num = spec.min;
    if (spec.max !== undefined && num > spec.max) num = spec.max;
    params[spec.key] = spec.type === "int" ? Math.trunc(num) : num;
  }
  return params;
}

class Strategy {
  constructor(params) {
    this.params = coerceParams(this.constructor.paramsSchema, params || {});
    this.note = "";
  }
  onStart() { return null; }
  prepare() {}
  onBar() { return null; }
  overlays() { return []; }
  validate() { return null; }
  get id() { return this.constructor.id; }
  get name() { return this.constructor.name; }
  get description() { return this.constructor.description; }
}
Strategy.paramsSchema = [];

class BuyHold extends Strategy {
  static id = "buy_hold";
  static name = "买入持有";
  static description = "第一根 K 线开盘满仓，一直拿到样本结束。它不是交易系统，是用来比较的尺子。";
  static paramsSchema = [];
  onStart() { this.note = "买入持有"; return 1; }
  onBar() { return 1; }
}
BuyHold.id = "buy_hold";
BuyHold.name = "买入持有";
BuyHold.description = "第一根 K 线开盘满仓，一直拿到样本结束。它不是交易系统，是用来比较的尺子。";
BuyHold.paramsSchema = [];

class SmaCross extends Strategy {
  onStart() { return null; }
  prepare(closes) {
    this.fastLine = IND.smaSeries(closes, this.params.fast);
    this.slowLine = IND.smaSeries(closes, this.params.slow);
  }
  onBar(view) {
    const fast = this.fastLine[view.i];
    const slow = this.slowLine[view.i];
    if (fast === null || slow === null) return 0;
    if (fast > slow) { this.note = "短均线在上方"; return 1; }
    this.note = "短均线不在上方";
    return 0;
  }
  overlays() {
    return [
      { name: `SMA ${this.params.fast}`, color: "#d6a25a", values: this.fastLine },
      { name: `SMA ${this.params.slow}`, color: "#7ea4c4", values: this.slowLine },
    ];
  }
  validate() {
    if (this.params.fast >= this.params.slow) return "短均线周期应小于长均线，否则交叉没有方向。已按你填的参数照跑。";
    return null;
  }
}
SmaCross.id = "sma_cross";
SmaCross.name = "双均线";
SmaCross.description = "短均线高于长均线就满仓，否则空仓。趋势来了跟得上，震荡市会被来回打脸。";
SmaCross.paramsSchema = [
  { key: "fast", label: "短均线", type: "int", default: 20, min: 2, max: 120, step: 1, hint: "短均线看最近多少根K线的平均价。越小信号越早，也越容易被噪音骗。" },
  { key: "slow", label: "长均线", type: "int", default: 60, min: 5, max: 300, step: 1, hint: "长均线决定主要趋势。越大越稳，但进场越晚。" },
];

class EmaCross extends Strategy {
  prepare(closes) {
    this.fastLine = IND.emaSeries(closes, this.params.fast);
    this.slowLine = IND.emaSeries(closes, this.params.slow);
  }
  onBar(view) {
    const fast = this.fastLine[view.i];
    const slow = this.slowLine[view.i];
    if (fast === null || slow === null) return 0;
    if (fast > slow) { this.note = "短 EMA 在上方"; return 1; }
    this.note = "短 EMA 不在上方";
    return 0;
  }
  overlays() {
    return [
      { name: `EMA ${this.params.fast}`, color: "#d6a25a", values: this.fastLine },
      { name: `EMA ${this.params.slow}`, color: "#7ea4c4", values: this.slowLine },
    ];
  }
  validate() {
    if (this.params.fast >= this.params.slow) return "短 EMA 应小于长 EMA。已按你填的参数照跑。";
    return null;
  }
}
EmaCross.id = "ema_cross";
EmaCross.name = "EMA 交叉";
EmaCross.description = "规则和双均线相同，用指数移动平均，最近的价格权重更高，信号会更早，也更容易反复。";
EmaCross.paramsSchema = [
  { key: "fast", label: "短 EMA", type: "int", default: 12, min: 2, max: 120, step: 1 },
  { key: "slow", label: "长 EMA", type: "int", default: 26, min: 5, max: 300, step: 1 },
];

class BollingerReversion extends Strategy {
  prepare(closes) {
    const b = IND.bollingerSeries(closes, this.params.period, this.params.k);
    this.mid = b.mid;
    this.upper = b.upper;
    this.lower = b.lower;
  }
  onBar(view) {
    const mid = this.mid[view.i];
    const lower = this.lower[view.i];
    if (mid === null || lower === null) return null;
    if (view.price < lower) { this.note = "跌破下轨"; return 1; }
    if (view.price > mid) { this.note = "回到中轨"; return 0; }
    return null;
  }
  overlays() {
    return [
      { name: "中轨", color: "#d6a25a", values: this.mid },
      { name: "上轨", color: "#8b97a7", values: this.upper },
      { name: "下轨", color: "#8b97a7", values: this.lower },
    ];
  }
}
BollingerReversion.id = "bollinger";
BollingerReversion.name = "布林带回归";
BollingerReversion.description = "收盘跌破下轨买入，回到中轨卖出。赌价格会回到均值；单边行情里会一直接飞刀。";
BollingerReversion.paramsSchema = [
  { key: "period", label: "周期", type: "int", default: 20, min: 5, max: 120, step: 1, hint: "布林带的回看根数。越长通道越宽，信号越少。" },
  { key: "k", label: "带宽倍数", type: "float", default: 2.0, min: 0.5, max: 4, step: 0.1, hint: "上下轨离中轨多少个标准差。越大越极端，买入机会越少。" },
];

class RsiReversion extends Strategy {
  prepare(closes) {
    this.rsi = IND.rsiSeries(closes, this.params.period);
  }
  onBar(view) {
    const value = this.rsi[view.i];
    if (value === null) return null;
    if (value < this.params.oversold) { this.note = "超卖"; return 1; }
    if (value > this.params.overbought) { this.note = "超买"; return 0; }
    return null;
  }
  validate() {
    if (this.params.oversold >= this.params.overbought) return "超卖线应低于超买线。已按你填的参数照跑。";
    return null;
  }
}
RsiReversion.id = "rsi";
RsiReversion.name = "RSI 回归";
RsiReversion.description = "RSI 低于超卖线买入，高于超买线卖出。阈值越极端，交易越少，错过的行情也越多。";
RsiReversion.paramsSchema = [
  { key: "period", label: "RSI 周期", type: "int", default: 14, min: 2, max: 60, step: 1, hint: "RSI 回看根数。越大对短期波动越不敏感。" },
  { key: "oversold", label: "超卖线", type: "float", default: 30, min: 5, max: 50, step: 1, hint: "低于这个值买入。设得越低越保守。" },
  { key: "overbought", label: "超买线", type: "float", default: 70, min: 50, max: 95, step: 1, hint: "高于这个值卖出。" },
];

class DonchianBreakout extends Strategy {
  prepare(closes, highs, lows) {
    const d = IND.donchianPrior(highs, lows, this.params.entry, this.params.exit);
    this.upper = d.upper;
    this.lower = d.lower;
  }
  onBar(view) {
    const upper = this.upper[view.i];
    const lower = this.lower[view.i];
    if (upper !== null && view.price > upper) { this.note = "突破上轨"; return 1; }
    if (lower !== null && view.price < lower) { this.note = "跌破下轨"; return 0; }
    return null;
  }
  overlays() {
    return [
      { name: `${this.params.entry}日高`, color: "#d6a25a", values: this.upper },
      { name: `${this.params.exit}日低`, color: "#7ea4c4", values: this.lower },
    ];
  }
}
DonchianBreakout.id = "donchian";
DonchianBreakout.name = "唐奇安突破";
DonchianBreakout.description = "收盘突破前 N 日最高价买入，跌破前 M 日最低价卖出。信号少，亏的时候往往亏掉一整段通道。";
DonchianBreakout.paramsSchema = [
  { key: "entry", label: "突破周期", type: "int", default: 20, min: 2, max: 120, step: 1 },
  { key: "exit", label: "离场周期", type: "int", default: 10, min: 2, max: 120, step: 1 },
];

class MacdCross extends Strategy {
  prepare(closes) {
    const m = IND.macdSeries(closes, this.params.fast, this.params.slow, this.params.signal);
    this.macd = m.macd;
    this.signal = m.signal;
  }
  onBar(view) {
    const i = view.i;
    if (i === 0 || this.macd[i] === null || this.signal[i] === null) return null;
    if (this.macd[i - 1] === null || this.signal[i - 1] === null) return null;
    if (this.macd[i - 1] <= this.signal[i - 1] && this.macd[i] > this.signal[i]) { this.note = "金叉"; return 1; }
    if (this.macd[i - 1] >= this.signal[i - 1] && this.macd[i] < this.signal[i]) { this.note = "死叉"; return 0; }
    return null;
  }
  validate() {
    if (this.params.fast >= this.params.slow) return "快线应小于慢线。已按你填的参数照跑。";
    return null;
  }
}
MacdCross.id = "macd";
MacdCross.name = "MACD 交叉";
MacdCross.description = "MACD 上穿信号线买入，下穿卖出。这是滞后指标，交叉出现时行情往往已经走了一段。";
MacdCross.paramsSchema = [
  { key: "fast", label: "快线", type: "int", default: 12, min: 2, max: 60, step: 1 },
  { key: "slow", label: "慢线", type: "int", default: 26, min: 5, max: 120, step: 1 },
  { key: "signal", label: "信号线", type: "int", default: 9, min: 2, max: 40, step: 1 },
];

class TrendPullback extends Strategy {
  prepare(closes) {
    this.trend = IND.smaSeries(closes, this.params.trend);
    this.rsi = IND.rsiSeries(closes, this.params.rsi);
  }
  onBar(view) {
    const trend = this.trend[view.i];
    const value = this.rsi[view.i];
    if (trend === null || value === null) return null;
    if (view.price < trend) { this.note = "跌破趋势"; return 0; }
    if (value >= this.params.exit) { this.note = "过热离场"; return 0; }
    if (value <= this.params.buy) { this.note = "趋势中回撤"; return 1; }
    return null;
  }
  overlays() {
    return [{ name: `SMA ${this.params.trend}`, color: "#d6a25a", values: this.trend }];
  }
  validate() {
    if (this.params.buy >= this.params.exit) return "买入 RSI 应低于离场 RSI。已按你填的参数照跑。";
    return null;
  }
}
TrendPullback.id = "trend_pullback";
TrendPullback.name = "趋势回撤";
TrendPullback.description = "价格在长均线之上、RSI 回落到买入线时进场；跌破长均线或 RSI 过热就离场。只想在上升趋势里买回调。";
TrendPullback.paramsSchema = [
  { key: "trend", label: "趋势均线", type: "int", default: 100, min: 20, max: 300, step: 1 },
  { key: "rsi", label: "RSI 周期", type: "int", default: 14, min: 2, max: 40, step: 1 },
  { key: "buy", label: "买入 RSI", type: "float", default: 40, min: 10, max: 60, step: 1 },
  { key: "exit", label: "离场 RSI", type: "float", default: 70, min: 50, max: 90, step: 1 },
];

const BUILTINS = [
  BuyHold, SmaCross, EmaCross, BollingerReversion,
  RsiReversion, DonchianBreakout, MacdCross, TrendPullback,
];

function strategyCatalog() {
  return BUILTINS.map((cls) => ({
    id: cls.id,
    name: cls.name,
    description: cls.description,
    params: cls.paramsSchema,
    origin: "builtin",
  }));
}

function createStrategy(id, params) {
  const cls = BUILTINS.find((item) => item.id === id);
  if (!cls) throw new Error(`没有这个策略：${id}`);
  const strategy = new cls(params || {});
  return { strategy, warning: strategy.validate() };
}

const ENGINE_EPS = 1e-9;

function clampWeight(weight, allowShort) {
  return allowShort ? clamp(weight, -1, 1) : clamp(weight, 0, 1);
}

function executeOrder(cash, position, targetPct, openPx, commissionRate, slippageBps, allowShort, lot = 1) {
  if (openPx === null || openPx === undefined || openPx <= 0) return { cash, position, fill: null };
  targetPct = clampWeight(Number(targetPct), allowShort);
  const equity = cash + position * openPx;
  if (equity <= 0) return { cash, position, fill: null };
  const slip = slippageBps / 10000;
  const sizePx = openPx * (targetPct >= 0 ? 1 + slip : 1 - slip);
  if (sizePx <= 0) return { cash, position, fill: null };
  const lotSize = Math.max(1, Math.trunc(lot) || 1);
  const rawDesired = Math.trunc((equity * targetPct) / sizePx);
  // A 股要整手买，卖出可以零股。这里对目标股数向下取整到整手。
  const desired = Math.trunc(rawDesired / lotSize) * lotSize;
  let delta = desired - Math.trunc(position);
  if (delta === 0) return { cash, position, fill: null };
  const sideSign = delta > 0 ? 1 : -1;
  const fillPx = openPx * (delta > 0 ? 1 + slip : 1 - slip);
  let qty = Math.abs(delta);
  if (sideSign > 0) {
    const unit = fillPx * (1 + commissionRate);
    const affordable = Math.trunc(cash / unit);
    qty = Math.min(qty, Math.max(0, Math.trunc(affordable / lotSize) * lotSize));
  }
  if (qty <= 0) return { cash, position, fill: null };
  const fee = qty * fillPx * commissionRate;
  cash = cash - sideSign * qty * fillPx - fee;
  position = Math.trunc(position) + sideSign * qty;
  return {
    cash,
    position,
    fill: { side: sideSign > 0 ? "buy" : "sell", qty, price: fillPx, fee },
  };
}

class PositionBook {
  constructor() {
    this.qty = 0;
    this.avg = 0;
    this.entryTime = null;
    this.entryLabel = "";
    this.entryIndex = null;
    this.feePool = 0;
    this.note = "";
    this.closed = [];
  }

  apply(fill) {
    const qty = Math.trunc(fill.qty);
    if (qty <= 0) return;
    const signed = fill.side === "buy" ? qty : -qty;
    const price = Number(fill.price);
    let remaining = signed;
    let remainingFee = Number(fill.fee);
    if (this.qty !== 0 && (this.qty > 0) !== (remaining > 0)) {
      const closeQty = Math.min(Math.abs(this.qty), Math.abs(remaining));
      const portion = closeQty / Math.abs(signed);
      const feeClose = remainingFee * portion;
      const entryFee = this.feePool * (closeQty / Math.abs(this.qty));
      const side = this.qty > 0 ? "long" : "short";
      const gross = side === "long"
        ? (price - this.avg) * closeQty
        : (this.avg - price) * closeQty;
      const pnl = gross - feeClose - entryFee;
      const cost = this.avg * closeQty;
      this.closed.push(this.makeTrade(side, closeQty, price, pnl, cost, fill, false));
      this.feePool -= entryFee;
      this.qty += this.qty < 0 ? closeQty : -closeQty;
      remaining += remaining < 0 ? closeQty : -closeQty;
      remainingFee -= feeClose;
      if (this.qty === 0) {
        this.avg = 0;
        this.entryTime = null;
        this.entryLabel = "";
        this.entryIndex = null;
        this.feePool = 0;
        this.note = "";
      }
    }
    if (remaining !== 0) {
      const add = Math.abs(remaining);
      if (this.qty === 0) {
        this.avg = price;
        this.qty = remaining;
        this.entryTime = fill.t;
        this.entryLabel = fill.label;
        this.entryIndex = fill.barIndex;
        this.feePool = remainingFee;
        this.note = fill.note || "";
      } else {
        this.avg = (this.avg * Math.abs(this.qty) + price * add) / (Math.abs(this.qty) + add);
        this.feePool += remainingFee;
        this.qty += remaining;
      }
    }
  }

  makeTrade(side, qty, exitPrice, pnl, cost, fill, isOpen) {
    const exitNote = isOpen ? "" : (fill.note || "");
    const parts = [this.note, exitNote].filter(Boolean);
    return {
      side,
      entryTime: this.entryTime,
      entryLabel: this.entryLabel,
      exitTime: isOpen ? null : fill.t,
      exitLabel: isOpen ? null : fill.label,
      qty,
      entryPrice: this.avg,
      exitPrice,
      pnl,
      returnPct: cost ? pnl / cost : null,
      barsHeld: this.entryIndex === null ? null : fill.barIndex - this.entryIndex,
      note: parts.join(" → "),
      entryNote: this.note,
      exitNote,
      open: isOpen,
    };
  }

  openTrade(lastBar, lastIndex) {
    if (this.qty === 0) return null;
    const price = Number(lastBar.c);
    const side = this.qty > 0 ? "long" : "short";
    const qty = Math.abs(this.qty);
    const pnl = (side === "long" ? price - this.avg : this.avg - price) * qty - this.feePool;
    return this.makeTrade(side, qty, price, pnl, this.avg * qty, { t: lastBar.t, label: lastBar.label, barIndex: lastIndex }, true);
  }
}

function tail(values, end) {
  return {
    length: end,
    at(i) {
      if (i < 0) i += end;
      if (i < 0 || i >= end) return undefined;
      return values[i];
    },
    slice(from, to) {
      const start = from < 0 ? from + end : from;
      return values.slice(start, to === undefined ? end : to);
    },
    get last() {
      return values[end - 1];
    },
  };
}

function makeView(i, arrays, position, cash, equity, symbol) {
  const closes = arrays.closes;
  const view = {
    i,
    symbol,
    position,
    cash,
    equity,
    open: tail(arrays.opens, i + 1),
    high: tail(arrays.highs, i + 1),
    low: tail(arrays.lows, i + 1),
    close: tail(closes, i + 1),
    volume: tail(arrays.volumes, i + 1),
  };
  Object.defineProperty(view, "price", { get: () => Number(view.close.last) });
  return view;
}

function simulate(bars, strategy, cash, commissionRate, slippageBps, allowShort, symbol, risk = {}) {
  const stopLoss = Number(risk.stopLossPct) > 0 ? Number(risk.stopLossPct) / 100 : 0;
  const takeProfit = Number(risk.takeProfitPct) > 0 ? Number(risk.takeProfitPct) / 100 : 0;
  const lot = Math.max(1, Math.trunc(Number(risk.lot) || 1));
  const tPlusOne = Boolean(risk.tPlusOne);
  const slip = slippageBps / 10000;
  const arrays = {
    opens: bars.map((bar) => bar.o),
    highs: bars.map((bar) => bar.h),
    lows: bars.map((bar) => bar.l),
    closes: bars.map((bar) => bar.c),
    volumes: bars.map((bar) => bar.v || 0),
  };
  let position = 0;
  let pending = strategy.onStart();
  let lastSignal = pending === null || pending === undefined ? 0 : clampWeight(Number(pending), allowShort);
  if (pending !== null && pending !== undefined) pending = lastSignal;
  let pendingNote = strategy.note || "";
  const book = new PositionBook();
  const markers = [];
  const warnings = [];
  let fees = 0;
  const equityValues = [];
  const positions = [];
  let clampedOnce = false;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (pending !== null && pending !== undefined && bar.o) {
      const applied = executeOrder(cash, position, pending, bar.o, commissionRate, slippageBps, allowShort, lot);
      cash = applied.cash;
      position = applied.position;
      if (applied.fill) {
        applied.fill.t = bar.t;
        applied.fill.label = bar.label;
        applied.fill.barIndex = i;
        applied.fill.note = pendingNote;
        fees += applied.fill.fee;
        book.apply(applied.fill);
        markers.push({
          t: bar.t,
          label: bar.label,
          side: applied.fill.side,
          price: applied.fill.price,
          qty: applied.fill.qty,
          note: pendingNote,
        });
      }
      pending = null;
      pendingNote = "";
    }
    // 止损止盈：当根的最高最低价已经碰到阈值，就按触发价平掉，不用等下一根开盘。
    if (position !== 0 && book.avg > 0 && (stopLoss > 0 || takeProfit > 0)) {
      const long = position > 0;
      // T+1：当天买入的仓位当天不能卖。
      const blockedByT1 = tPlusOne && book.entryIndex === i;
      if (!blockedByT1) {
        const stopPx = long ? book.avg * (1 - stopLoss) : book.avg * (1 + stopLoss);
        const takePx = long ? book.avg * (1 + takeProfit) : book.avg * (1 - takeProfit);
        const openPx = bar.o || bar.c;
        let exitPx = null;
        let reason = "";
        if (long) {
          if (stopLoss > 0 && bar.l <= stopPx) {
            exitPx = Math.min(openPx, stopPx);
            reason = "止损";
          } else if (takeProfit > 0 && bar.h >= takePx) {
            exitPx = Math.max(openPx, takePx);
            reason = "止盈";
          }
        } else if (stopLoss > 0 && bar.h >= stopPx) {
          exitPx = Math.max(openPx, stopPx);
          reason = "止损";
        } else if (takeProfit > 0 && bar.l <= takePx) {
          exitPx = Math.min(openPx, takePx);
          reason = "止盈";
        }
        if (exitPx !== null) {
          const qty = Math.abs(position);
          const fillPx = long ? exitPx * (1 - slip) : exitPx * (1 + slip);
          const fee = qty * fillPx * commissionRate;
          cash += (long ? 1 : -1) * qty * fillPx - fee;
          const fill = {
            side: long ? "sell" : "buy",
            qty,
            price: fillPx,
            fee,
            t: bar.t,
            label: bar.label,
            barIndex: i,
            note: reason,
          };
          position = 0;
          fees += fee;
          book.apply(fill);
          markers.push({ t: bar.t, label: bar.label, side: fill.side, price: fillPx, qty, note: reason });
          lastSignal = 0;
          pending = null;
          pendingNote = "";
        }
      }
    }
    const mark = bar.c ? bar.c : arrays.opens[i] || 0;
    const equity = cash + position * (mark || 0);
    equityValues.push(equity);
    positions.push(position);
    const view = makeView(i, arrays, position, cash, equity, symbol);
    let signal;
    try {
      signal = strategy.onBar(view);
    } catch (error) {
      throw new Error(`策略在 ${bar.label || i} 出错：${error.message}`);
    }
    if (signal === null || signal === undefined) continue;
    const raw = Number(signal);
    if (!Number.isFinite(raw)) throw new Error(`策略必须返回目标仓位（0 到 1 的数字），收到的是 ${signal}。`);
    const clipped = clampWeight(raw, allowShort);
    if (!clampedOnce && Math.abs(clipped - raw) > ENGINE_EPS) {
      clampedOnce = true;
      if (!allowShort && raw < 0) warnings.push("策略给出了空头仓位，但当前没有允许做空，已按空仓处理。");
      else warnings.push("策略仓位超出 -1 到 1，已截断。默认不使用杠杆。");
    }
    if (Math.abs(clipped - lastSignal) > ENGINE_EPS) {
      pending = clipped;
      pendingNote = strategy.note || "";
      lastSignal = clipped;
    }
  }
  const trades = book.closed.slice();
  const openTrade = book.openTrade(bars[bars.length - 1], bars.length - 1);
  if (openTrade) trades.push(openTrade);
  return {
    equityValues, positions, trades, markers, warnings,
    fees, cash, position, lastSignal, pending,
  };
}

function drawdowns(initial, values) {
  let peak = initial;
  return values.map((equity) => {
    peak = Math.max(peak, equity);
    return peak ? equity / peak - 1 : 0;
  });
}

function alignBars(primary, other) {
  const aligned = [];
  let j = 0;
  let last = null;
  for (const bar of primary) {
    while (j < other.length && other[j].t <= bar.t) {
      last = other[j];
      j++;
    }
    if (!last) aligned.push({ t: bar.t, label: bar.label, o: null, h: null, l: null, c: null, v: 0 });
    else aligned.push({ t: bar.t, label: bar.label, o: last.o, h: last.h, l: last.l, c: last.c, v: last.v || 0 });
  }
  return aligned;
}

function runBacktest(bars, strategy, options = {}) {
  const {
    cash = 100000,
    commissionBps = 1,
    slippageBps = 5,
    allowShort = false,
    benchBars = null,
    symbol = "",
    includeBenchmark = true,
    stopLossPct = 0,
    takeProfitPct = 0,
    lot = 1,
    tPlusOne = false,
  } = options;
  if (!bars || bars.length < 2) throw new Error("K 线不足，无法回测。");
  const opens = bars.map((bar) => bar.o);
  const highs = bars.map((bar) => bar.h);
  const lows = bars.map((bar) => bar.l);
  const closes = bars.map((bar) => bar.c);
  const volumes = bars.map((bar) => bar.v);
  strategy.prepare(closes, highs, lows, volumes);

  const commissionRate = commissionBps / 10000;
  const result = simulate(bars, strategy, Number(cash), commissionRate, slippageBps, allowShort, symbol, {
    stopLossPct,
    takeProfitPct,
    lot,
    tPlusOne,
  });
  let benchValues;
  let benchFees;
  if (includeBenchmark) {
    const benchSource = benchBars === null ? bars : alignBars(bars, benchBars);
    const bench = simulate(benchSource, new BuyHold(), Number(cash), commissionRate, slippageBps, false, "");
    benchValues = bench.equityValues;
    benchFees = bench.fees;
  } else {
    benchValues = new Array(bars.length).fill(null);
    benchFees = 0;
  }
  const dds = drawdowns(Number(cash), result.equityValues);
  const equity = bars.map((bar, i) => ({
    t: bar.t,
    label: bar.label,
    equity: result.equityValues[i],
    bench: benchValues[i],
    drawdown: dds[i],
    position: result.positions[i],
    close: bar.c,
  }));
  const warnings = result.warnings.slice();
  if (result.pending !== null && result.pending !== undefined) {
    warnings.push("最后一根 K 线出现了新信号。按规则要下一根开盘才成交，所以这笔没有算进样本。");
  }
  return {
    equity,
    trades: result.trades,
    markers: result.markers,
    warnings,
    fees: result.fees,
    endingEquity: result.equityValues[result.equityValues.length - 1],
    endingCash: result.cash,
    endingPosition: result.position,
    endingSignal: result.lastSignal,
    benchEquity: benchValues,
    benchFees,
  };
}

const BARS_PER_YEAR = { "1d": 252, "1wk": 52, "1h": 1638, "15m": 6552, "5m": 19656 };

function inferBarsPerYear(times, interval, nReturns) {
  const fallback = BARS_PER_YEAR[interval] || 252;
  if (times.length < 2 || nReturns < 2) return fallback;
  const years = (times[times.length - 1] - times[0]) / (365.25 * 86400);
  if (years < 5 / 365.25) return fallback;
  return Math.max(1, nReturns / years);
}

function summarize(initial, equityRows, trades, fees, interval) {
  const equities = equityRows.map((row) => Number(row.equity));
  const times = equityRows.map((row) => Number(row.t));
  const ending = equities.length ? equities[equities.length - 1] : initial;
  const totalReturn = initial ? ending / initial - 1 : null;
  let years = 0;
  if (times.length >= 2) years = Math.max(0, (times[times.length - 1] - times[0]) / (365.25 * 86400));
  let cagr = null;
  if (years > 1 / 365.25 && initial > 0 && ending > 0) cagr = (ending / initial) ** (1 / years) - 1;
  const returns = [];
  let prev = initial;
  for (const equity of equities) {
    if (prev > 0) returns.push(equity / prev - 1);
    prev = equity;
  }
  let volatility = null;
  let sharpe = null;
  let sortino = null;
  const barsPerYear = inferBarsPerYear(times, interval, returns.length || equities.length);
  if (returns.length >= 2) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    let sq = 0;
    for (const r of returns) sq += (r - mean) ** 2;
    const std = Math.sqrt(sq / (returns.length - 1));
    if (std > 0) {
      volatility = std * Math.sqrt(barsPerYear);
      sharpe = (mean / std) * Math.sqrt(barsPerYear);
    }
    let downSq = 0;
    for (const r of returns) downSq += Math.min(r, 0) ** 2;
    const downside = Math.sqrt(downSq / returns.length);
    if (downside > 0) sortino = (mean / downside) * Math.sqrt(barsPerYear);
  }
  const dds = equityRows.map((row) => Number(row.drawdown) || 0);
  const maxDrawdown = dds.length ? Math.min(...dds) : 0;
  const calmar = cagr !== null && maxDrawdown < 0 ? cagr / Math.abs(maxDrawdown) : null;
  const closed = trades.filter((trade) => !trade.open);
  const wins = closed.filter((trade) => (trade.pnl || 0) > 0);
  const losses = closed.filter((trade) => (trade.pnl || 0) < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = losses.reduce((a, t) => a + t.pnl, 0);
  const profitFactor = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null;
  const holds = closed.filter((t) => t.barsHeld !== null && t.barsHeld !== undefined).map((t) => t.barsHeld);
  const closedReturns = closed.filter((t) => t.returnPct !== null && t.returnPct !== undefined).map((t) => t.returnPct);
  const exposure = equityRows.length ? equityRows.filter((row) => row.position).length / equityRows.length : 0;
  const last = equityRows.length ? equityRows[equityRows.length - 1] : {};
  let endingWeight = null;
  if (last.equity) endingWeight = ((last.position || 0) * (last.close || 0)) / last.equity;
  return {
    totalReturn, cagr, volatility, sharpe, sortino,
    maxDrawdown,
    maxDrawdownDays: underwaterDays(times, equities, initial),
    calmar,
    winRate: closed.length ? wins.length / closed.length : null,
    profitFactor,
    trades: closed.length,
    openTrades: trades.filter((trade) => trade.open).length,
    wins: wins.length,
    losses: losses.length,
    avgTradeReturn: closedReturns.length ? closedReturns.reduce((a, b) => a + b, 0) / closedReturns.length : null,
    avgHoldBars: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    exposure,
    fees: Number(fees || 0),
    endingEquity: ending,
    endingWeight,
    years,
  };
}

function underwaterDays(times, equities, initial) {
  if (!times.length) return 0;
  let peak = initial;
  let start = null;
  let longest = 0;
  for (let i = 0; i < times.length; i++) {
    if (equities[i] >= peak - 1e-8) {
      peak = equities[i];
      if (start !== null) {
        longest = Math.max(longest, times[i] - start);
        start = null;
      }
    } else if (start === null) {
      start = times[i];
    }
  }
  if (start !== null) longest = Math.max(longest, times[times.length - 1] - start);
  return Math.round(longest / 86400);
}

function windowSummary(startEquity, rows, interval) {
  let peak = Number(startEquity);
  const shaped = rows.map((row) => {
    const equity = Number(row.equity);
    peak = Math.max(peak, equity);
    return {
      t: row.t,
      equity,
      drawdown: peak ? equity / peak - 1 : 0,
      position: row.position || 0,
      close: row.close || 0,
    };
  });
  return summarize(startEquity, shaped, [], 0, interval);
}

function splitReport(initial, equityRows, interval, ratio = 0.7) {
  const count = equityRows.length;
  const split = Math.trunc(count * ratio);
  if (split < 20 || count - split < 20) return null;
  const earlier = equityRows.slice(0, split);
  const later = equityRows.slice(split);
  const laterStart = Number(earlier[earlier.length - 1].equity);
  if (laterStart <= 0) return null;
  const keys = ["totalReturn", "cagr", "sharpe", "maxDrawdown", "endingEquity", "volatility"];
  const brief = (metrics) => {
    const out = {};
    for (const key of keys) out[key] = metrics[key];
    return out;
  };
  return {
    ratio,
    splitLabel: earlier[earlier.length - 1].label,
    inSample: brief(windowSummary(initial, earlier, interval)),
    outOfSample: brief(windowSummary(laterStart, later, interval)),
  };
}

const Engine = {
  IND, Strategy, BUILTINS, strategyCatalog, createStrategy,
  runBacktest, summarize, splitReport, inferBarsPerYear, equityRowsFromValues, PositionBook,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Engine;
}

function equityRowsFromValues(template, values, initial) {
  let peak = initial;
  return template.map((row, i) => {
    const equity = values[i];
    peak = Math.max(peak, equity);
    return {
      t: row.t,
      equity,
      drawdown: peak ? equity / peak - 1 : 0,
      position: 1,
      close: row.close || 0,
    };
  });
}
