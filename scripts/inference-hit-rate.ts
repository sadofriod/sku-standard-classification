#!/usr/bin/env bun
/**
 * 推断命中率：把每个 `graph_infer` cell 归到它的来源层，用该 (品名,属性) 组合的留一法精度加权，
 * 输出每层与整体的命中率（可复现版，对应 README 里的推断表）。
 *
 *   bun scripts/inference-hit-rate.ts --long ./out-final/属性明细_长表_v6.csv
 */
import fs from "node:fs";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const longPath = arg("long", "./out-final/属性明细_长表_v6.csv")!;
const inferDir = arg("infer", "./out-infer")!;

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

const long = parseCsv(fs.readFileSync(longPath, "utf8").replace(/^\uFEFF/, ""));
const h = long[0]!;
const I = (n: string) => h.indexOf(n);
const iRow = I("原表行号"), iPin = I("品名_标准"), iName = I("属性名称"), iVal = I("属性值"), iSrc = I("来源");

const keyed = (file: string) => {
  const p = `${inferDir}/${file}`;
  if (!fs.existsSync(p)) return new Set<string>();
  const rows = parseCsv(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  return new Set(rows.slice(1).map((r) => `${r[0]}::${r[2]}::${r[3]}`));
};
const ctx = keyed("inferred.csv");
const open = keyed("inferred-open.csv");
const solo = keyed("inferred-solo.csv");

const pairPrecision = (file: string) => {
  const p = `${inferDir}/${file}`;
  if (!fs.existsSync(p)) return new Map<string, number>();
  const d = JSON.parse(fs.readFileSync(p, "utf8")) as { all: { key: string; precision: number | null }[] };
  return new Map(d.all.filter((x) => x.precision != null).map((x) => [x.key, x.precision!]));
};
const pCtx = pairPrecision("loo-report.json");
const pOpen = pairPrecision("open-loo.json");

const tiers = new Map<string, { n: number; hit: number }>();
let total = 0, hit = 0, filledRequired = 0;
for (const r of long.slice(1)) {
  if (r[I("是否必填")] === "是" && r[iVal]) filledRequired++;
  if (r[iSrc] !== "graph_infer" || !r[iVal]) continue;
  const k = `${r[iRow]}::${r[iName]}::${r[iVal]}`;
  const pair = `${r[iPin]}｜${r[iName]}`;
  let tier: string, p: number | undefined;
  if (solo.has(k)) { tier = "单条重试"; p = pOpen.get(pair); }
  else if (open.has(k)) { tier = "开放世界"; p = pOpen.get(pair); }
  else if (ctx.has(k)) { tier = "图谱上下文"; p = pCtx.get(pair); }
  else { tier = "开放世界"; p = pOpen.get(pair); }
  const t = tiers.get(tier) ?? { n: 0, hit: 0 };
  t.n++;
  t.hit += p ?? 0;
  tiers.set(tier, t);
  total++;
  hit += p ?? 0;
}

const table = [...tiers.entries()]
  .map(([tier, v]) => ({ tier, cells: v.n, hitRate: +(v.hit / v.n).toFixed(3), expectedWrong: Math.round(v.n - v.hit) }))
  .sort((a, b) => b.cells - a.cells);

console.log(
  JSON.stringify(
    {
      inference: { cells: total, hitRate: +(hit / total).toFixed(3), expectedWrong: Math.round(total - hit) },
      tiers: table,
      shareOfFilledRequired: +(total / Math.max(1, filledRequired)).toFixed(3),
    },
    null,
    2,
  ),
);
