/* 把浏览器引擎的结果整理成与原后端 API 一致的形状，渲染层不用改。
   纸面账户改存在 localStorage。 */

const FIELD_MAP = {
  totalReturn: "total_return",
  maxDrawdown: "max_drawdown",
  maxDrawdownDays: "max_drawdown_days",
  winRate: "win_rate",
  profitFactor: "profit_factor",
  openTrades: "open_trades",
  avgTradeReturn: "avg_trade_return",
  avgHoldBars: "avg_hold_bars",
  endingEquity: "ending_equity",
  endingWeight: "ending_weight",
  endingCash: "ending_cash",
  endingPosition: "ending_position",
  entryTime: "entry_time",
  entryLabel: "entry_label",
  exitTime: "exit_time",
  exitLabel: "exit_label",
  entryPrice: "entry_price",
  exitPrice: "exit_price",
  returnPct: "return_pct",
  barsHeld: "bars_held",
  splitLabel: "split_label",
  inSample: "in_sample",
  outOfSample: "out_of_sample",
};

function snake(value) {
  if (Array.isArray(value)) return value.map(snake);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[FIELD_MAP[key] || key] = snake(item);
    }
    return out;
  }
  return value;
}

function emptyMetrics() {
  return snake(Engine.summarize(1, [], [], 0, "1d"));
}

