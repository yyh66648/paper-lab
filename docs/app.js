const $ = (id) => document.getElementById(id);
const WATCH = {
  us: ["NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "AMD", "SPY", "QQQ"],
  cn: ["600519.SH", "000001.SZ", "300750.SZ", "601318.SH", "000858.SZ", "002594.SZ", "510300.SH", "510050.SH", "159915.SZ"],
};
const PIN_COLORS = ["#c58bd0", "#8fce8f", "#e0a38a", "#8fd0d0", "#e6d38a"];

const state = {
  symbol: "NVDA",
  market: "us",
  interval: "1d",
  bars: [],
  meta: {},
  quote: null,
  strategies: [],
  result: null,
  pins: [],
  viewStart: 0,
  viewEnd: 0,
  runToken: 0,
};

const fmt = {
  px(n) {
    if (!Number.isFinite(n)) return "—";
    const digits = Math.abs(n) >= 1 ? 2 : 4;
    return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  money(n, currency = "USD", digits = 2) {
    if (!Number.isFinite(n)) return "—";
    const prefix = currency === "CNY" ? "¥" : "$";
    return prefix + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  usd(n) { return fmt.money(n, "USD", 0); },
  usd2(n) { return fmt.money(n, "USD", 2); },
  pct(n) {
    if (!Number.isFinite(n)) return "—";
    return (n > 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
  },
  num(n, d = 2) {
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  vol(n) {
    if (!Number.isFinite(n)) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  },
};

function tone(n) {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-12) return "flat";
  return n > 0 ? "up" : "down";
}

function isoDate(date) {
  const copy = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return copy.toISOString().slice(0, 10);
}

function shiftYears(date, years) {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() - years);
  return next;
}

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function showBanner(text, kind = "warn") {
  const banner = $("banner");
  if (!text) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.className = kind === "error" ? "banner error" : "banner";
  banner.textContent = text;
}

function currentStrategy() {
  return state.strategies.find((item) => item.id === $("strategySelect").value) || state.strategies[0];
}

function readParams() {
  const params = {};
  $("paramForm").querySelectorAll("[data-key]").forEach((input) => {
    params[input.dataset.key] = input.type === "checkbox" ? input.checked : Number(input.value);
  });
  return params;
}

function assumptions() {
  return {
    cash: Number($("cash").value),
    commission_bps: Number($("commission").value),
    slippage_bps: Number($("slippage").value),
    allow_short: $("allowShort").checked,
    benchmark: $("benchmark").value,
    stopLossPct: Number($("stopLoss").value) || 0,
    takeProfitPct: Number($("takeProfit").value) || 0,
    lot: Math.max(1, Number($("lotSize").value) || 1),
    tPlusOne: $("tPlusOne").checked,
  };
}

function saveSettings() {
  const settings = {
    symbol: state.symbol,
    market: state.market,
    interval: state.interval,
    start: $("startDate").value,
    end: $("endDate").value,
    strategy: $("strategySelect").value,
    params: readParams(),
    ...assumptions(),
  };
  localStorage.setItem("paperlab.settings.v1", JSON.stringify(settings));
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem("paperlab.settings.v1") || "null");
  } catch {
    return null;
  }
}

function currency() {
  return state.result?.currency || state.meta?.currency || state.quote?.currency || (state.market === "cn" ? "CNY" : "USD");
}

function renderWatch() {
  const list = WATCH[state.market] || WATCH.us;
  $("watchlist").innerHTML = list.map(
    (symbol) => `<button type="button" data-symbol="${symbol}" class="${symbol === state.symbol ? "on" : ""}">${symbol.replace(".SH", "").replace(".SZ", "")}</button>`
  ).join("");
  [...$("markets").children].forEach((item) => item.classList.toggle("on", item.dataset.market === state.market));
}

function renderQuote() {
  const quote = state.quote;
  const meta = state.meta;
  const strip = $("quoteStrip");
  if (!quote && !meta.symbol) {
    strip.innerHTML = `<span class="quiet">选一个标的，加载行情后即可回测。</span>`;
    return;
  }
  const price = quote?.price ?? state.bars.at(-1)?.c;
  const change = quote?.change_pct;
  const name = quote?.name || meta.name || "";
  strip.innerHTML = `
    <span class="sym">${esc(meta.symbol || quote.symbol)}</span>
    <span class="px num ${tone(change)}">${fmt.money(price, quote?.currency || currency(), Math.abs(price) >= 100 ? 2 : 2)}</span>
    <span class="num ${tone(change)}">${fmt.pct(change)}</span>
    <span class="name">${esc(name)}${quote?.exchange ? " · " + esc(quote.exchange) : ""}</span>`;
  const lastLabel = meta.end || state.bars.at(-1)?.label || "";
  const staleDays = stalenessDays(lastLabel);
  const freshTag = state.market === "us" && staleDays !== null
    ? (staleDays <= 1 ? " · 最新" : staleDays <= 4 ? ` · 落后 ${staleDays} 天` : ` · 已过时 ${staleDays} 天`)
    : "";
  $("dataSource").textContent = meta.source
    ? `${esc(meta.source)}${meta.adjusted ? " · 复权" : ""}${freshTag}`
    : "行情未连接";
  $("dataSource").className = state.market === "us" && staleDays > 4 ? "stale" : "";
}

function stalenessDays(label) {
  if (!label) return null;
  const date = new Date(String(label).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((todayUtc - date.getTime()) / 86400000));
}

function renderStrategyForm() {
  const strategy = currentStrategy();
  if (!strategy) return;
  $("strategyDesc").textContent = strategy.description || "";
  const saved = state.savedParams || {};
  $("paramForm").innerHTML = (strategy.params || [])
    .map((spec) => {
      const value = saved[spec.key] ?? spec.default;
      if (spec.type === "bool") {
        return `<label class="check"><input data-key="${spec.key}" type="checkbox" ${value ? "checked" : ""}/> ${spec.label}</label>`;
      }
      return `<label>${spec.label}<input data-key="${spec.key}" type="number" value="${value}" min="${spec.min ?? ""}" max="${spec.max ?? ""}" step="${spec.step || (spec.type === "int" ? 1 : 0.1)}" /></label>`;
    })
    .join("");
  const numeric = (strategy.params || []).filter((spec) => spec.type !== "bool");
  const options = numeric
    .map((spec) => `<option value="${spec.key}">${spec.label}</option>`)
    .join("");
  $("sweepParam").innerHTML = options;
  $("sweepParam2").innerHTML = options;
  const first = numeric[0];
  if (first) {
    $("sweepMin").value = first.min ?? first.default;
    $("sweepMax").value = first.max ?? first.default;
    $("sweepStep").value = first.step || 1;
  }
  const second = numeric[1] || numeric[0];
  if (second) {
    $("sweepParam2").value = second.key;
    $("sweepMin2").value = second.min ?? second.default;
    $("sweepMax2").value = second.max ?? second.default;
    $("sweepStep2").value = (second.step || 1) * 5;
  }
  $("sweepMode").value = numeric.length > 1 ? $("sweepMode").value : "1";
  applySweepMode();
  state.savedParams = null;
}

function applySweepMode() {
  const twoD = $("sweepMode").value === "2";
  document.querySelectorAll("#tab-sweep .two-d").forEach((item) => { item.hidden = !twoD; });
}

function sweepAxis(spec, minId, maxId, stepId) {
  if (!spec) return null;
  const min = Number($(minId).value);
  const max = Number($(maxId).value);
  const step = Number($(stepId).value);
  if (!(step > 0) || !(max >= min)) return null;
  return { min, max, step };
}

function setView(start, end) {
  const n = state.bars.length;
  if (!n) return;
  const width = Math.max(20, Math.min(n, end - start));
  state.viewStart = Math.max(0, Math.min(start, n - width));
  state.viewEnd = state.viewStart + width;
}

function resetView() {
  const n = state.bars.length;
  const windowSize = state.interval === "1d" || state.interval === "1wk" ? Math.min(n, 252) : n;
  setView(n - windowSize, n);
}

function indexOfTime(t) {
  return state.bars.findIndex((bar) => bar.t === t);
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function plotBox(w, h, right = 68) {
  return { left: 10, right: w - right, top: 12, bottom: h - 22, width: w - right - 10, height: h - 34 };
}

function yScale(min, max, top, height) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return () => top;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  const lo = min - pad;
  const hi = max + pad;
  return (value) => top + ((hi - value) / (hi - lo)) * height;
}

function strokeLine(ctx, points, color, dashed = false, width = 1.4) {
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [4, 4] : []);
  let drawing = false;
  points.forEach((point) => {
    if (!point || !Number.isFinite(point.y)) {
      drawing = false;
      return;
    }
    if (!drawing) {
      ctx.moveTo(point.x, point.y);
      drawing = true;
    } else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.restore();
}

function visibleSlice() {
  return state.bars.slice(state.viewStart, state.viewEnd);
}

function xOf(index, plot, count) {
  const slot = plot.width / Math.max(count, 1);
  return plot.left + (index + 0.5) * slot;
}

function drawPrice() {
  const canvas = $("priceChart");
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const bars = visibleSlice();
  if (!bars.length || w < 40 || h < 40) return;
  const plot = plotBox(w, h);
  const volumeTop = plot.top + plot.height * 0.76;
  const priceBottom = volumeTop - 8;
  const priceHeight = priceBottom - plot.top;
  let min = Infinity;
  let max = -Infinity;
  let maxVol = 0;
  bars.forEach((bar) => {
    min = Math.min(min, bar.l);
    max = Math.max(max, bar.h);
    maxVol = Math.max(maxVol, bar.v || 0);
  });
  (state.result?.overlays || []).forEach((overlay) => {
    for (let i = state.viewStart; i < state.viewEnd; i++) {
      const value = overlay.values?.[i];
      if (Number.isFinite(value)) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  });
  (state.result?.markers || []).forEach((marker) => {
    const index = indexOfTime(marker.t);
    if (index >= state.viewStart && index < state.viewEnd && Number.isFinite(marker.price)) {
      min = Math.min(min, marker.price);
      max = Math.max(max, marker.price);
    }
  });
  const y = yScale(min, max, plot.top, priceHeight);
  const slot = plot.width / bars.length;
  ctx.font = '11px Consolas, "Microsoft YaHei", sans-serif';
  ctx.strokeStyle = "#243041";
  ctx.fillStyle = "#667386";
  const step = niceStep(max - min, 5);
  if (step > 0) {
    for (let tick = Math.ceil(min / step) * step; tick <= max; tick += step) {
      const yy = y(tick);
      ctx.beginPath();
      ctx.moveTo(plot.left, yy);
      ctx.lineTo(plot.right, yy);
      ctx.stroke();
      ctx.fillText(fmt.px(tick), plot.right + 6, yy + 3);
    }
  }
  bars.forEach((bar, i) => {
    const x = xOf(i, plot, bars.length);
    const up = bar.c >= bar.o;
    ctx.strokeStyle = up ? "#3cba84" : "#e15d68";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(x, y(bar.h));
    ctx.lineTo(x, y(bar.l));
    ctx.stroke();
    if (slot >= 2.1) {
      const body = Math.max(1, Math.min(8, slot * 0.62));
      const top = y(Math.max(bar.o, bar.c));
      const bottom = y(Math.min(bar.o, bar.c));
      ctx.fillRect(x - body / 2, top, body, Math.max(1, bottom - top));
    }
    if (maxVol > 0) {
      const vh = ((bar.v || 0) / maxVol) * (plot.bottom - volumeTop);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x - Math.max(1, slot * 0.3), plot.bottom - vh, Math.max(1, slot * 0.6), vh);
      ctx.globalAlpha = 1;
    }
  });
  if (slot < 2.1) {
    strokeLine(
      ctx,
      bars.map((bar, i) => ({ x: xOf(i, plot, bars.length), y: y(bar.c) })),
      "#d7dde6",
      false,
      1.2
    );
  }
  (state.result?.overlays || []).forEach((overlay) => {
    strokeLine(
      ctx,
      bars.map((_, i) => {
        const value = overlay.values?.[state.viewStart + i];
        return Number.isFinite(value) ? { x: xOf(i, plot, bars.length), y: y(value) } : null;
      }),
      overlay.color || "#d6a25a"
    );
  });
  (state.result?.markers || []).forEach((marker) => {
    const index = indexOfTime(marker.t) - state.viewStart;
    if (index < 0 || index >= bars.length) return;
    const x = xOf(index, plot, bars.length);
    const yy = y(marker.price);
    ctx.fillStyle = marker.side === "buy" ? "#3cba84" : "#e15d68";
    ctx.beginPath();
    if (marker.side === "buy") ctx.moveTo(x, yy + 10), ctx.lineTo(x - 4, yy + 16), ctx.lineTo(x + 4, yy + 16);
    else ctx.moveTo(x, yy - 10), ctx.lineTo(x - 4, yy - 16), ctx.lineTo(x + 4, yy - 16);
    ctx.fill();
  });
  const labels = timeLabels(bars, plot.width);
  ctx.fillStyle = "#667386";
  labels.forEach((item) => ctx.fillText(item.text, xOf(item.index, plot, bars.length) - 24, h - 6));
  canvas._plot = { ...plot, y, count: bars.length, priceHeight };
}

function drawEquity() {
  const canvas = $("equityChart");
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const result = state.result;
  if (!result?.equity?.length || w < 40 || h < 40) {
    ctx.fillStyle = "#667386";
    ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText("运行回测后，这里比较策略和买入持有。", 16, 28);
    return;
  }
  const plot = plotBox(w, h);
  const split = plot.top + plot.height * 0.68;
  const bars = visibleSlice();
  const cash = result.assumptions?.cash || Number($("cash").value) || 100000;
  const series = [
    {
      name: result.strategy?.name || "策略",
      color: "#e2b56a",
      values: result.equity.map((row) => row.equity / cash * 100),
    },
  ];
  if (result.benchmark && result.equity.some((row) => row.bench != null)) {
    series.push({
      name: result.benchmark.label,
      color: "#7ea4c4",
      dashed: true,
      values: result.equity.map((row) => (row.bench == null ? null : row.bench / cash * 100)),
    });
  }
  state.pins.forEach((pin) => {
    const map = new Map(pin.points.map((point) => [point.t, point.equity / pin.cash * 100]));
    series.push({
      name: pin.label,
      color: pin.color,
      values: state.bars.map((bar) => map.get(bar.t) ?? null),
    });
  });
  let minV = Infinity;
  let maxV = -Infinity;
  series.forEach((item) => {
    for (let i = state.viewStart; i < state.viewEnd; i++) {
      const value = item.values[i];
      if (!Number.isFinite(value)) continue;
      minV = Math.min(minV, value);
      maxV = Math.max(maxV, value);
    }
  });
  if (!Number.isFinite(minV)) return;
  const y = yScale(minV, maxV, plot.top, split - plot.top - 8);
  ctx.strokeStyle = "#243041";
  ctx.beginPath();
  ctx.moveTo(plot.left, y(100));
  ctx.lineTo(plot.right, y(100));
  ctx.stroke();
  ctx.fillStyle = "#667386";
  ctx.font = '11px Consolas, sans-serif';
  ctx.fillText("100", plot.right + 6, y(100) + 3);
  series.forEach((item) => {
    strokeLine(
      ctx,
      bars.map((_, i) => {
        const value = item.values[state.viewStart + i];
        return Number.isFinite(value) ? { x: xOf(i, plot, bars.length), y: y(value) } : null;
      }),
      item.color,
      item.dashed
    );
  });
  const dds = result.equity.slice(state.viewStart, state.viewEnd).map((row) => row.drawdown || 0);
  const minDd = Math.min(...dds, -0.01);
  const yDd = (value) => split + 8 + ((0 - value) / (0 - minDd * 1.08)) * (plot.bottom - split - 10);
  ctx.beginPath();
  dds.forEach((value, i) => {
    const x = xOf(i, plot, bars.length);
    if (i === 0) ctx.moveTo(x, yDd(value));
    else ctx.lineTo(x, yDd(value));
  });
  ctx.lineTo(xOf(dds.length - 1, plot, bars.length), yDd(0));
  ctx.lineTo(xOf(0, plot, bars.length), yDd(0));
  ctx.fillStyle = "rgba(225, 93, 104, 0.28)";
  ctx.fill();
  ctx.fillStyle = "#667386";
  ctx.fillText("回撤 " + fmt.pct(Math.min(...dds)), plot.left, split + 12);
  canvas._plot = { ...plot, y, count: bars.length, series };
  $("equityLegend").innerHTML = series
    .map((item) => `<span><i style="background:${esc(item.color)}"></i>${esc(item.name)}</span>`)
    .join("");
}

function timeLabels(bars, width) {
  const slots = Math.max(2, Math.floor(width / 96));
  const step = Math.max(1, Math.ceil(bars.length / slots));
  const labels = [];
  for (let i = 0; i < bars.length; i += step) labels.push({ index: i, text: bars[i].label.slice(0, 10) });
  return labels;
}

function niceStep(span, ticks) {
  if (!Number.isFinite(span) || span <= 0) return 0;
  const rough = span / ticks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const err = rough / pow;
  const factor = err >= 7 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1;
  return factor * pow;
}

function drawAll() {
  drawPrice();
  drawEquity();
  const overlays = state.result?.overlays || [];
  $("priceLegend").innerHTML = overlays
    .map((item) => `<span><i style="background:${esc(item.color)}"></i>${esc(item.name)}</span>`)
    .join("");
  const last = state.bars.at(-1);
  const meta = state.meta;
  $("chartTitle").textContent = meta.symbol
    ? `${esc(meta.symbol)} · ${esc(meta.name || "")} · ${intervalLabel(state.interval)} · ${meta.adjusted ? "复权" : esc(meta.source || "")}`
    : "价格";
  if (last) {
    $("dataHint").textContent = `已加载 ${state.bars.length} 根 · ${state.bars[0].label} 至 ${last.label}${meta.cached ? " · 缓存" : ""}`;
  }
}

function intervalLabel(interval) {
  return { "1d": "日K", "1wk": "周K", "1h": "1小时", "15m": "15分", "5m": "5分" }[interval] || interval;
}

function bindChart(canvas, which) {
  canvas.addEventListener("wheel", (event) => {
    if (!state.bars.length) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const plot = canvas._plot || plotBox(rect.width, rect.height);
    const frac = Math.min(1, Math.max(0, (event.clientX - rect.left - plot.left) / plot.width));
    const count = state.viewEnd - state.viewStart;
    const next = Math.max(20, Math.min(state.bars.length, Math.round(count * (event.deltaY > 0 ? 1.15 : 0.85))));
    const anchor = state.viewStart + frac * count;
    setView(Math.round(anchor - frac * next), Math.round(anchor - frac * next) + next);
    drawAll();
  }, { passive: false });
  let drag = null;
  canvas.addEventListener("mousedown", (event) => {
    drag = { x: event.clientX, start: state.viewStart, end: state.viewEnd };
  });
  window.addEventListener("mouseup", () => { drag = null; });
  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const plot = canvas._plot || plotBox(rect.width, rect.height);
    if (drag) {
      const count = drag.end - drag.start;
      const shift = Math.round((drag.x - event.clientX) * (count / plot.width));
      setView(drag.start + shift, drag.start + shift + count);
      drawAll();
      return;
    }
    const count = state.viewEnd - state.viewStart;
    const frac = (event.clientX - rect.left - plot.left) / plot.width;
    const index = state.viewStart + Math.round(frac * count - 0.5);
    if (index < state.viewStart || index >= state.viewEnd) {
      hideTips();
      return;
    }
    showTip(which, event, index);
  });
  canvas.addEventListener("mouseleave", hideTips);
  canvas.addEventListener("dblclick", () => {
    resetView();
    drawAll();
  });
}

