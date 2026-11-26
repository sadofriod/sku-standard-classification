/**
 * 管线入口（确定性基线，不调用任何模型）：
 *   ingest → ontology → classify → extract → validate → emit → metrics
 *
 * 用法：
 *   node --experimental-strip-types src/pipeline.ts --data-root ./data_tmp --out ./out --authority catalog
 *
 * 这条基线的作用是给出「不花一个 token 能拿到多少」的下界，模型层必须按行对比才允许上线。
 */
import { resolveDataset } from "../src/dataset.ts";
import { ontologyFrom } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import { Ontology } from "./ontology.ts";
import { Classifier } from "./classify.ts";
import { AttributeExtractor } from "./extract.ts";
import { readExcel, readJsonl, assertAligned } from "./ingest.ts";
import { emit } from "./emit.ts";
import type { SkuResult } from "./types.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const dataRoot = arg("data-root", "./data/dataset")!;
const outDir = arg("out", "./out")!;
const authority = (arg("authority", "catalog") as "catalog" | "reviewed");

const t0 = Date.now();
const dsDir = path.join(dataRoot);
const excel = readExcel(resolveDataset(dataRoot).excel);
const jsonl = readJsonl(resolveDataset(dataRoot).jsonl);
const alignErrors = assertAligned(excel, jsonl);
if (alignErrors.length) {
  console.error("输入对齐失败：\n" + alignErrors.slice(0, 10).join("\n"));
  process.exit(1);
}

const onto = ontologyFrom(dataRoot);
onto.dumpJson(path.join(outDir, "ontology.json"));

const clf = new Classifier(onto, authority);
const ext = new AttributeExtractor();
const inputs = new Map(excel.map((s) => [s.sourceRow, s]));
const defsByPin = new Map<string, { name: string; required: boolean; fieldType: string; unit: string }[]>();

const results: SkuResult[] = [];
for (const sku of excel) {
  const c = clf.classify(sku);
  const defs = onto.attrDefs(c.finalPinming);
  if (!defsByPin.has(c.finalPinming))
    defsByPin.set(
      c.finalPinming,
      defs.map((d) => ({ name: d.name, required: d.required, fieldType: d.fieldType, unit: d.unit })),
    );
  const attrs = ext.extract(sku, defs);
  const requiredTotal = defs.filter((d) => d.required).length;
  const requiredFilled = attrs.filter((a) => a.value && defs.find((d) => d.name === a.name)?.required).length;
  results.push({
    sourceRow: sku.sourceRow,
    inputPinming: sku.pinming,
    finalPinming: c.finalPinming,
    path: c.path,
    categorySource: c.source,
    categoryChanged: c.changed,
    categoryConfidence: c.confidence,
    categoryEvidence: c.evidence,
    attributes: attrs,
    requiredTotal,
    requiredFilled,
    reviewFlags: c.reviewFlags,
  });
}

const emitted = emit(outDir, inputs, results, defsByPin);

// ---------- 指标 ----------
const cells = results.flatMap((r) => r.attributes);
const filled = cells.filter((a) => a.value);
const bySource: Record<string, number> = {};
for (const a of filled) bySource[a.source] = (bySource[a.source] ?? 0) + 1;
const reqCells = results.reduce((a, r) => a + r.requiredTotal, 0);
const reqFilled = results.reduce((a, r) => a + r.requiredFilled, 0);
const pinChanged = results.filter((r) => r.categoryChanged);
const conflicts = results.filter((r) => r.reviewFlags.some((f) => f.includes("口径冲突")));
const missingPin = results.filter((r) => r.reviewFlags.some((f) => f.includes("品名未收录")));

// 标题命中其他标准品名（疑似错分）的行
const suspicious = results.filter((r) => r.reviewFlags.some((f) => f.startsWith("标题命中其他标准品名")));

const metrics = {
  generatedAt: new Date().toISOString(),
  authority,
  elapsedMs: Date.now() - t0,
  rows: results.length,
  attributesPerRowAvg: +(cells.length / results.length).toFixed(2),
  cells: { total: cells.length, filled: filled.length, fillRate: +(filled.length / cells.length).toFixed(4), bySource },
  required: {
    total: reqCells,
    filled: reqFilled,
    rate: reqCells ? +(reqFilled / reqCells).toFixed(4) : 1,
    rowsFullySatisfied: results.filter((r) => r.requiredFilled === r.requiredTotal).length,
  },
  category: {
    changed: pinChanged.length,
    conflictRows: conflicts.length,
    pinmingNotInCatalog: missingPin.length,
    suspiciousTitleMatches: suspicious.length,
    avgConfidence: +(results.reduce((a, r) => a + r.categoryConfidence, 0) / results.length).toFixed(3),
  },
  reviewQueueRows: emitted.reviewRows,
  attributeCellRows: emitted.attrRows,
};
fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics, null, 2));
