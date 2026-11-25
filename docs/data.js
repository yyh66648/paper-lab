/* 行情层。A 股直连腾讯（接口允许跨域），美股读 GitHub Actions 预抓的静态文件。 */

const CN_WATCH = [
  ["600519.SH", "贵州茅台", "股票"], ["000001.SZ", "平安银行", "股票"], ["300750.SZ", "宁德时代", "股票"],
  ["601318.SH", "中国平安", "股票"], ["000858.SZ", "五粮液", "股票"], ["002594.SZ", "比亚迪", "股票"],
  ["600036.SH", "招商银行", "股票"], ["601899.SH", "紫金矿业", "股票"], ["600900.SH", "长江电力", "股票"],
  ["000333.SZ", "美的集团", "股票"], ["002415.SZ", "海康威视", "股票"], ["600276.SH", "恒瑞医药", "股票"],
  ["601012.SH", "隆基绿能", "股票"], ["600030.SH", "中信证券", "股票"], ["000651.SZ", "格力电器", "股票"],
  ["002475.SZ", "立讯精密", "股票"], ["300059.SZ", "东方财富", "股票"], ["688981.SH", "中芯国际", "股票"],
  ["601888.SH", "中国中免", "股票"], ["600887.SH", "伊利股份", "股票"], ["002230.SZ", "科大讯飞", "股票"],
  ["300308.SZ", "中际旭创", "股票"],
  ["510300.SH", "沪深300ETF", "基金"], ["510050.SH", "上证50ETF", "基金"], ["510500.SH", "中证500ETF", "基金"],
  ["159915.SZ", "创业板ETF", "基金"], ["588000.SH", "科创50ETF", "基金"], ["512480.SH", "半导体ETF", "基金"],
  ["512880.SH", "证券ETF", "基金"], ["512690.SH", "酒ETF", "基金"], ["515050.SH", "5G通信ETF", "基金"],
  ["000300.SH", "沪深300", "指数"], ["000001.SH", "上证指数", "指数"], ["399001.SZ", "深证成指", "指数"],
  ["399006.SZ", "创业板指", "指数"],
];

const INDEX_ON_SH = new Set(["000300", "000688"]);

function isCnSymbol(symbol) {
  const text = String(symbol || "").trim().toUpperCase();
  if (/\.(SH|SZ|BJ)$/.test(text) && /^\d{6}\./.test(text)) return true;
  if (/^(SH|SZ|BJ)\d{6}$/.test(text)) return true;
  const compact = text.replace(/\./g, "");
  return /^\d{6}$/.test(compact);
}

function canonicalCn(symbol) {
  let text = String(symbol || "").trim().toUpperCase().replace(/\s+/g, "");
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(text)) return text;
  if (/^(SH|SZ|BJ)\d{6}$/.test(text)) return `${text.slice(2)}.${text.slice(0, 2)}`;
  const digits = text.replace(/\./g, "");
  if (!/^\d{6}$/.test(digits)) throw new Error("A 股代码应是 6 位数字，例如 600519，或带后缀 600519.SH。");
  let suffix;
  if (INDEX_ON_SH.has(digits) || digits.startsWith("399")) suffix = digits.startsWith("399") ? "SZ" : "SH";
  else if (/^[659]/.test(digits)) suffix = "SH";
  else if (/^[48]/.test(digits)) suffix = "BJ";
  else suffix = "SZ";
  return `${digits}.${suffix}`;
}

function tencentCode(symbol) {
  const [code, suffix] = canonicalCn(symbol).split(".");
  return { SH: "sh", SZ: "sz", BJ: "bj" }[suffix] + code;
}

function exchangeName(suffix) {
  return { SH: "上交所", SZ: "深交所", BJ: "北交所" }[suffix] || suffix;
}

function shTick(text, interval) {
  if (interval === "1d" || interval === "1wk") {
    const iso = text.slice(0, 10);
    return { t: Date.parse(`${iso}T15:00:00+08:00`) / 1000, label: iso };
  }
  const y = text.slice(0, 4), m = text.slice(4, 6), d = text.slice(6, 8);
  const hh = text.slice(8, 10), mm = text.slice(10, 12);
  return { t: Date.parse(`${y}-${m}-${d}T${hh}:${mm}:00+08:00`) / 1000, label: `${y}-${m}-${d} ${hh}:${mm}` };
}