function hideTips() {
  $("priceTip").hidden = true;
  $("equityTip").hidden = true;
}

function placeTip(tip, canvas, index) {
  const plot = canvas._plot;
  if (!plot) return;
  const local = index - state.viewStart;
  const x = xOf(local, plot, plot.count);
  tip.style.left = Math.min(canvas.clientWidth - 168, Math.max(8, x + 12)) + "px";
  tip.style.top = "8px";
}

function showTip(_which, _event, index) {
  const bar = state.bars[index];
  if (!bar) return;
  const priceTip = $("priceTip");
  const equityTip = $("equityTip");
  placeTip(priceTip, $("priceChart"), index);
  priceTip.hidden = false;
  priceTip.innerHTML = `<div>${bar.label}</div><div class="num">开 ${fmt.px(bar.o)}  高 ${fmt.px(bar.h)}</div><div class="num">低 ${fmt.px(bar.l)}  收 ${fmt.px(bar.c)}</div><div class="num">量 ${fmt.vol(bar.v)}</div>`;
  const row = state.result?.equity?.[index];
  if (!row) {
    equityTip.hidden = true;
    return;
  }
  placeTip(equityTip, $("equityChart"), index);
  const cash = state.result.assumptions?.cash || Number($("cash").value);
  equityTip.hidden = false;
  equityTip.innerHTML = `<div>${row.label}</div><div class="num">策略 ${fmt.num(row.equity / cash * 100)} · ${fmt.usd2(row.equity)}</div><div class="num">回撤 ${fmt.pct(row.drawdown)}</div>`;
}

