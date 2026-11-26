/**
 * 第二层画像：分类权威冲突、属性模板质量、SKU 证据可用性。
 */
import { resolveDataset } from "../src/dataset.ts";
import XLSX from "xlsx";
import fs from "node:fs";

const ROOT = process.argv[2] ?? "./data/dataset";
type Row = Record<string, string>;
const read = (p: string, sheet?: string): Row[] => {
  const wb = XLSX.readFile(p);
  return XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheet ?? wb.SheetNames[0]], { defval: "", raw: false });
};
const n = (s: string) => String(s ?? "").trim();

const items = read(resolveDataset(ROOT).excel);
const cat = read(`${ROOT}/分类与03模板/基础信息/02_品名分类汇总.xlsx`);
const attr = read(`${ROOT}/分类与03模板/基础信息/03_品名属性表.xlsx`);
const map4 = read(`${ROOT}/分类与03模板/过程/最终结果/1-4级完整最终对照表_复核调整版.xlsx`);

const pins = new Set(items.map((r) => n(r["商品品名"])));

// --- 02 表：品名 -> 路径（启用优先）
const catByPin = new Map<string, Row>();
for (const r of cat) {
  const k = n(r["商品品名"]);
  if (!k) continue;
  const prev = catByPin.get(k);
  if (!prev || (n(r["启停状态"]) === "启用" && n(prev["启停状态"]) !== "启用")) catByPin.set(k, r);
}
// --- map4：调整后 4 级路径
const mapByPin4 = new Map<string, Row>();
for (const r of map4) {
  const k = n(r["调整后4级（品名）"]);
  if (k && !mapByPin4.has(k)) mapByPin4.set(k, r);
}
const path02 = (r: Row) => [n(r["大类"]), n(r["中类"]), n(r["小类"])].join("/");
const pathMap4 = (r: Row) =>
  [n(r["调整后1级（大类）"]), n(r["调整后2级（中类）"]), n(r["调整后3级（小类）"])].join("/");

// 169 品名在两张权威表之间的一致性
const conflict: { pinming: string; p02: string; pmap4: string; rows: number }[] = [];
const only02: string[] = [];
const onlyMap4: string[] = [];
for (const p of pins) {
  const a = catByPin.get(p);
  const b = mapByPin4.get(p);
  const rows = items.filter((r) => n(r["商品品名"]) === p).length;
  if (a && b) {
    if (path02(a) !== pathMap4(b)) conflict.push({ pinming: p, p02: path02(a), pmap4: pathMap4(b), rows });
  } else if (a) only02.push(p);
  else if (b) onlyMap4.push(p);
}
conflict.sort((x, y) => y.rows - x.rows);

// --- 属性模板：按品名聚合
const attrByPin = new Map<string, Row[]>();
for (const r of attr) {
  if (n(r["启停状态"]) !== "启用") continue;
  const k = n(r["品名"]);
  (attrByPin.get(k) ?? attrByPin.set(k, []).get(k)!).push(r);
}
let requiredCells = 0;
let optionalCells = 0;
let enumCells = 0;
let rowsWithTemplate = 0;
const perPin: { pinming: string; skus: number; attrs: number; required: number; enums: number }[] = [];
for (const p of pins) {
  const arr = attrByPin.get(p) ?? [];
  if (arr.length) rowsWithTemplate++;
  const req = arr.filter((r) => n(r["是否必填"]) === "是").length;
  const en = arr.filter((r) => n(r["字段类型"]) === "枚举").length;
  const skus = items.filter((r) => n(r["商品品名"]) === p).length;
  requiredCells += req * skus;
  optionalCells += (arr.length - req) * skus;
  enumCells += en * skus;
  perPin.push({ pinming: p, skus, attrs: arr.length, required: req, enums: en });
}
perPin.sort((a, b) => b.skus - a.skus);

// 枚举属性的候选值规模
const enumValues = new Map<string, Set<string>>();
for (const r of attr) {
  if (n(r["字段类型"]) !== "枚举" || n(r["启停状态"]) !== "启用") continue;
  const k = `${n(r["品名"])}::${n(r["属性名称"])}`;
  const v = n(r["属性值"]);
  if (!v) continue;
  const s = enumValues.get(k) ?? enumValues.set(k, new Set()).get(k)!;
  for (const part of v.split(/[|,，;；\/]/)) if (part.trim()) s.add(part.trim());
}
const enumSizes = [...enumValues.values()].map((s) => s.size).sort((a, b) => a - b);

// SKU 级证据可用性
const titleLen = items.map((r) => n(r["商品标题"]).length);
const hasModel = items.filter((r) => n(r["制造商型号"]).length > 0).length;
const nameNeTitle = items.filter((r) => n(r["商品名称"]) !== n(r["商品品名"])).length;
const titleHasUnit = items.filter((r) => /单位[:：]|（单位|\/筒|个\/|支|盒|包|瓶|卷|套/.test(n(r["商品标题"]))).length;
const dirtyModel = items.filter((r) => /&nbsp;|<|>/.test(n(r["制造商型号"]))).length;

const out = {
  authorityConflict: {
    pinsChecked: pins.size,
    bothTables: pins.size - only02.length - onlyMap4.length,
    conflictingPaths: conflict.length,
    conflictingRows: conflict.reduce((a, b) => a + b.rows, 0),
    onlyIn02: only02.length,
    onlyInMap4: onlyMap4.length,
    top: conflict.slice(0, 15),
  },
  attributeTemplate: {
    pinsWithEnabledTemplate: rowsWithTemplate,
    requiredCellsFor1000: requiredCells,
    optionalCellsFor1000: optionalCells,
    enumCellsFor1000: enumCells,
    totalCellsFor1000: requiredCells + optionalCells,
    enumAttrCount: enumValues.size,
    enumSizeMedian: enumSizes.length ? enumSizes[Math.floor(enumSizes.length / 2)] : 0,
    enumSizeMax: enumSizes.length ? enumSizes[enumSizes.length - 1] : 0,
    topPinming: perPin.slice(0, 10),
    pinsWithoutTemplate: [...pins].filter((p) => !attrByPin.has(p)).length,
  },
  evidence: {
    medianTitleLen: titleLen.sort((a, b) => a - b)[Math.floor(titleLen.length / 2)],
    hasModel,
    nameDiffersFromPinming: nameNeTitle,
    titleHasUnit,
    dirtyModel,
  },
};
fs.writeFileSync("./report/dataset-profile2.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