const Bridge = {
  backtest({ symbol, interval, start, end, meta, strategyId, params, cash, commissionBps, slippageBps, allowShort, benchmark, benchBars = null, benchSymbol = null, benchLabel = null }) {
    const started = performance.now();
    const bars = meta.bars;
    const { strategy, warning } = Engine.createStrategy(strategyId, params);
    const warnings = [];
    if (meta.warning) warnings.push(meta.warning);
    if (warning) warnings.push(warning);

    if (benchmark !== "self" && benchmark !== "none" && !benchBars) {
      warnings.push(`${benchmark} 没有加载成功，已改和同一标的的买入持有对比。`);
    }
    const raw = Engine.runBacktest(bars, strategy, {
      cash, commissionBps, slippageBps, allowShort, benchBars, symbol,
    });
    warnings.push(...raw.warnings);
    if (benchmark === "none") {
      for (const row of raw.equity) row.bench = null;
    }
    const metrics = Engine.summarize(cash, raw.equity, raw.trades, raw.fees, interval);
    metrics.endingCash = raw.endingCash;
    metrics.endingPosition = raw.endingPosition;

    let benchmarkPayload = null;
    if (benchmark !== "none") {
      const benchRows = Engine.equityRowsFromValues(raw.equity, raw.benchEquity, cash);
      benchmarkPayload = {
        symbol: benchSymbol || symbol,
        label: benchLabel || `买入持有 ${symbol}`,
        metrics: Engine.summarize(cash, benchRows, [], raw.benchFees, interval),
      };
    }
    const overlays = strategy.overlays().map((item) => ({
      name: item.name,
      color: item.color,
      values: (item.values || []).map((value) => (Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null)),
    }));
    return {
      symbol: meta.symbol || symbol,
      name: meta.name || symbol,
      exchange: meta.exchange || "",
      currency: meta.currency || "USD",
      interval,
      source: meta.source || "",
      adjusted: meta.adjusted !== false,
      cached: false,
      warning: warnings.length ? warnings.join(" ") : null,
      warnings,
      bars,
      metrics: snake(metrics),
      benchmark: benchmarkPayload ? snake(benchmarkPayload) : null,
      equity: raw.equity,
      trades: snake(raw.trades),
      markers: raw.markers,
      overlays,
      ending_signal: raw.endingSignal,
      strategy: { id: strategy.id, name: strategy.name, params: strategy.params },
      assumptions: {
        cash, commission_bps: commissionBps, slippage_bps: slippageBps,
        allow_short: allowShort, fill: "下一根开盘",
      },
      split: snake(Engine.splitReport(cash, raw.equity, interval)),
      elapsed_ms: Math.round((performance.now() - started) * 10) / 10,
    };
  },

  compare({ symbol, interval, start, end, meta, cash, commissionBps, slippageBps, allowShort, benchmark }) {
    const started = performance.now();
    const classes = Engine.strategyCatalog();
    const warnings = meta.warning ? [meta.warning] : [];
    let benchmarkPayload = null;
    if (benchmark !== "none") {
      const buyHold = new (Engine.BUILTINS[0])({});
      const probe = Engine.runBacktest(meta.bars, buyHold, { cash, commissionBps, slippageBps, allowShort: false, symbol });
      benchmarkPayload = {
        symbol,
        label: `买入持有 ${symbol}`,
        metrics: snake(Engine.summarize(cash, probe.equity, probe.trades, probe.fees, interval)),
      };
    }
    const rows = [];
    let bestSharpe = null;
    let bestReturn = null;
    let bestSharpeId = null;
    let bestReturnId = null;
    for (const item of classes) {
      try {
        const { strategy, warning } = Engine.createStrategy(item.id, {});
        const raw = Engine.runBacktest(meta.bars, strategy, {
          cash, commissionBps, slippageBps, allowShort, includeBenchmark: false, symbol,
        });
        const metrics = Engine.summarize(cash, raw.equity, raw.trades, raw.fees, interval);
        metrics.endingCash = raw.endingCash;
        metrics.endingPosition = raw.endingPosition;
        rows.push({ id: item.id, name: item.name, origin: item.origin, params: strategy.params, warning, metrics: snake(metrics) });
        if (metrics.sharpe !== null && (bestSharpe === null || metrics.sharpe > bestSharpe)) {
          bestSharpe = metrics.sharpe;
          bestSharpeId = item.id;
        }
        if (metrics.totalReturn !== null && (bestReturn === null || metrics.totalReturn > bestReturn)) {
          bestReturn = metrics.totalReturn;
          bestReturnId = item.id;
        }
      } catch (error) {
        rows.push({ id: item.id, name: item.name, origin: item.origin, params: {}, error: error.message, metrics: null });
      }
    }
    rows.sort((a, b) => {
      const av = a.metrics?.total_return;
      const bv = b.metrics?.total_return;
      return (Number.isFinite(bv) ? bv : -999) - (Number.isFinite(av) ? av : -999);
    });
    return {
      symbol: meta.symbol || symbol,
      interval,
      rows,
      benchmark: benchmarkPayload,
      best_sharpe: bestSharpeId,
      best_return: bestReturnId,
      allow_short: allowShort,
      warning: warnings.join(" ") || null,
      elapsed_ms: Math.round((performance.now() - started) * 10) / 10,
    };
  },

  sweep({ symbol, interval, start, end, meta, strategyId, params, cash, commissionBps, slippageBps, allowShort, sweepKey, min, max, step }) {
    const catalog = Engine.strategyCatalog();
    const schema = (catalog.find((item) => item.id === strategyId) || {}).params || [];
    const spec = schema.find((item) => item.key === sweepKey);
    if (!spec || spec.type === "bool") throw new Error("请选择一个数字参数来扫描。");
    if (!(step > 0) || max < min) throw new Error("步长必须大于 0，且最大值不能小于最小值。");
    const count = Math.round((max - min) / step) + 1;
    if (count > 36) throw new Error("一次最多扫描 36 组，请加大步长。");
    const rows = [];
    let bestSharpe = null;
    let bestReturn = null;
    for (let i = 0; i < count; i++) {
      const value = spec.type === "int" ? Math.round(min + i * step) : Math.round((min + i * step) * 10000) / 10000;
      const trial = { ...params, [sweepKey]: value };
      const { strategy } = Engine.createStrategy(strategyId, trial);
      const raw = Engine.runBacktest(meta.bars, strategy, {
        cash, commissionBps, slippageBps, allowShort, includeBenchmark: false, symbol,
      });
      const metrics = Engine.summarize(cash, raw.equity, raw.trades, raw.fees, interval);
      rows.push({ value, metrics: snake(metrics) });
      if (metrics.sharpe !== null && (bestSharpe === null || metrics.sharpe > bestSharpe)) bestSharpe = value;
      if (metrics.totalReturn !== null && (bestReturn === null || metrics.totalReturn > bestReturn)) bestReturn = value;
    }
    return {
      key: sweepKey,
      label: spec.label || sweepKey,
      rows,
      best_sharpe: bestSharpe,
      best_return: bestReturn,
      warning: meta.warning || null,
    };
  },
};