function renderMetrics() {
  const box = $("metrics");
  const result = state.result;
  if (!result) {
    box.innerHTML = `<p class="empty">运行回测后，这里显示收益、回撤和胜率。</p>`;
    return;
  }
  const m = result.metrics;
  const tiles = [
    ["总收益", fmt.pct(m.total_return), m.total_return],
    ["年化", fmt.pct(m.cagr), m.cagr],
    ["最大回撤", fmt.pct(m.max_drawdown), m.max_drawdown],
    ["夏普", fmt.num(m.sharpe), m.sharpe],
    ["胜率", fmt.pct(m.win_rate), null],
    ["盈亏因子", fmt.num(m.profit_factor), null],
    ["交易次数", m.open_trades ? `${m.trades}+${m.open_trades}` : String(m.trades ?? "—"), null],
    ["期末权益", fmt.money(m.ending_equity, currency(), 0), m.total_return],
  ];
  const bench = result.benchmark?.metrics;
  const excess = bench && Number.isFinite(m.total_return) && Number.isFinite(bench.total_return)
    ? m.total_return - bench.total_return
    : null;
  const position = m.ending_position || 0;
  const weight = Number.isFinite(m.ending_weight) ? fmt.pct(m.ending_weight).replace("+", "") : "—";
  const split = result.split;
  const splitText = split
    ? `同一套规则未重新调参：前 70% 到 ${split.split_label} ${fmt.pct(split.in_sample.total_return)}，后 30% ${fmt.pct(split.out_of_sample.total_return)}。`
    : "";
  const excessText = excess == null ? "" : `相对基准 ${fmt.pct(excess)}。`;
  box.innerHTML = tiles
    .map(([label, value, signed]) => `<div class="tile"><span>${label}</span><strong class="num ${signed == null ? "" : tone(signed)}">${value}</strong></div>`)
    .join("") + `<p class="sentence">${bench ? `${result.benchmark.label} ${fmt.pct(bench.total_return)}，回撤 ${fmt.pct(bench.max_drawdown)}。` : ""}${excessText}${splitText}波动 ${fmt.pct(m.volatility)}，索提诺 ${fmt.num(m.sortino)}，卡玛 ${fmt.num(m.calmar)}，持仓 ${fmt.pct(m.exposure)}，均持 ${fmt.num(m.avg_hold_bars, 0)} 根，结束 ${position} 股（${weight}），费用 ${fmt.money(m.fees, currency())}。</p>`;
}

