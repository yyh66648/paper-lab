/* 验证线上静态站资源与 A 股直连。 */
const base = "https://yyh66648.github.io/paper-lab/";

(async () => {
  for (const p of ["engine.js", "data.js", "bridge.js", "app.js", "style.css", "data/index.json", "data/NVDA_1d.json"]) {
    const r = await fetch(base + p);
    console.log(p.padEnd(20), r.status, r.headers.get("content-length") || "?");
  }
  const idx = await (await fetch(base + "data/index.json")).json();
  console.log("index symbols", idx.symbols.length, "updated", idx.updated);

  const tx = await fetch("https://qt.gtimg.cn/q=sh600519");
  const buf = await tx.arrayBuffer();
  let text;
  try {
    text = new TextDecoder("gbk").decode(buf);
  } catch (e) {
    text = "";
    console.log("GBK 解码不可用:", e.message);
  }
  const parts = text.split("~");
  console.log("A股报价", tx.status, "字段", parts.length, "价格", parts[3], "名称字节长度", (parts[1] || "").length);

  const k = await (await fetch("https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,300,qfq")).json();
  const node = k.data.sh600519 || {};
  const rows = node.qfqday || node.day || [];
  const last = rows.length ? rows[rows.length - 1] : null;
  console.log("A股日线", rows.length, last ? last.slice(0, 3).join(" ") : "");
})();
