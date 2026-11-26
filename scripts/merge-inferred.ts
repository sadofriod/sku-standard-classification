#!/usr/bin/env bun
/**
 * 把图谱推断补全的 cell 合并进长表，产出 v4 + 「标准分类 & 标准属性」两列表。
 *
 *   bun scripts/merge-inferred.ts --data-root ./data/dataset --long ./out-final/属性明细_长表_v3.csv --inferred ./out-infer/inferred.csv --out ./out-final
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
const longPath = arg("long", "./out-final/属性明细_长表_v3.csv")!;
const inferredPath = arg("inferred", "./out-infer/inferred.csv")!;
const outDir = arg("out", "./out-final")!;

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

const onto = ontologyFrom(dataRoot);
const clf = new Classifier(onto, "catalog");
const skus = readExcel(resolveDataset(dataRoot).excel);

const long = parseCsv(fs.readFileSync(longPath, "utf8").replace(/^\uFEFF/, ""));
const h = long[0]!;
const I = (n: string) => h.indexOf(n);
const iRow = I("原表行号"), iName = I("属性名称"), iVal = I("属性值"), iSrc = I("来源"), iStatus = I("状态"), iNote = I("单位");

const inferred = fs.existsSync(inferredPath) ? parseCsv(fs.readFileSync(inferredPath, "utf8").replace(/^\uFEFF/, "")) : [];
const infMap = new Map<string, { value: string; basis: string }>();
for (const r of inferred.slice(1)) infMap.set(`${r[0]}::${r[2]}`, { value: r[3]!, basis: r[4] ?? "" });

const v4: string[][] = [];
let applied = 0;
for (const r of long.slice(1)) {
  const out = [...r];
  const key = `${out[iRow]}::${out[iName]}`;
  if (!out[iVal] && infMap.has(key)) {
    const inf = infMap.get(key)!;
    out[iVal] = inf.value;
    out[iSrc] = "graph_infer";
    out[iStatus] = "已填(推断)";
    out[iNote] = `${out[iNote] ?? ""}${out[iNote] ? " · " : ""}依据:${inf.basis}`;
    applied++;
  }
  v4.push(out);
}

fs.writeFileSync(path.join(outDir, "属性明细_长表_v4.csv"), stringify([h, ...v4], { bom: true }), "utf8");

// ---- 两列主表：标准分类 + 标准属性 ----
const byRow = new Map<number, Record<string, string>>();
for (const r of v4) {
  const id = Number(r[iRow]!);
  if (!r[iVal]) continue;
  const m = byRow.get(id) ?? {};
  m[r[iName]!] = r[iVal]!;
  byRow.set(id, m);
}

const rowsOut = skus.map((s) => {
  const c = clf.classify(s);
  const attrs = byRow.get(s.sourceRow) ?? {};
  const p = c.path;
  return [
    String(s.sourceRow),
    s.title,
    `${p.level1} / ${p.level2} / ${p.level3} / ${p.level4}`,
    p.code,
    Object.entries(attrs).map(([k, v]) => `${k}：${v}`).join("；"),
    JSON.stringify(attrs),
  ];
});
fs.writeFileSync(
  path.join(outDir, "标准分类与标准属性.csv"),
  stringify([["原表行号", "商品标题", "标准分类（1-4级）", "分类代码", "标准属性", "标准属性JSON"], ...rowsOut], { bom: true }),
  "utf8",
);

// ---- 指标 ----
let req = 0, reqFilled = 0, reqInferred = 0, fully = 0;
const byRowReq = new Map<number, { total: number; filled: number }>();
for (const r of v4) {
  if (r[I("是否必填")] !== "是") continue;
  req++;
  const id = Number(r[iRow]!);
  const st = byRowReq.get(id) ?? { total: 0, filled: 0 };
  st.total++;
  if (r[iVal]) {
    st.filled++;
    reqFilled++;
    if (r[iSrc] === "graph_infer") reqInferred++;
  }
  byRowReq.set(id, st);
}
for (const st of byRowReq.values()) if (st.filled === st.total) fully++;

const metrics = {
  appliedInferredCells: applied,
  required: { total: req, filled: reqFilled, rate: +(reqFilled / req).toFixed(4), inferred: reqInferred },
  rowsFullySatisfied: fully,
  table: "标准分类与标准属性.csv",
};
fs.writeFileSync(path.join(outDir, "metrics_v4.json"), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics, null, 2));
