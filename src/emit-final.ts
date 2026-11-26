#!/usr/bin/env bun
/**
 * 合并 + 交付：结构化列 > LLM 校验值 > 标题规则 > 缺失。
 * 产出「清洗后的产物表」三件套 + 宽表 + 指标。
 *
 *   bun src/emit-final.ts --data-root ./data/dataset --llm ./out-llm/llm-rows.json --out ./out-final
 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import { Ontology } from "./ontology.ts";
import { Classifier } from "./classify.ts";
import { AttributeExtractor } from "./extract.ts";
import { readExcel } from "./ingest.ts";
import { normalizeText } from "./text.ts";
import { strictColor, isColorAttr } from "./color.ts";
import type { AttrDef, SkuInput } from "./types.ts";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const dataRoot = arg("data-root", "./data/dataset")!;
const llmPath = arg("llm", "./out-llm/llm-rows.json")!;
const outDir = arg("out", "./out-final")!;

const onto = ontologyFrom(dataRoot);
const clf = new Classifier(onto, "catalog");
const ext = new AttributeExtractor();
const skus = readExcel(resolveDataset(dataRoot).excel);
const llm: Record<string, { pinming: string; attrs: Record<string, string>; issues: string[] }> = JSON.parse(
  fs.readFileSync(llmPath, "utf8"),
);

/** 列值永远优先：这几项是结构化字段，模型没有资格改写 */
const COLUMN_ATTRS = new Set(["产品名称", "商品名称", "品牌", "制造商型号", "型号"]);

const COLOR_NORM: Record<string, string> = { 黑: "黑色", 白: "白色", 红: "红色", 蓝: "蓝色", 银: "银色", 灰: "灰色", 绿: "绿色", 粉: "粉色", 黄: "黄色" };

function normalizeValue(def: AttrDef, v: string, title = ""): string {
  let s = normalizeText(v);
  if (!s) return "";
  if (def.fieldType === "枚举") {
    const parts = s.split(/[,，、;；/]+/).map((x) => x.trim()).filter(Boolean);
    const canon = parts
      .map((p) => def.enumValues.find((e) => e === p) ?? def.enumValues.find((e) => e.replace(/\s/g, "").toLowerCase() === p.replace(/\s/g, "").toLowerCase()) ?? "")
      .filter(Boolean);
    return [...new Set(canon)].join(",");
  }
  if (def.fieldType === "数值") {
    const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? m[0] : "";
  }
  if (isColorAttr(def.name)) {
    // 1) 值在标题里逐字出现 → 直接接受（透明/象牙白/原木色/白底黑字这类不在色卡上的写法）
    const t = normalizeText(title);
    const raw = normalizeText(v);
    if (raw && t.includes(raw)) return raw;
    // 2) 标题里有标准色词 → 归一化后用
    const confirmed = strictColor(t);
    if (confirmed) return COLOR_NORM[confirmed.replace("色", "")] ?? confirmed;
    return "";
  }
  if (def.name === "品牌") s = s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+$/, "");
  return s.slice(0, 120);
}

interface RowOut {
  sku: SkuInput;
  pinming: string;
  path: { level1: string; level2: string; level3: string; level4: string; code: string };
  confidence: number;
  changed: boolean;
  values: { def: AttrDef; value: string; source: "column" | "llm" | "title" | "missing" }[];
  flags: string[];
}

const rows: RowOut[] = [];
const stats = {
  cells: 0,
  filled: 0,
  bySource: { column: 0, llm: 0, title: 0 } as Record<string, number>,
  required: 0,
  requiredFilled: 0,
  enumViolations: 0,
  llmHallucinations: 0,
  rowsFullySatisfied: 0,
};

for (const sku of skus) {
  const c = clf.classify(sku);
  const defs = onto.attrDefs(c.finalPinming);
  const deterministic = ext.extract(sku, defs);
  const detByName = new Map(deterministic.map((d) => [d.name, d]));
  const llmRow = llm[String(sku.sourceRow)];
  const llmAttrs = llmRow?.pinming === c.finalPinming ? llmRow.attrs : {};
  const flags: string[] = [...c.reviewFlags];

  if (llmRow && llmRow.pinming !== c.finalPinming) flags.push("LLM 品名不一致（已忽略其属性）");
  if (llmRow) stats.llmHallucinations += llmRow.issues.filter((i) => i.startsWith("幻觉属性")).length;

  const values = defs.map((def) => {
    const det = detByName.get(def.name);
    if (COLUMN_ATTRS.has(def.name) && det?.value && det.source === "column")
      return { def, value: normalizeValue(def, det.value, sku.title), source: "column" as const };
    const lv = normalizeValue(def, llmAttrs[def.name] ?? "", sku.title);
    if (lv) return { def, value: lv, source: "llm" as const };
    if (det?.value) return { def, value: normalizeValue(def, det.value, sku.title), source: "title" as const };
    return { def, value: "", source: "missing" as const };
  });

  const required = defs.filter((d) => d.required);
  const requiredFilled = values.filter((v) => v.def.required && v.value).length;
  for (const v of values) {
    stats.cells++;
    if (v.value) {
      stats.filled++;
      stats.bySource[v.source] = (stats.bySource[v.source] ?? 0) + 1;
    }
  }
  stats.required += required.length;
  stats.requiredFilled += requiredFilled;
  if (required.length && requiredFilled === required.length) stats.rowsFullySatisfied++;

  const missingRequired = required.filter((d) => !values.find((v) => v.def.name === d.name && v.value)).map((d) => d.name);
  if (missingRequired.length) flags.push(`必填缺失:${missingRequired.join("|")}`);

  rows.push({
    sku,
    pinming: c.finalPinming,
    path: c.path,
    confidence: c.confidence,
    changed: c.changed,
    values,
    flags,
  });
}

