#!/usr/bin/env bun
/**
 * 图谱传播补全：把「同品名 + 同制造商型号」的 SKU 连成边，用组内已确认的值补缺失的必填属性。
 *
 * 为什么这是"基于图谱推断"而不是猜：
 *  - 边来自结构化字段（品名、型号），不是语义相似；
 *  - 同型号不同行本来就是同一件货的不同包装/单位，属性必然一致；
 *  - 补全前先用**留一法**验证：把已知值藏起来，用组内其它行推，能量化恢复率与准确率。
 *
 * 用法：bun src/graph-fill.ts --data-root ./data/dataset --long ./out-final/属性明细_长表.csv --out ./out-final
 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import { Ontology } from "./ontology.ts";
import { Classifier } from "./classify.ts";
import { readExcel } from "./ingest.ts";
import { normalizeText } from "./text.ts";
import type { AttrDef } from "./types.ts";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const dataRoot = arg("data-root", "./data/dataset")!;
const longPath = arg("long", "./out-final/属性明细_长表.csv")!;
const outDir = arg("out", "./out-final")!;

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
const iRow = I("原表行号"), iName = I("属性名称"), iVal = I("属性值"), iSrc = I("来源"), iStatus = I("状态");

/** (row,attr) -> {value, source} */
const cur = new Map<string, { value: string; source: string }>();
for (const r of long.slice(1)) cur.set(`${r[iRow]}::${r[iName]}`, { value: r[iVal] ?? "", source: r[iSrc] ?? "" });

/** 型号归一：大写、去空格/连字符、去掉容量前缀（1.5L / 50ml） */
const normModel = (m: string) =>
  normalizeText(m)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^(\d+(\.\d+)?(ML|L|G|KG|MM|CM|M|页|支|只))+/i, "")
    .replace(/[^\u4e00-\u9fa5A-Z0-9.\-_/]/g, "");

const rowsMeta = skus.map((s) => {
  const c = clf.classify(s);
  return { sku: s, pinming: c.finalPinming, model: normModel(s.modelRaw) };
});

/** 组：同品名 + 同归一型号（型号为空则不入图） */
const groups = new Map<string, number[]>();
for (const m of rowsMeta) {
  if (!m.model || m.model.length < 3) continue;
  const k = `${m.pinming}||${m.model}`;
  (groups.get(k) ?? groups.set(k, []).get(k)!).push(m.sku.sourceRow);
}
const groupOf = new Map<number, string>();
for (const [k, rows] of groups) for (const r of rows) groupOf.set(r, k);

