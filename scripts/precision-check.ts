#!/usr/bin/env bun
/**
 * 生产结果 vs 双盲共识：给出可引用的"精度代理"（不是真值，是两次独立标注的一致值）。
 * 同时把双盲结果整理成标注集（共识值 + 分歧待定），供人工只处理分歧。
 */
import fs from "node:fs";
import path from "node:path";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const labelCsv = arg("label", "./out-label/标注集_双盲.csv")!;
const longCsv = arg("long", "./out-final/属性明细_长表.csv")!;
const outDir = arg("out", "./out-label")!;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const label = parseCsv(fs.readFileSync(labelCsv, "utf8").replace(/^\uFEFF/, ""));
const lh = label[0]!;
const li = (n: string) => lh.indexOf(n);
const prod = parseCsv(fs.readFileSync(longCsv, "utf8").replace(/^\uFEFF/, ""));
const ph = prod[0]!;
const pi = (n: string) => ph.indexOf(n);

// (row,attr) -> 生产值
const prodMap = new Map<string, string>();
for (const r of prod.slice(1)) prodMap.set(`${r[pi("原表行号")]}::${r[pi("属性名称")]}`, r[pi("属性值")] ?? "");

/** 口径归一后再比：品牌去英文后缀、颜色 X色/X 等价、数值比数值、枚举按集合比 */
function canon(attr: string, v: string): string {
  let s = (v ?? "").trim().replace(/\s+/g, "");
  if (attr === "品牌") return s.replace(/[A-Za-z0-9&（）()·.\-]/g, "");
  if (/颜色/.test(attr)) return s.replace(/色$/, "");
  if (/^(数量|包装数量|页数|总打印页数|单支打印页数|克重|产品净重|最大功率|打印速度)$/.test(attr)) {
    const m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? String(Number(m[0])) : s;
  }
  return s.replace(/[,，、;；/]+/g, ",").replace(/^,|,$/g, "");
}

let consensusCells = 0, match = 0, mismatch = 0, prodFilledConsensusEmpty = 0;
const mismatches: string[][] = [];
const byAttr = new Map<string, { n: number; hit: number }>();

for (const r of label.slice(1)) {
  const row = r[li("原表行号")]!, pin = r[li("品名_标准")]!, attr = r[li("属性名称")]!;
  const a = r[li("标注A")] ?? "", b = r[li("标注B")] ?? "";
  const pv = prodMap.get(`${row}::${attr}`) ?? "";
  if (a.trim() && a.trim() === b.trim()) {
    consensusCells++;
    const ok = canon(attr, pv) === canon(attr, a);
    if (ok) match++;
    else {
      mismatch++;
      if (mismatches.length < 40) mismatches.push([row, pin, attr, a, pv, r[li("商品标题")] ?? ""]);
    }
    const s = byAttr.get(attr) ?? { n: 0, hit: 0 };
    s.n++;
    if (ok) s.hit++;
    byAttr.set(attr, s);
  } else if (!a.trim() && !b.trim() && pv.trim()) {
    prodFilledConsensusEmpty++;
  }
}

// 标注集最终版：共识直接给值，分歧留空待人工
const finalRows = label.slice(1).map((r) => {
  const a = (r[li("标注A")] ?? "").trim(), b = (r[li("标注B")] ?? "").trim();
  const status = a && a === b ? "共识" : !a && !b ? "双方留空" : "分歧待定";
  return [...r.slice(0, li("一致性")), status, status === "共识" ? a : ""];
});
fs.writeFileSync(
  path.join(outDir, "标注集_最终.csv"),
  [...lh.slice(0, li("一致性")), "标注结论", "共识值"].map((h) => `"${h}"`).join(",") +
    "\n" +
    finalRows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n"),
  "utf8",
);

const report = {
  consensusCells,
  productionMatchesConsensus: match,
  precisionProxy: +(match / Math.max(1, consensusCells)).toFixed(4),
  mismatch,
  productionFilledButBothAnnotatorsEmpty: prodFilledConsensusEmpty,
  worstAttributes: [...byAttr.entries()]
    .filter(([, v]) => v.n >= 5)
    .map(([k, v]) => ({ attr: k, n: v.n, hit: +(v.hit / v.n).toFixed(2) }))
    .sort((x, y) => x.hit - y.hit)
    .slice(0, 10),
  mismatchSamples: mismatches.slice(0, 12),
};
fs.writeFileSync(path.join(outDir, "precision-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