fs.mkdirSync(outDir, { recursive: true });
const writeCsv = (name: string, header: string[], body: (string | number)[][]) =>
  fs.writeFileSync(path.join(outDir, name), stringify([header, ...body], { bom: true }), "utf8");

// ---------- 1. 产品表（一行一件）----------
writeCsv(
  "产品表_清洗后.csv",
  [
    "原表行号",
    "商品品名_输入",
    "品名_标准",
    "大类",
    "中类",
    "小类",
    "分类代码",
    "分类是否变更",
    "分类置信度",
    "商品标题",
    "商品品牌",
    "制造商型号",
    "销售单位",
    "属性总数",
    "必填总数",
    "必填已填",
    "必填覆盖率",
    "待核实项",
    "属性JSON",
  ],
  rows.map((r) => {
    const req = r.values.filter((v) => v.def.required);
    const reqFilled = req.filter((v) => v.value).length;
    return [
      r.sku.sourceRow,
      r.sku.pinming,
      r.pinming,
      r.path.level1,
      r.path.level2,
      r.path.level3,
      r.path.code,
      r.changed ? "是" : "否",
      r.confidence.toFixed(2),
      r.sku.title,
      r.sku.brandRaw,
      r.sku.modelRaw,
      r.sku.unit,
      r.values.length,
      req.length,
      reqFilled,
      req.length ? (reqFilled / req.length).toFixed(3) : "1.000",
      r.flags.join("; "),
      JSON.stringify(Object.fromEntries(r.values.filter((v) => v.value).map((v) => [v.def.name, v.value]))),
    ];
  }),
);

// ---------- 2. 属性明细（长表，对齐 03 模板）----------
const longBody: (string | number)[][] = [];
for (const r of rows)
  for (const v of r.values)
    longBody.push([
      r.sku.sourceRow,
      r.pinming,
      v.def.name,
      v.value,
      v.source,
      v.def.required ? "是" : "否",
      v.def.fieldType,
      v.def.unit,
      v.value ? "已填" : "缺失",
      v.def.attrType,
    ]);
writeCsv(
  "属性明细_长表.csv",
  ["原表行号", "品名_标准", "属性名称", "属性值", "来源", "是否必填", "字段类型", "单位", "状态", "属性类型"],
  longBody,
);

// ---------- 3. 复核队列 ----------
writeCsv(
  "复核队列.csv",
  ["原表行号", "品名_输入", "品名_标准", "复核原因", "商品标题"],
  rows
    .filter((r) => r.flags.length)
    .map((r) => [r.sku.sourceRow, r.sku.pinming, r.pinming, r.flags.join("; "), r.sku.title]),
);

// ---------- 4. 宽表（仅必填属性，便于 Excel 看）----------
const requiredNames = [...new Set(rows.flatMap((r) => r.values.filter((v) => v.def.required).map((v) => v.def.name)))];
writeCsv(
  "产品表_宽表_必填属性.csv",
  ["原表行号", "品名_标准", "分类代码", "商品标题", ...requiredNames],
  rows.map((r) => [
    r.sku.sourceRow,
    r.pinming,
    r.path.code,
    r.sku.title,
    ...requiredNames.map((n) => r.values.find((v) => v.def.name === n)?.value ?? ""),
  ]),
);

const metrics = {
  generatedAt: new Date().toISOString(),
  rows: rows.length,
  cells: stats.cells,
  filled: stats.filled,
  fillRate: +(stats.filled / stats.cells).toFixed(4),
  bySource: stats.bySource,
  required: { total: stats.required, filled: stats.requiredFilled, rate: +(stats.requiredFilled / stats.required).toFixed(4) },
  rowsFullySatisfied: stats.rowsFullySatisfied,
  llmHallucinations: stats.llmHallucinations,
  reviewRows: rows.filter((r) => r.flags.length).length,
  wideRequiredCols: requiredNames.length,
};
fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics, null, 2));