function renderTrades() {
  const trades = state.result?.trades || [];
  if (!trades.length) {
    $("tab-trades").innerHTML = `<p class="empty">这次没有成交。策略可能全程空仓，或样本太短，指标还没热起来。</p>`;
    return;
  }
  const rows = trades.map((trade) => `
    <tr class="clickable" data-entry="${esc(trade.entry_time)}" data-exit="${esc(trade.exit_time || trade.entry_time)}">
      <td class="left">${trade.side === "long" ? "多" : "空"}${trade.open ? " · 未平" : ""}</td>
      <td class="left">${esc(trade.entry_label || "")}</td>
      <td class="num">${fmt.px(trade.entry_price)}</td>
      <td class="left">${esc(trade.exit_label || "—")}</td>
      <td class="num">${fmt.px(trade.exit_price)}</td>
      <td class="num">${trade.qty}</td>
      <td class="num ${tone(trade.pnl)}">${fmt.usd2(trade.pnl)}</td>
      <td class="num ${tone(trade.return_pct)}">${fmt.pct(trade.return_pct)}</td>
      <td class="num">${trade.bars_held ?? "—"}</td>
      <td class="left">${esc(trade.note || "")}</td>
    </tr>`).join("");
  $("tab-trades").innerHTML = `<table><thead><tr><th class="left">方向</th><th class="left">开仓</th><th>开仓价</th><th class="left">平仓</th><th>平仓价</th><th>数量</th><th>盈亏</th><th>收益率</th><th>持有</th><th class="left">备注</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function paramText(params) {
  const values = Object.values(params || {});
  return values.length ? values.join("/") : "";
}

function renderCompare() {
  const board = state.leaderboard;
  let boardHtml = `<p class="empty">点右侧「跑全部策略」，用默认参数在同一费用下横向比较。点一行会按那套参数重跑。</p>`;
  if (board?.rows?.length) {
    const bench = board.benchmark?.metrics;
    boardHtml = `<p class="empty">${board.symbol} · 各策略默认参数 · 同一费用${board.allow_short ? " · 允许做空" : ""} · ${board.elapsed_ms} ms${bench ? ` · ${board.benchmark.label} ${fmt.pct(bench.total_return)}` : ""}。铜色是夏普最高。</p><table><thead><tr><th class="left">策略</th><th>参数</th><th>总收益</th><th>超额</th><th>最大回撤</th><th>夏普</th><th>交易</th><th>持仓占比</th></tr></thead><tbody>${
      board.rows.map((row) => {
        const m = row.metrics;
        if (!m) return `<tr><td class="left">${esc(row.name)}</td><td colspan="7">${esc(row.error || "没有结果")}</td></tr>`;
        const excess = bench && Number.isFinite(m.total_return) ? m.total_return - bench.total_return : null;
        const mark = row.id === board.best_sharpe ? "best" : "";
        const closed = `${m.trades}${m.open_trades ? "+" + m.open_trades : ""}`;
        return `<tr class="clickable ${mark}" data-strategy="${esc(row.id)}" title="${esc(row.warning || "")}"><td class="left">${esc(row.name)}${row.origin === "user" ? " · 自定义" : ""}</td><td class="num">${esc(paramText(row.params))}</td><td class="num ${tone(m.total_return)}">${fmt.pct(m.total_return)}</td><td class="num ${tone(excess)}">${fmt.pct(excess)}</td><td class="num down">${fmt.pct(m.max_drawdown)}</td><td class="num">${fmt.num(m.sharpe)}</td><td class="num" title="已平仓+仍持有">${closed}</td><td class="num">${fmt.pct(m.exposure)}</td></tr>`;
      }).join("")
    }</tbody></table>`;
  }
  const pinHtml = state.pins.length
    ? `<table><thead><tr><th class="left">已叠曲线</th><th>总收益</th><th>最大回撤</th><th>夏普</th><th></th></tr></thead><tbody>${
        state.pins.map((pin) => `<tr><td class="left"><i style="background:${pin.color};display:inline-block;width:8px;height:8px;margin-right:6px"></i>${esc(pin.label)}</td><td class="num ${tone(pin.metrics.total_return)}">${fmt.pct(pin.metrics.total_return)}</td><td class="num down">${fmt.pct(pin.metrics.max_drawdown)}</td><td class="num">${fmt.num(pin.metrics.sharpe)}</td><td><button class="text" data-remove="${esc(pin.id)}" type="button">移除</button></td></tr>`).join("")
      }</tbody></table>`
    : "";
  $("tab-compare").innerHTML = boardHtml + pinHtml;
}

function renderSweep(payload) {
  if (!payload) {
    $("sweepTable").innerHTML = `<p class="empty">选一个参数，给出最小、最大和步长。一次最多 36 组。点一行可以按那组参数重跑。</p>`;
    return;
  }
  const rows = payload.rows.map((row) => {
    const m = row.metrics;
    const mark = row.value === payload.best_sharpe ? "best" : "";
    return `<tr class="clickable ${mark}" data-sweep="${esc(row.value)}"><td class="num">${row.value}</td><td class="num ${tone(m.total_return)}">${fmt.pct(m.total_return)}</td><td class="num ${tone(m.cagr)}">${fmt.pct(m.cagr)}</td><td class="num down">${fmt.pct(m.max_drawdown)}</td><td class="num">${fmt.num(m.sharpe)}</td><td class="num">${fmt.pct(m.win_rate)}</td><td class="num">${m.trades}</td><td class="num">${fmt.usd(m.ending_equity)}</td></tr>`;
  }).join("");
  $("sweepTable").innerHTML = `<table><thead><tr><th>${payload.label}</th><th>总收益</th><th>年化</th><th>最大回撤</th><th>夏普</th><th>胜率</th><th>交易</th><th>期末权益</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function loadBars(autoRun = false) {
  const symbol = $("symbolInput").value.trim().toUpperCase();
  if (!symbol) return;
  state.symbol = symbol;
  $("symbolInput").value = symbol;
  renderWatch();
  showBanner("");
  $("loadBtn").disabled = true;
  try {
    const bars = await Data.loadBars(symbol, state.interval, $("startDate").value, $("endDate").value);
    const quote = await Data.loadQuote(symbol).catch(() => null);
    state.meta = bars;
    state.quote = quote;
    state.bars = bars.bars;
    state.result = null;
    resetView();
    renderQuote();
    renderMetrics();
    renderTrades();
    drawAll();
    saveSettings();
    if (bars.warning) showBanner(bars.warning);
    if (autoRun) await runBacktest();
  } catch (error) {
    showBanner(error.message, "error");
  } finally {
    $("loadBtn").disabled = false;
  }
}

async function runBacktest() {
  if (!state.symbol || !state.meta?.bars) {
    showBanner("先加载行情，再运行回测。");
    return;
  }
  const token = ++state.runToken;
  const opts = assumptions();
  $("runBtn").disabled = true;
  $("runBtn").textContent = "回测中…";
  await new Promise((resolve) => setTimeout(resolve, 0));
  let benchBars = null;
  let benchSymbol = null;
  let benchLabel = null;
  if (opts.benchmark !== "self" && opts.benchmark !== "none") {
    try {
      const benchMeta = await Data.loadBars(opts.benchmark, state.interval, $("startDate").value, $("endDate").value);
      benchBars = benchMeta.bars;
      benchSymbol = benchMeta.symbol;
      benchLabel = `买入持有 ${benchMeta.symbol}`;
    } catch {
      benchBars = null;
    }
  }
  try {
    const result = Bridge.backtest({
      symbol: state.symbol,
      interval: state.interval,
      start: $("startDate").value,
      end: $("endDate").value,
      meta: state.meta,
      strategyId: $("strategySelect").value,
      params: readParams(),
      cash: opts.cash,
      commissionBps: opts.commission_bps,
      slippageBps: opts.slippage_bps,
      allowShort: opts.allow_short,
      benchmark: opts.benchmark,
      benchBars,
      benchSymbol,
      benchLabel,
      stopLossPct: opts.stopLossPct,
      takeProfitPct: opts.takeProfitPct,
      lot: opts.lot,
      tPlusOne: opts.tPlusOne,
    });
    if (token !== state.runToken) return;
    state.result = result;
    if (result.bars?.length) {
      const keepStart = state.viewStart;
      const keepEnd = state.viewEnd;
      const sameLength = result.bars.length === state.bars.length;
      state.bars = result.bars;
      state.meta = { ...state.meta, ...result, bars: result.bars };
      if (!sameLength) resetView();
      else setView(keepStart, keepEnd);
    }
    $("pinBtn").disabled = false;
    renderQuote();
    renderMetrics();
    renderTrades();
    drawAll();
    saveSettings();
    showBanner(result.warning || "");
  } catch (error) {
    showBanner(error.message, "error");
  } finally {
    if (token === state.runToken) {
      $("runBtn").disabled = false;
      $("runBtn").textContent = "运行回测";
    }
  }
}

function pinResult() {
  const result = state.result;
  if (!result) return;
  if (state.pins.length >= 5) {
    showBanner("最多对比 5 条。先在对比页移除一条。");
    return;
  }
  const params = Object.entries(result.strategy.params || {}).map(([key, value]) => value).join("/");
  state.pins.push({
    id: crypto.randomUUID(),
    label: `${result.symbol} · ${result.strategy.name}${params ? " " + params : ""}`,
    color: PIN_COLORS[state.pins.length % PIN_COLORS.length],
    cash: result.assumptions.cash,
    points: result.equity.map((row) => ({ t: row.t, equity: row.equity })),
    metrics: result.metrics,
  });
  renderCompare();
  drawEquity();
}

async function runSweep() {
  if (!state.meta?.bars) {
    showBanner("先加载行情，再扫描参数。");
    return;
  }
  const opts = assumptions();
  const mode = $("sweepMode").value;
  $("sweepBtn").disabled = true;
  $("sweepBtn").textContent = "扫描中…";
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    if (mode === "2") {
      const payload = Bridge.heatmap({
        symbol: state.symbol,
        interval: state.interval,
        meta: state.meta,
        strategyId: $("strategySelect").value,
        params: readParams(),
        cash: opts.cash,
        commissionBps: opts.commission_bps,
        slippageBps: opts.slippage_bps,
        allowShort: opts.allow_short,
        xKey: $("sweepParam").value,
        yKey: $("sweepParam2").value,
        xMin: Number($("sweepMin").value),
        xMax: Number($("sweepMax").value),
        xStep: Number($("sweepStep").value),
        yMin: Number($("sweepMin2").value),
        yMax: Number($("sweepMax2").value),
        yStep: Number($("sweepStep2").value),
      });
      state.heatmap = payload;
      renderHeatmap(payload);
      showBanner(`二维扫描完成，${payload.xValues.length}×${payload.yValues.length} = ${payload.cells.length} 组。夏普最好的一组在 ${payload.best.x} / ${payload.best.y}。`);
      return;
    }
    const payload = Bridge.sweep({
      symbol: state.symbol,
      interval: state.interval,
      start: $("startDate").value,
      end: $("endDate").value,
      meta: state.meta,
      strategyId: $("strategySelect").value,
      params: readParams(),
      cash: opts.cash,
      commissionBps: opts.commission_bps,
      slippageBps: opts.slippage_bps,
      allowShort: opts.allow_short,
      sweepKey: $("sweepParam").value,
      min: Number($("sweepMin").value),
      max: Number($("sweepMax").value),
      step: Number($("sweepStep").value),
    });
    state.sweep = payload;
    renderSweep(payload);
    showBanner(payload.warning || `扫描完成。夏普最好的是 ${payload.best_sharpe}，收益最好的是 ${payload.best_return}。`);
  } catch (error) {
    showBanner(error.message, "error");
  } finally {
    $("sweepBtn").disabled = false;
    $("sweepBtn").textContent = "扫描";
  }
}

