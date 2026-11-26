#!/usr/bin/env bun
/**
 * 按置信度分层：给每个已填 cell 打置信度，算不同门槛下的覆盖率，并按门槛出交付表。
 *
 * 置信度来源：
 *  1.00 结构化列 / 标题规则（确定性）
 *  0.99 LLM 模板抽取（双盲精度 99.2%）
 *  X    图谱推断：取该 (品名,属性) 组合的留一法精度（图谱上下文 93.2% 档 / 开放世界 89.9% 档 / 单条重试按同组合精度）
 *
 *   bun scripts/confidence-tiers.ts --long ./out-final/属性明细_长表_v6.csv --emit 0.9
 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import { Ontology } from "../src/ontology.ts";
import { Classifier } from "../src/classify.ts";
import { readExcel } from "../src/ingest.ts";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const dataRoot = arg("data-root", "./data/dataset")!;
const longPath = arg("long", "./out-final/属性明细_长表_v6.csv")!;
const outDir = arg("out", "./out-final")!;
const EMIT = Number(arg("emit", "0.9"));

const onto = ontologyFrom(dataRoot);
const clf = new Classifier(onto, "catalog");
const skus = readExcel(resolveDataset(dataRoot).excel);

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
const iRow = I("原表行号"), iPin = I("品名_标准"), iName = I("属性名称"), iVal = I("属性值"), iSrc = I("来源"), iReq = I("是否必填");

// 三个推断来源 → (row|attr) → 来源档
const tagOf = new Map<string, "ctx" | "open" | "solo">();
for (const [file, tag] of [
  ["./out-infer/inferred.csv", "ctx"],
  ["./out-infer/inferred-open.csv", "open"],
  ["./out-infer/inferred-solo.csv", "solo"],
] as const) {
  if (!fs.existsSync(file)) continue;
  for (const r of parseCsv(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).slice(1)) tagOf.set(`${r[0]}::${r[2]}`, tag);
}

// 各档的 (品名,属性) 组合精度
const pairPrecision = new Map<string, number>();
const ctxLoo = "./out-infer/loo-report.json";
if (fs.existsSync(ctxLoo)) {
  const d = JSON.parse(fs.readFileSync(ctxLoo, "utf8")) as { all: { key: string; precision: number | null }[] };
  for (const x of d.all) if (x.precision != null) pairPrecision.set(`ctx:${x.key}`, x.precision);
}
const openLoo = "./out-infer/open-loo.json";
if (fs.existsSync(openLoo)) {
  const d = JSON.parse(fs.readFileSync(openLoo, "utf8")) as { all: { key: string; precision: number | null }[] };
  for (const x of d.all) if (x.precision != null) {
    pairPrecision.set(`open:${x.key}`, x.precision);
    pairPrecision.set(`solo:${x.key}`, x.precision);
  }
}

function confOf(r: string[]): { conf: number; tier: string } {
  const src = r[iSrc]!;
  if (src === "column") return { conf: 1, tier: "结构化列" };
  if (src === "title") return { conf: 0.99, tier: "标题规则" };
  if (src === "llm") return { conf: 0.99, tier: "LLM抽取" };
  if (src === "graph") return { conf: 0.9, tier: "同型号传播" };
  if (src === "graph_infer") {
    const tag = tagOf.get(`${r[iRow]}::${r[iName]}`) ?? "ctx";
    const p = pairPrecision.get(`${tag}:${r[iPin]}｜${r[iName]}`);
    const name = tag === "ctx" ? "图谱上下文" : tag === "open" ? "开放世界" : "单条重试";
    return { conf: p ?? 0.85, tier: name };
  }
  return { conf: 1, tier: src };
}

const thresholds = [0.95, 0.93, 0.9, 0.85, 0.8, 0.7];
const reqCells = long.slice(1).filter((r) => r[iReq] === "是");
const rowsWithConf = reqCells.map((r) => ({ r, ...confOf(r), filled: !!r[iVal] }));

const table = thresholds.map((t) => {
  const filled = rowsWithConf.filter((x) => x.filled && x.conf >= t).length;
  const kept = rowsWithConf.filter((x) => x.filled && x.conf >= t);
  const expErr = kept.reduce((a, x) => a + (1 - x.conf), 0);
  return { threshold: t, filled, total: reqCells.length, rate: +(filled / reqCells.length).toFixed(4), expectedErrors: Math.round(expErr) };
});

// 分层统计
const byTier = new Map<string, { n: number; sum: number }>();
for (const x of rowsWithConf) {
  if (!x.filled) continue;
  const e = byTier.get(x.tier) ?? { n: 0, sum: 0 };
  e.n++;
  e.sum += x.conf;
  byTier.set(x.tier, e);
}

// ---- 按门槛出表 ----
const keptRows = rowsWithConf.filter((x) => x.filled && x.conf >= EMIT).map((x) => x.r);
const byRow = new Map<number, Record<string, string>>();
for (const r of keptRows) {
  const id = Number(r[iRow]!);
  const m = byRow.get(id) ?? {};
  m[r[iName]!] = r[iVal]!;
  byRow.set(id, m);
}

const std = skus.map((s) => {
  const c = clf.classify(s);
  const p = c.path;
  const attrs = byRow.get(s.sourceRow) ?? {};
  return [
    String(s.sourceRow),
    s.title,
    `${p.level1} / ${p.level2} / ${p.level3} / ${p.level4}`,
    p.code,
    Object.entries(attrs).map(([k, v]) => `${k}：${v}`).join("；"),
    JSON.stringify(attrs),
  ];
});
const suffix = `_conf${EMIT}`;
fs.writeFileSync(
  path.join(outDir, `标准分类与标准属性${suffix}.csv`),
  stringify([["原表行号", "商品标题", "标准分类（1-4级）", "分类代码", "标准属性", "标准属性JSON"], ...std], { bom: true }),
  "utf8",
);

const report = {
  emitThreshold: EMIT,
  coverageByThreshold: table,
  tiers: [...byTier.entries()].map(([tier, v]) => ({ tier, cells: v.n, accuracy: +(v.sum / v.n).toFixed(2) })).sort((a, b) => b.cells - a.cells),
  requiredTotal: reqCells.length,
  emittedTable: `标准分类与标准属性${suffix}.csv`,
};
fs.writeFileSync(path.join(outDir, "confidence-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