function cnBar(row, interval) {
  if (!row || row.length < 6) return null;
  const stamp = shTick(String(row[0]), interval);
  const o = Number(row[1]), c = Number(row[2]), h = Number(row[3]), l = Number(row[4]), v = Number(row[5] || 0);
  if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) return null;
  return { t: stamp.t, label: stamp.label, o, h, l, c, v };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`行情请求失败（${response.status}）`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`行情请求失败（${response.status}）`);
  const buffer = await response.arrayBuffer();
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

async function cnQuote(symbol) {
  const display = canonicalCn(symbol);
  const text = await fetchText(`https://qt.gtimg.cn/q=${tencentCode(display)}`);
  if (!text.includes("~")) throw new Error("没有这只 A 股的现价。");
  const parts = text.split("~");
  if (parts.length < 33) throw new Error("现价返回不完整。");
  const price = Number(parts[3]);
  const prev = Number(parts[4]);
  return {
    symbol: display,
    name: parts[1] || display,
    exchange: exchangeName(display.split(".")[1]),
    currency: "CNY",
    price,
    previous_close: prev,
    change: Number.isFinite(price) && Number.isFinite(prev) ? price - prev : null,
    change_pct: Number(parts[32]) / 100,
    market_time: parts[30],
    source: "腾讯行情",
  };
}

function cnNeededCount(interval, days) {
  if (interval === "1wk") return Math.min(1200, Math.max(30, Math.trunc(days / 5) + 8));
  if (interval === "1d") return Math.min(2500, Math.max(40, Math.trunc(days * 0.75) + 10));
  if (interval === "1h") return 800;
  return 480;
}

async function cnBars(symbol, interval, start, end) {
  const display = canonicalCn(symbol);
  const code = tencentCode(display);
  const days = Math.max(1, (Date.parse(end) - Date.parse(start)) / 86400000 + 5);
  const count = cnNeededCount(interval, days);
  let url;
  let keys;
  if (interval === "1d" || interval === "1wk") {
    const period = interval === "1d" ? "day" : "week";
    url = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${count},qfq`;
    keys = ["qfqday", "day", "qfqweek", "week"];
  } else {
    const period = { "1h": "m60", "15m": "m15", "5m": "m5" }[interval];
    url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},${period},,${count}`;
    keys = [period];
  }
  const payload = await fetchJson(url);
  const node = (payload.data || {})[code] || {};
  const rows = keys.map((key) => node[key]).find((value) => Array.isArray(value) && value.length) || [];
  if (!rows.length) throw new Error("这个 A 股代码没有返回 K 线。");
  let bars = rows.map((row) => cnBar(row, interval)).filter(Boolean);
  bars.sort((a, b) => a.t - b.t);
  const startKey = start.slice(0, 10);
  const endKey = end.slice(0, 10);
  const filtered = bars.filter((bar) => {
    if (interval === "1d" || interval === "1wk") {
      const key = bar.label.slice(0, 10);
      return key >= startKey && key <= endKey;
    }
    return bar.t >= Date.parse(`${startKey}T00:00:00+08:00`) / 1000 && bar.t <= Date.parse(`${endKey}T23:59:59+08:00`) / 1000;
  });
  if (filtered.length < 2) throw new Error("这个区间的 K 线不足 2 根，换一个更长的区间。");
  const adjusted = keys.some((key) => key.startsWith("qfq") && node[key]);
  const warnings = [];
  if (bars.length && bars[0].label.slice(0, 10) > startKey) warnings.push("行情源没有更早的数据，已使用能拿到的区间。");
  if (["1h", "15m", "5m"].includes(interval)) warnings.push("A 股分钟线只有最近一段。");
  let name = display;
  try { name = (await cnQuote(display)).name; } catch { /* 名称拿不到就用代码 */ }
  return {
    symbol: display,
    name,
    exchange: exchangeName(display.split(".")[1]),
    currency: "CNY",
    timezone: "Asia/Shanghai",
    source: "腾讯行情",
    adjusted,
    warning: warnings.join(" ") || null,
    bars: filtered,
    count: filtered.length,
    start: filtered[0].label,
    end: filtered[filtered.length - 1].label,
  };
}

let staticIndex = null;

