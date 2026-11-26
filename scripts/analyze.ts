/**
 * 数据集画像：为架构评审提供量化依据。
 * 输出 report/dataset-profile.json 和可读摘要。
 */
import { resolveDataset } from "../src/dataset.ts";
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? "./data/dataset";
const OUT = path.resolve("./report");
fs.mkdirSync(OUT, { recursive: true });

type Row = Record<string, string>;
const readSheet = (p: string, sheet?: string): Row[] => {
  const wb = XLSX.readFile(p);
  const ws = wb.Sheets[sheet ?? wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Row>(ws, { defval: "", raw: false });
};
const n = (s: string) => String(s ?? "").trim();

// ---------- 输入 ----------
const items = readSheet(resolveDataset(ROOT).excel);
// ---------- 标准品名分类 ----------
const cat = readSheet(`${ROOT}/分类与03模板/基础信息/02_品名分类汇总.xlsx`);
// ---------- 品名属性模板 ----------
const attr = readSheet(`${ROOT}/分类与03模板/基础信息/03_品名属性表.xlsx`);
// ---------- 1-4 级对照 ----------
const map4wb = XLSX.readFile(`${ROOT}/分类与03模板/过程/最终结果/1-4级完整最终对照表_复核调整版.xlsx`);
const map4 = XLSX.utils.sheet_to_json<Row>(map4wb.Sheets[map4wb.SheetNames[0]], { defval: "", raw: false });

// ---------- 索引 ----------
const catByPinming = new Map<string, Row[]>();
for (const r of cat) {
  const k = n(r["商品品名"]);
  if (!k) continue;
  (catByPinming.get(k) ?? catByPinming.set(k, []).get(k)!).push(r);
}
const attrByPinming = new Map<string, Row[]>();
for (const r of attr) {
  const k = n(r["品名"]);
  if (!k) continue;
  (attrByPinming.get(k) ?? attrByPinming.set(k, []).get(k)!).push(r);
}
// 四级完整路径集合（调整后）
const pathSet = new Set<string>();
for (const r of map4) {
  const p = [r["调整后1级（大类）"], r["调整后2级（中类）"], r["调整后3级（小类）"], r["调整后4级（品名）"]]
    .map(n)
    .join("/");
  if (p.replace(/\//g, "")) pathSet.add(p);
}

// ---------- 指标 ----------
const pinmingSet = new Set(items.map((r) => n(r["商品品名"])));
const hit = items.filter((r) => catByPinming.has(n(r["商品品名"])));
const sameCat = hit.filter((r) => {
  const cands = catByPinming.get(n(r["商品品名"]))!;
  return cands.some(
    (c) =>
      n(c["大类"]) === n(r["大类"]) &&
      n(c["中类"]) === n(r["中类"]) &&
      n(c["小类"]) === n(r["小类"]) &&
      n(c["分类代码"]) === n(r["分类代码"]),
  );
});
const multiCand = hit.filter((r) => (catByPinming.get(n(r["商品品名"]))?.length ?? 0) > 1);
const attrHit = items.filter((r) => attrByPinming.has(n(r["商品品名"])));
const attrNonEmpty = attr.filter((r) => {
  const raw = n(r["属性参数"]);
  if (!raw || raw === "{}" || raw === "[]") return false;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && Object.keys(o).length > 0;
  } catch {
    return false;
  }
});
const attrCounts = [...attrByPinming.entries()].map(([k, v]) => [k, v.length] as const);
const attrCntByPinming = new Map(attrCounts.filter(([k]) => pinmingSet.has(k)));

const statusOf = (rows: Row[]) => {
  const s: Record<string, number> = {};
  for (const r of rows) s[n(r["启停状态"]) || "(空)"] = (s[n(r["启停状态"]) || "(空)"] ?? 0) + 1;
  return s;
};

// 品名在 02 表里是否存在“启用”的分类型
const enabledPinming = new Set(cat.filter((r) => n(r["启停状态"]) === "启用").map((r) => n(r["商品品名"])));

const report = {
  generatedAt: new Date().toISOString(),
  input: {
    rows: items.length,
    distinctSku: new Set(items.map((r) => n(r["商品标题"]) + n(r["商品品牌"]))).size,
    distinctPinming: pinmingSet.size,
    distinctZhonglei: new Set(items.map((r) => n(r["中类"]))).size,
    distinctXiaolei: new Set(items.map((r) => n(r["小类"]))).size,
    distinctCode: new Set(items.map((r) => n(r["分类代码"]))).size,
    attrParamNonEmpty: attrNonEmpty.length,
    attrParamEmpty: items.length - attrNonEmpty.length,
  },
  taxonomy: {
    pinmingRows: cat.length,
    distinctPinming: catByPinming.size,
    distinctCode: new Set(cat.map((r) => n(r["分类代码"]))).size,
    status: statusOf(cat),
    pathRowsInMap4: map4.length,
    distinctPathsInMap4: pathSet.size,
  },
  attributeTemplate: {
    rows: attr.length,
    distinctPinming: attrByPinming.size,
    distinctAttrName: new Set(attr.map((r) => n(r["属性名称"]))).size,
    status: statusOf(attr),
    fieldTypes: [...new Set(attr.map((r) => n(r["字段类型"])))],
    types: [...new Set(attr.map((r) => n(r["属性类型"])))],
  },
  coverage: {
    pinmingHit02: hit.length,
    pinmingHit02Rate: +(hit.length / items.length).toFixed(4),
    pinmingHit02Enabled: items.filter((r) => enabledPinming.has(n(r["商品品名"]))).length,
    categoryUnchanged: sameCat.length,
    categoryUnchangedRate: +(sameCat.length / items.length).toFixed(4),
    pinmingWithMultipleCandidates: multiCand.length,
    pinmingHit03: attrHit.length,
    pinmingHit03Rate: +(attrHit.length / items.length).toFixed(4),
  },
  attributeLoad: {
    avgAttributesPerPinming: +(attrCntByPinming.size
      ? [...attrCntByPinming.values()].reduce((a, b) => a + b, 0) / attrCntByPinming.size
      : 0).toFixed(2),
    maxAttributesPerPinming: Math.max(0, ...attrCntByPinming.values()),
    estimatedAttributeCells: [...attrCntByPinming.values()].reduce((a, b) => a + b, 0),
  },
} as const;

fs.writeFileSync(`${OUT}/dataset-profile.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