const Paper = {
  KEY: "paperlab.paper.v1",
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.KEY) || "null");
      if (saved && typeof saved.cash === "number") return saved;
    } catch { /* 坏数据就重置 */ }
    return { cash: 100000, initial_cash: 100000, positions: {}, orders: [], fees: 0 };
  },
  save(account) {
    localStorage.setItem(this.KEY, JSON.stringify(account));
  },
  reset(cash) {
    if (!(cash >= 1000 && cash <= 1000000000)) throw new Error("重置资金请设在 1,000 到 10 亿之间。");
    const account = { cash, initial_cash: cash, positions: {}, orders: [], fees: 0 };
    this.save(account);
    return this.snapshot(account);
  },
  async snapshot(account) {
    const data = account || this.load();
    const positions = [];
    let marketValue = 0;
    let unrealized = 0;
    const missing = [];
    for (const [symbol, pos] of Object.entries(data.positions)) {
      let last = pos.last ?? null;
      try {
        const quote = await Data.loadQuote(symbol);
        if (quote && Number.isFinite(quote.price)) last = quote.price;
      } catch {
        missing.push(symbol);
      }
      const value = last === null ? 0 : last * pos.qty;
      marketValue += value;
      let upl = null;
      if (last !== null) {
        upl = (last - pos.avg_price) * pos.qty;
        unrealized += upl;
      }
      positions.push({
        symbol,
        qty: pos.qty,
        avg_price: pos.avg_price,
        last,
        market_value: last === null ? null : value,
        unrealized: upl,
        unrealized_pct: last !== null && pos.avg_price ? last / pos.avg_price - 1 : null,
      });
    }
    const equity = data.cash + marketValue;
    return {
      cash: data.cash,
      initial_cash: data.initial_cash,
      equity,
      pnl: equity - data.initial_cash,
      market_value: marketValue,
      unrealized,
      fees: data.fees || 0,
      positions,
      orders: data.orders.slice(-40).reverse(),
      warning: missing.length ? `这些持仓暂时没有现价：${missing.join("、")}` : null,
    };
  },
  async order(symbol, side, qty, commissionBps, slippageBps) {
    if (!(qty >= 1) || qty > 1000000) throw new Error("股数要是 1 到 100 万之间的整数。");
    const quote = await Data.loadQuote(symbol);
    if (!quote || !(quote.price > 0)) throw new Error("拿不到现价，这笔模拟单没有成交。");
    const price = Number(quote.price);
    const slip = slippageBps / 10000;
    const fill = side === "buy" ? price * (1 + slip) : price * (1 - slip);
    const fee = (qty * fill * commissionBps) / 10000;
    const data = this.load();
    const pos = data.positions[symbol] || { qty: 0, avg_price: 0, last: price };
    if (side === "buy") {
      const cost = qty * fill + fee;
      if (cost > data.cash + 1e-6) {
        throw new Error(`现金不够。这笔大约需要 ${cost.toFixed(2)}，账户还有 ${data.cash.toFixed(2)}。`);
      }
      const newQty = pos.qty + qty;
      pos.avg_price = newQty ? (pos.avg_price * pos.qty + fill * qty) / newQty : 0;
      pos.qty = newQty;
      pos.last = price;
      data.positions[symbol] = pos;
      data.cash -= cost;
    } else {
      if (qty > pos.qty) throw new Error(`${symbol} 只有 ${pos.qty} 股，不能卖出 ${qty} 股。手动模拟不做空。`);
      data.cash += qty * fill - fee;
      pos.qty -= qty;
      pos.last = price;
      if (pos.qty <= 0) delete data.positions[symbol];
      else data.positions[symbol] = pos;
    }
    data.fees = (data.fees || 0) + fee;
    data.orders.push({
      time: new Date().toLocaleString("zh-CN", { hour12: false }),
      symbol, side, qty, price: fill, quote: price, fee, name: quote.name || symbol,
    });
    data.orders = data.orders.slice(-200);
    this.save(data);
    return this.snapshot(data);
  },
};