function heatColor(value, min, max) {
  if (!Number.isFinite(value)) return "transparent";
  const span = Math.max(Math.abs(max), Math.abs(min), 1e-9);
  const norm = Math.min(1, Math.abs(value) / span);
  const alpha = 0.12 + 0.5 * norm;
  return value >= 0 ? `rgba(60, 186, 132, ${alpha.toFixed(3)})` : `rgba(225, 93, 104, ${alpha.toFixed(3)})`;
}

function renderHeatmap(payload) {
  if (!payload) {
    $("sweepTable").innerHTML = "";
    return;
  }
  const metric = $("sweepMetric").value;
  const values = payload.cells.map((cell) => cell[metric]).filter((value) => Number.isFinite(value));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const show = (value) => (metric === "total_return" ? fmt.pct(value) : metric === "max_drawdown" ? fmt.pct(value) : fmt.num(value));
  const head = `<tr><th class="left">${payload.yLabel} \\ ${payload.xLabel}</th>${payload.xValues.map((x) => `<th class="num">${x}</th>`).join("")}</tr>`;
  const body = payload.yValues
    .map((y) => {
      const cells = payload.xValues
        .map((x) => {
          const cell = payload.cells.find((item) => item.x === x && item.y === y);
          if (!cell) return `<td></td>`;
          const best = payload.best && cell.x === payload.best.x && cell.y === payload.best.y;
          return `<td class="num heat" data-x="${cell.x}" data-y="${cell.y}" style="background:${heatColor(cell[metric], min, max)}">${show(cell[metric])}${best ? " ●" : ""}</td>`;
        })
        .join("");
      return `<tr><th class="num left">${y}</th>${cells}</tr>`;
    })
    .join("");
  $("sweepTable").innerHTML = `<p class="empty">点格子会把这组参数填回表单并重跑。● 是夏普最好的一组。</p><table class="heatmap"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function showTab(name) {
  document.querySelectorAll(".blotter-tabs [data-tab]").forEach((item) => item.classList.toggle("on", item.dataset.tab === name));
  ["trades", "compare", "sweep", "robust"].forEach((tab) => {
    $("tab-" + tab).hidden = tab !== name;
  });
}

async function compareAll() {
  if (!state.meta?.bars) {
    showBanner("先加载行情，再比较策略。");
    return;
  }
  const opts = assumptions();
  $("compareAllBtn").disabled = true;
  $("compareAllBtn").textContent = "比较中…";
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const data = Bridge.compare({
      symbol: state.symbol,
      interval: state.interval,
      start: $("startDate").value,
      end: $("endDate").value,
      meta: state.meta,
      cash: opts.cash,
      commissionBps: opts.commission_bps,
      slippageBps: opts.slippage_bps,
      allowShort: opts.allow_short,
      benchmark: opts.benchmark,
    });
    state.leaderboard = data;
    renderCompare();
    showTab("compare");
    showBanner(data.warning || `全部策略比较完成，用时 ${data.elapsed_ms} ms。夏普最高的一行标成铜色。`);
  } catch (error) {
    showBanner(error.message, "error");
  } finally {
    $("compareAllBtn").disabled = false;
    $("compareAllBtn").textContent = "跑全部策略";
  }
}

async function runRobust() {
  if (!state.meta?.bars) {
    showBanner("先加载一只标的，再跑股票池。");
    return;
  }
  const opts = assumptions();
  const scope = $("robustScope").value;
  let pool = [];
  if (state.market === "cn") {
    pool = Data.CN_WATCH.map(([symbol]) => symbol);
  } else {
    try {
      const index = await Data.loadStockIndex();
      pool = (index.symbols || [])
        .filter((item) => scope === "all" || (scope === "etfs" ? item.type === "ETF" : item.type !== "ETF"))
        .map((item) => item.symbol);
    } catch (error) {
      showBanner("股票池清单加载失败：" + error.message, "error");
      return;
    }
  }
  if (scope !== "all" && state.market === "cn") {
    // A 股清单不分股票和 ETF，筛选交给逐只判断，这里全跑。
    pool = Data.CN_WATCH.map(([symbol]) => symbol);
  }
  $("robustBtn").disabled = true;
  $("robustTable").innerHTML = "";
  $("robustSummary").innerHTML = `<p class="empty">正在跑 ${pool.length} 只…</p>`;
  try {
    const result = await Bridge.batch({
      symbols: pool,
      interval: state.interval,
      start: $("startDate").value,
      end: $("endDate").value,
      strategyId: $("strategySelect").value,
      params: readParams(),
      cash: opts.cash,
      commissionBps: opts.commission_bps,
      slippageBps: opts.slippage_bps,
      allowShort: opts.allow_short,
      onProgress: (done, total) => {
        $("robustSummary").innerHTML = `<p class="empty">已跑 ${done} / ${total}…</p>`;
      },
    });
    state.robust = result;
    renderRobust(result);
    showBanner(`跑完 ${result.summary.ok} 只，${result.summary.positive} 只正收益。`);
  } catch (error) {
    showBanner(error.message, "error");
    $("robustSummary").innerHTML = "";
  } finally {
    $("robustBtn").disabled = false;
  }
}

function renderRobust(result) {
  if (!result) {
    $("robustSummary").innerHTML = "";
    $("robustTable").innerHTML = "";
    return;
  }
  const s = result.summary;
  const tile = (label, value, cls = "") => `<div><span>${label}</span><strong class="num ${cls}">${value}</strong></div>`;
  $("robustSummary").innerHTML = `
    <div class="paper-summary" style="margin:8px 0">
      ${tile("样本", `${s.ok}/${s.total}`)}
      ${tile("正收益", `${s.positive}（${fmt.pct(s.positive_rate).replace("+", "")}）`, tone(s.positive_rate - 0.5))}
      ${tile("收益中位数", fmt.pct(s.median_return), tone(s.median_return))}
      ${tile("跑赢持有", `${s.beat_hold}（${fmt.pct(s.beat_hold_rate).replace("+", "")}）`, tone(s.beat_hold_rate - 0.5))}
      ${tile("超额中位数", fmt.pct(s.median_excess), tone(s.median_excess))}
      ${tile("夏普中位数", fmt.num(s.median_sharpe))}
    </div>`;
  const rows = result.rows.map((row) => {
    if (!row.ok) return `<tr><td class="left">${esc(row.symbol)}</td><td colspan="6">${esc(row.error || "失败")}</td></tr>`;
    return `<tr class="clickable" data-symbol="${esc(row.symbol)}">
      <td class="left">${row.symbol}</td>
      <td class="left">${esc(row.name || "")}</td>
      <td class="num ${tone(row.total_return)}">${fmt.pct(row.total_return)}</td>
      <td class="num ${tone(row.excess)}">${fmt.pct(row.excess)}</td>
      <td class="num down">${fmt.pct(row.max_drawdown)}</td>
      <td class="num">${fmt.num(row.sharpe)}</td>
      <td class="num">${row.trades}</td>
    </tr>`;
  }).join("");
  $("robustTable").innerHTML = `<p class="empty">点一行可以切到那只标的。</p><table><thead><tr><th class="left">代码</th><th class="left">名称</th><th>收益</th><th>超额</th><th>最大回撤</th><th>夏普</th><th>成交</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function refreshPaper() {
  try {
    const account = await Paper.snapshot();
    renderPaper(account);
  } catch (error) {
    showBanner(error.message, "error");
  }
}

function paperMoney(value) {
  const accountCurrency = state.meta?.currency || state.quote?.currency || (state.market === "cn" ? "CNY" : "USD");
  return fmt.money(value, accountCurrency);
}

function renderPaper(account) {
  $("paperSummary").innerHTML = `
    <div><span>现金</span><strong class="num">${paperMoney(account.cash)}</strong></div>
    <div><span>总权益</span><strong class="num ${tone(account.pnl)}">${paperMoney(account.equity)}</strong></div>
    <div><span>总盈亏</span><strong class="num ${tone(account.pnl)}">${paperMoney(account.pnl)}</strong></div>
    <div><span>浮动盈亏</span><strong class="num ${tone(account.unrealized)}">${paperMoney(account.unrealized)}</strong></div>`;
  $("paperPositions").innerHTML = account.positions.length
    ? `<table><thead><tr><th class="left">代码</th><th>数量</th><th>成本</th><th>现价</th><th>浮动</th></tr></thead><tbody>${account.positions.map((pos) => `<tr><td class="left">${esc(pos.symbol)}</td><td class="num">${pos.qty}</td><td class="num">${fmt.px(pos.avg_price)}</td><td class="num">${fmt.px(pos.last)}</td><td class="num ${tone(pos.unrealized)}">${paperMoney(pos.unrealized)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="empty">还没有持仓。</p>`;
  $("paperOrders").innerHTML = account.orders.length
    ? `<table><thead><tr><th class="left">时间</th><th class="left">代码</th><th>方向</th><th>数量</th><th>成交价</th></tr></thead><tbody>${account.orders.map((order) => `<tr><td class="left">${esc(order.time)}</td><td class="left">${esc(order.symbol)}</td><td>${order.side === "buy" ? "买" : "卖"}</td><td class="num">${order.qty}</td><td class="num">${fmt.px(order.price)}</td></tr>`).join("")}</tbody></table>`
    : "";
  if (account.warning) showBanner(account.warning);
}

async function paperOrder(side) {
  try {
    const account = await Paper.order(
      state.symbol,
      side,
      Number($("paperQty").value),
      Number($("commission").value),
      Number($("slippage").value),
    );
    renderPaper(account);
    showBanner("");
  } catch (error) {
    showBanner(error.message, "error");
  }
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportTrades() {
  const trades = state.result?.trades || [];
  if (!trades.length) return showBanner("还没有成交可以下载。");
  const header = "side,entry,entry_price,exit,exit_price,qty,pnl,return,bars,note";
  const lines = trades.map((trade) => [trade.side, trade.entry_label, trade.entry_price, trade.exit_label || "", trade.exit_price, trade.qty, trade.pnl, trade.return_pct, trade.bars_held, trade.note || ""].join(","));
  download(`${state.symbol}-trades.csv`, [header, ...lines].join("\n"));
}

function exportMetrics() {
  if (!state.result) return showBanner("还没有绩效可以下载。");
  download(`${state.symbol}-metrics.json`, JSON.stringify({ metrics: state.result.metrics, benchmark: state.result.benchmark, strategy: state.result.strategy }, null, 2));
}

function focusTrade(entry, exit) {
  const i0 = indexOfTime(Number(entry));
  const i1 = indexOfTime(Number(exit));
  if (i0 < 0) return;
  const lo = Math.min(i0, i1 < 0 ? i0 : i1);
  const hi = Math.max(i0, i1 < 0 ? i0 : i1);
  setView(lo - 20, hi + 21);
  drawAll();
}

async function searchSymbols() {
  const q = $("symbolInput").value.trim();
  if (!q) return;
  if (/^[A-Za-z0-9.^-]{1,12}$/.test(q) && !q.includes(" ")) {
    await loadBars(false);
    $("searchResults").hidden = true;
    return;
  }
  try {
    const results = await Data.searchSymbols(q, state.market);
    const box = $("searchResults");
    if (!results.length) {
      box.hidden = false;
      box.innerHTML = `<button type="button" disabled>没有找到股票或 ETF</button>`;
      return;
    }
    box.hidden = false;
    box.innerHTML = results
      .map((item) => `<button type="button" data-symbol="${esc(item.symbol)}"><b>${esc(item.symbol)}</b> ${esc(item.name)} · ${esc(item.type)}</button>`)
      .join("");
  } catch (error) {
    showBanner(error.message, "error");
  }
}

function bind() {
  $("searchBtn").onclick = searchSymbols;
  $("symbolInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchSymbols();
  });
  $("searchResults").onclick = async (event) => {
    const button = event.target.closest("[data-symbol]");
    if (!button) return;
    $("symbolInput").value = button.dataset.symbol;
    $("searchResults").hidden = true;
    await loadBars(false);
  };
  $("watchlist").onclick = async (event) => {
    const button = event.target.closest("[data-symbol]");
    if (!button) return;
    $("symbolInput").value = button.dataset.symbol;
    await loadBars(false);
  };
  $("markets").onclick = async (event) => {
    const button = event.target.closest("[data-market]");
    if (!button || button.dataset.market === state.market) return;
    state.market = button.dataset.market;
    const bench = $("benchmark").value;
    if (state.market === "cn" && (bench === "SPY" || bench === "QQQ")) $("benchmark").value = "510300.SH";
    if (state.market === "us" && bench === "510300.SH") $("benchmark").value = "SPY";
    const first = (WATCH[state.market] || [])[0];
    if (first) $("symbolInput").value = first;
    if (state.market === "cn") {
      $("lotSize").value = 100;
      $("tPlusOne").checked = true;
      $("dataHint").textContent = "A 股：前复权日K，整手 100 股，T+1。分钟线只有最近一段。";
    } else {
      $("lotSize").value = 1;
      $("tPlusOne").checked = false;
      $("dataHint").textContent = "美股是每日更新的复权快照，按 1 股成交。";
    }
    renderWatch();
    await loadBars(false);
  };
  $("intervals").onclick = async (event) => {
    const button = event.target.closest("[data-interval]");
    if (!button) return;
    state.interval = button.dataset.interval;
    [...$("intervals").children].forEach((item) => item.classList.toggle("on", item === button));
    await loadBars(false);
  };
  $("ranges").onclick = async (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    [...$("ranges").children].forEach((item) => item.classList.toggle("on", item === button));
    const end = $("endDate").value ? new Date($("endDate").value + "T00:00:00") : new Date();
    $("startDate").value = isoDate(shiftYears(end, Number(button.dataset.range)));
    await loadBars(false);
  };
  $("zooms").onclick = (event) => {
    const button = event.target.closest("[data-zoom]");
    if (!button || !state.bars.length) return;
    if (button.dataset.zoom === "all") setView(0, state.bars.length);
    else setView(state.bars.length - Number(button.dataset.zoom), state.bars.length);
    drawAll();
  };
  $("loadBtn").onclick = () => loadBars(false);
  $("runBtn").onclick = runBacktest;
  $("pinBtn").onclick = pinResult;
  $("strategySelect").onchange = () => {
    renderStrategyForm();
    saveSettings();
  };
  $("modeTabs").onclick = (event) => {
    const button = event.target.closest("[data-mode]");
    if (!button) return;
    [...$("modeTabs").children].forEach((item) => item.classList.toggle("on", item === button));
    const paper = button.dataset.mode === "paper";
    $("backtestPane").hidden = paper;
    $("paperPane").hidden = !paper;
    if (paper) refreshPaper();
  };
  document.querySelector(".blotter-tabs").onclick = (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    document.querySelectorAll(".blotter-tabs [data-tab]").forEach((item) => item.classList.toggle("on", item === button));
    ["trades", "compare", "sweep", "robust"].forEach((name) => {
      $("tab-" + name).hidden = name !== button.dataset.tab;
    });
  };
  $("tab-trades").onclick = (event) => {
    const row = event.target.closest("tr[data-entry]");
    if (row) focusTrade(row.dataset.entry, row.dataset.exit);
  };
  $("tab-compare").onclick = async (event) => {
    const button = event.target.closest("[data-remove]");
    if (button) {
      state.pins = state.pins.filter((pin) => pin.id !== button.dataset.remove);
      renderCompare();
      drawEquity();
      return;
    }
    const row = event.target.closest("tr[data-strategy]");
    if (!row) return;
    $("strategySelect").value = row.dataset.strategy;
    state.savedParams = null;
    renderStrategyForm();
    await runBacktest();
  };
  $("compareAllBtn").onclick = compareAll;
  $("sweepBtn").onclick = runSweep;
  $("sweepParam").onchange = () => {
    const spec = (currentStrategy()?.params || []).find((item) => item.key === $("sweepParam").value);
    if (!spec) return;
    $("sweepMin").value = spec.min ?? spec.default;
    $("sweepMax").value = spec.max ?? spec.default;
    $("sweepStep").value = spec.step || 1;
  };
  $("robustBtn").onclick = runRobust;
  $("robustTable").onclick = async (event) => {
    const row = event.target.closest("tr[data-symbol]");
    if (!row) return;
    $("symbolInput").value = row.dataset.symbol;
    await loadBars(false);
    showTab("robust");
  };
  $("sweepMode").onchange = applySweepMode;
  $("sweepParam2").onchange = () => {
    const spec = (currentStrategy()?.params || []).find((item) => item.key === $("sweepParam2").value);
    if (!spec) return;
    $("sweepMin2").value = spec.min ?? spec.default;
    $("sweepMax2").value = spec.max ?? spec.default;
    $("sweepStep2").value = (spec.step || 1) * 5;
  };
  $("sweepTable").onclick = async (event) => {
    const cell = event.target.closest("td[data-x]");
    if (cell && state.heatmap) {
      const setValue = (key, value) => {
        const input = $("paramForm").querySelector(`[data-key="${key}"]`);
        if (input) input.value = value;
      };
      setValue(state.heatmap.xKey, cell.dataset.x);
      setValue(state.heatmap.yKey, cell.dataset.y);
      await runBacktest();
      return;
    }
    const row = event.target.closest("tr[data-sweep]");
    if (!row) return;
    const input = $("paramForm").querySelector(`[data-key="${$("sweepParam").value}"]`);
    if (input) input.value = row.dataset.sweep;
    await runBacktest();
  };
  $("paperBuy").onclick = () => paperOrder("buy");
  $("paperSell").onclick = () => paperOrder("sell");
  $("paperReset").onclick = async () => {
    if (!window.confirm("清空模拟持仓，现金恢复为右侧的初始资金？")) return;
    try {
      const account = Paper.reset(Number($("cash").value));
      renderPaper(account);
      showBanner("");
    } catch (error) {
      showBanner(error.message, "error");
    }
  };
  $("exportTrades").onclick = exportTrades;
  $("exportMetrics").onclick = exportMetrics;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) runBacktest();
  });
  bindChart($("priceChart"), "price");
  bindChart($("equityChart"), "equity");
  new ResizeObserver(() => drawAll()).observe($("priceChart").parentElement);
  new ResizeObserver(() => drawAll()).observe($("equityChart").parentElement);
}

async function init() {
  const saved = loadSettings();
  const today = new Date();
  $("endDate").value = saved?.end || isoDate(today);
  $("startDate").value = saved?.start || isoDate(shiftYears(today, 3));
  if (saved?.cash) $("cash").value = saved.cash;
  if (saved?.commission_bps != null) $("commission").value = saved.commission_bps;
  if (saved?.slippage_bps != null) $("slippage").value = saved.slippage_bps;
  if (saved?.allow_short) $("allowShort").checked = true;
  if (saved?.stopLossPct != null) $("stopLoss").value = saved.stopLossPct;
  if (saved?.takeProfitPct != null) $("takeProfit").value = saved.takeProfitPct;
  if (saved?.lot) $("lotSize").value = saved.lot;
  if (saved?.tPlusOne) $("tPlusOne").checked = true;
  if (saved?.benchmark) $("benchmark").value = saved.benchmark;
  state.market = saved?.market === "cn" ? "cn" : "us";
  state.symbol = (saved?.symbol || (state.market === "cn" ? "600519.SH" : "NVDA")).toUpperCase();
  state.interval = saved?.interval || "1d";
  $("symbolInput").value = state.symbol;
  [...$("intervals").children].forEach((item) => item.classList.toggle("on", item.dataset.interval === state.interval));
  renderWatch();
  renderSweep(null);
  renderCompare();
  bind();
  try {
    const data = { strategies: Engine.strategyCatalog(), warnings: [] };
    state.strategies = data.strategies;
    $("strategySelect").innerHTML = data.strategies
      .map((item) => `<option value="${esc(item.id)}">${esc(item.name)}${item.origin === "user" ? " · 自定义" : ""}</option>`)
      .join("");
    if (saved?.strategy) $("strategySelect").value = saved.strategy;
    state.savedParams = saved?.params || null;
    renderStrategyForm();
  } catch (error) {
    showBanner(error.message, "error");
  }
  await loadBars(true);
}

init();