async function loadStaticIndex() {
  if (staticIndex) return staticIndex;
  try {
    staticIndex = await fetchJson("data/index.json");
  } catch {
    staticIndex = { symbols: [] };
  }
  return staticIndex;
}

async function staticBars(symbol, interval, start, end) {
  const upper = String(symbol || "").trim().toUpperCase();
  const index = await loadStaticIndex();
  const entry = (index.symbols || []).find((item) => item.symbol === upper);
  const useInterval = interval === "1wk" ? "1wk" : "1d";
  let payload;
  try {
    payload = await fetchJson(`data/${encodeURIComponent(upper)}_${useInterval}.json`);
  } catch {
    if (useInterval === "1wk") payload = await fetchJson(`data/${encodeURIComponent(upper)}_1d.json`);
    else if (entry) throw new Error(`${upper} 没有 ${interval} 数据。美股只提供日线和周线。`);
    else throw new Error(`没有收录 ${upper}。美股目前是预抓的固定清单，A 股可以输入任意代码。`);
  }
  const bars = (payload.bars || []).filter((bar) => {
    const key = bar.label.slice(0, 10);
    return key >= start.slice(0, 10) && key <= end.slice(0, 10);
  });
  if (bars.length < 2) throw new Error("这个区间的 K 线不足 2 根。换一个更长的区间。");
  const warnings = [];
  if (interval !== useInterval && interval !== "1d") warnings.push("美股只预抓了日线和周线，已改用日线。");
  return {
    symbol: payload.symbol || upper,
    name: payload.name || upper,
    exchange: payload.exchange || "",
    currency: payload.currency || "USD",
    timezone: "America/New_York",
    source: payload.source || "预抓数据",
    adjusted: payload.adjusted !== false,
    warning: warnings.join(" ") || payload.warning || null,
    bars,
    count: bars.length,
    start: bars[0].label,
    end: bars[bars.length - 1].label,
  };
}

async function loadBars(symbol, interval, start, end) {
  if (isCnSymbol(symbol)) return cnBars(symbol, interval, start, end);
  return staticBars(symbol, interval, start, end);
}

async function loadQuote(symbol) {
  if (isCnSymbol(symbol)) return cnQuote(symbol);
  const upper = String(symbol || "").trim().toUpperCase();
  const index = await loadStaticIndex();
  const entry = (index.symbols || []).find((item) => item.symbol === upper);
  if (!entry) return null;
  return {
    symbol: entry.symbol,
    name: entry.name,
    exchange: entry.exchange,
    currency: entry.currency || "USD",
    price: entry.price ?? null,
    previous_close: null,
    change: entry.change ?? null,
    change_pct: entry.change_pct ?? null,
    market_time: entry.updated || null,
    source: entry.source || "预抓数据",
  };
}

async function searchSymbols(query, market) {
  const text = String(query || "").trim().toUpperCase();
  if (!text) return [];
  const results = [];
  if (market === "cn" || /[\u4e00-\u9fff]/.test(query) || isCnSymbol(text)) {
    const upper = text;
    for (const [symbol, name, type] of CN_WATCH) {
      if (symbol.includes(upper) || name.includes(query.trim()) || name.toUpperCase().includes(upper)) {
        results.push({ symbol, name, exchange: exchangeName(symbol.split(".")[1]), type, market: "cn" });
      }
    }
    if (/^\d{6}$/.test(upper) && results.length === 0) {
      const fixed = canonicalCn(upper);
      results.push({ symbol: fixed, name: upper, exchange: exchangeName(fixed.split(".")[1]), type: "A股", market: "cn" });
    }
  }
  if (market !== "cn") {
    const index = await loadStaticIndex();
    for (const item of index.symbols || []) {
      if (results.length >= 8) break;
      if (item.symbol.includes(text) || String(item.name || "").toUpperCase().includes(text)) {
        results.push({
          symbol: item.symbol,
          name: item.name,
          exchange: item.exchange || "",
          type: item.type || "股票",
          market: "us",
        });
      }
    }
  }
  return results.slice(0, 8);
}

const Data = {
  loadBars, loadQuote, searchSymbols, isCnSymbol, canonicalCn, CN_WATCH,
  loadStockIndex: loadStaticIndex,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { isCnSymbol, canonicalCn, tencentCode, CN_WATCH };
}