/** 型号字符 bigram → 同品名+同品牌内做相似度，得到"同系列"邻居（权重=相似度） */
const bigrams = (s: string) => {
  const t = s.replace(/[^A-Z0-9]/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
};
const sim = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

const neighbors = new Map<number, { row: number; w: number }[]>();
{
  const byPinBrand = new Map<string, typeof rowsMeta>();
  for (const m of rowsMeta) {
    const key = `${m.pinming}||${normalizeText(m.sku.brandRaw).toUpperCase()}`;
    (byPinBrand.get(key) ?? byPinBrand.set(key, []).get(key)!).push(m);
  }
  for (const [, arr] of byPinBrand) {
    const bg = arr.map((m) => bigrams(m.model));
    for (let i = 0; i < arr.length; i++) {
      const list: { row: number; w: number }[] = [];
      for (let j = 0; j < arr.length; j++) {
        if (i === j) continue;
        const w = sim(bg[i]!, bg[j]!);
        if (w >= 0.5) list.push({ row: arr[j]!.sku.sourceRow, w });
      }
      list.sort((a, b) => b.w - a.w);
      neighbors.set(arr[i]!.sku.sourceRow, list.slice(0, 10));
    }
  }
}

const canon = (attr: string, v: string) => {
  let s = normalizeText(v).replace(/\s+/g, "");
  if (/颜色/.test(attr)) s = s.replace(/色$/, "");
  if (attr === "品牌") s = s.replace(/[A-Za-z0-9&（）()·.\-]/g, "");
  return s;
};

/** 组内取值：排除自身，返回众数值与支持度 */
function infer(row: number, attr: string, defs: AttrDef[], excluded?: Set<string>) {
  const g = groupOf.get(row);
  const exactPeers = g ? (groups.get(g) ?? []).filter((r) => r !== row) : [];
  const simPeers = (neighbors.get(row) ?? []).map((n) => n.row);
  const peers = [...new Set([...exactPeers, ...simPeers])];
  if (!peers.length) return null;
  const tally = new Map<string, { raw: string; n: number }>();
  for (const p of peers) {
    const key = `${p}::${attr}`;
    if (excluded?.has(key)) continue;
    const v = cur.get(key);
    if (!v?.value) continue;
    const c = canon(attr, v.value);
    if (!c) continue;
    const e = tally.get(c) ?? { raw: v.value, n: 0 };
    e.n++;
    tally.set(c, e);
  }
  if (!tally.size) return null;
  const [c, best] = [...tally.entries()].sort((a, b) => b[1].n - a[1].n)[0]!;
  const total = [...tally.values()].reduce((a, x) => a + x.n, 0);
  const share = best.n / total;
  if (best.n < 2 || share < 0.8) return null;
  return { value: best.raw, support: best.n, share, peers: peers.length };
}

// ---------- 留一法验证 ----------
let looTried = 0, looHit = 0, looMiss = 0;
const looMissSamples: string[] = [];
for (const m of rowsMeta) {
  const defs = onto.attrDefs(m.pinming).filter((d) => d.required);
  for (const d of defs) {
    const key = `${m.sku.sourceRow}::${d.name}`;
    const v = cur.get(key);
    if (!v?.value) continue;
    if (!groupOf.has(m.sku.sourceRow)) continue;
    looTried++;
    const inf = infer(m.sku.sourceRow, d.name, defs, new Set([key]));
    if (inf && canon(d.name, inf.value) === canon(d.name, v.value)) looHit++;
    else {
      looMiss++;
      if (looMissSamples.length < 8) looMissSamples.push(`${m.sku.sourceRow}/${m.pinming}/${d.name}: 真=${v.value} 推=${inf?.value ?? "无"}`);
    }
  }
}

// ---------- 应用补全（只补必填、且只补当前为空的）----------
const applied: { row: number; pinming: string; attr: string; value: string; support: number }[] = [];
for (const m of rowsMeta) {
  const defs = onto.attrDefs(m.pinming);
  for (const d of defs) {
    if (!d.required) continue;
    const key = `${m.sku.sourceRow}::${d.name}`;
    const v = cur.get(key);
    if (v?.value) continue;
    const inf = infer(m.sku.sourceRow, d.name, defs);
    if (!inf) continue;
    cur.set(key, { value: inf.value, source: "graph" });
    applied.push({ row: m.sku.sourceRow, pinming: m.pinming, attr: d.name, value: inf.value, support: inf.support });
  }
}

// ---------- 输出 v3：长表 + 标准分类与标准属性 ----------
fs.mkdirSync(outDir, { recursive: true });
const v3 = long.slice(1).map((r) => {
  const key = `${r[iRow]}::${r[iName]}`;
  const v = cur.get(key)!;
  const out = [...r];
  out[iVal] = v.value;
  out[iSrc] = v.source;
  out[iStatus] = v.value ? "已填" : "缺失";
  return out;
});
fs.writeFileSync(
  path.join(outDir, "属性明细_长表_v3.csv"),
  stringify([h, ...v3], { bom: true }),
  "utf8",
);

const byRow = new Map<number, Record<string, string>>();
for (const r of v3) {
  const id = Number(r[iRow]!);
  const v = r[iVal]!;
  if (!v) continue;
  const m = byRow.get(id) ?? {};
  m[r[iName]!] = v;
  byRow.set(id, m);
}

const std = skus.map((s) => {
  const c = clf.classify(s);
  const p = c.path;
  const attrs = byRow.get(s.sourceRow) ?? {};
  return [
    s.sourceRow,
    s.title,
    `${p.level1}/${p.level2}/${p.level3}/${p.level4}`,
    p.code,
    Object.entries(attrs)
      .map(([k, v]) => `${k}=${v}`)
      .join(" | "),
    JSON.stringify(attrs),
  ];
});
fs.writeFileSync(
  path.join(outDir, "标准分类与标准属性.csv"),
  stringify(
    [["原表行号", "商品标题", "标准分类", "分类代码", "标准属性", "标准属性JSON"], ...std],
    { bom: true },
  ),
  "utf8",
);

// ---------- 指标 ----------
const requiredCells = rowsMeta.reduce((a, m) => a + onto.attrDefs(m.pinming).filter((d) => d.required).length, 0);
const requiredFilled = rowsMeta.reduce(
  (a, m) => a + onto.attrDefs(m.pinming).filter((d) => d.required && (cur.get(`${m.sku.sourceRow}::${d.name}`)?.value ?? "")).length,
  0,
);
const report = {
  groups: groups.size,
  rowsInGroups: groupOf.size,
  propagation: {
    appliedCells: applied.length,
    byAttribute: Object.entries(
      applied.reduce<Record<string, number>>((a, x) => ((a[x.attr] = (a[x.attr] ?? 0) + 1), a), {}),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10),
  },
  leaveOneOut: {
    tried: looTried,
    hit: looHit,
    miss: looMiss,
    accuracy: looTried ? +(looHit / looTried).toFixed(4) : null,
    samples: looMissSamples,
  },
  requiredCoverage: { total: requiredCells, filled: requiredFilled, rate: +(requiredFilled / requiredCells).toFixed(4) },
};
fs.writeFileSync(path.join(outDir, "graph-fill-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
