/** 输出层：交付 CSV（人看/入库）+ 复核队列 + 指标。列契约在 docs/architecture.md 里固定。 */
import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import type { SkuInput, SkuResult } from "./types.ts";

export function writeCsv(file: string, header: string[], rows: (string | number)[][]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify([header, ...rows], { bom: true }), "utf8");
}

export const RESULT_HEADER = [
  "原表行号",
  "商品品名_输入",
  "品名_标准",
  "大类",
  "中类",
  "小类",
  "分类代码",
  "分类来源",
  "分类是否变更",
  "分类置信度",
  "分类依据",
  "属性数",
  "必填总数",
  "必填已填",
  "必填覆盖率",
  "复核标记",
  "属性JSON",
];

export const ATTR_HEADER = [
  "原表行号",
  "品名_标准",
  "属性名称",
  "属性值",
  "来源",
  "置信度",
  "校验通过",
  "是否必填",
  "字段类型",
  "单位",
  "备注",
];

export const REVIEW_HEADER = ["原表行号", "品名_输入", "品名_标准", "复核原因", "缺失必填属性", "商品标题"];

export function emit(outDir: string, inputs: Map<number, SkuInput>, results: SkuResult[], defs: Map<string, { name: string; required: boolean; fieldType: string; unit: string }[]>) {
  writeCsv(
    `${outDir}/results.csv`,
    RESULT_HEADER,
    results.map((r) => [
      r.sourceRow,
      r.inputPinming,
      r.finalPinming,
      r.path.level1,
      r.path.level2,
      r.path.level3,
      r.path.code,
      r.categorySource,
      r.categoryChanged ? "是" : "否",
      r.categoryConfidence.toFixed(2),
      r.categoryEvidence,
      r.attributes.length,
      r.requiredTotal,
      r.requiredFilled,
      r.requiredTotal ? (r.requiredFilled / r.requiredTotal).toFixed(3) : "1.000",
      r.reviewFlags.join("; "),
      JSON.stringify(Object.fromEntries(r.attributes.filter((a) => a.value).map((a) => [a.name, a.value]))),
    ]),
  );

  const attrRows: (string | number)[][] = [];
  for (const r of results) {
    for (const a of r.attributes) {
      const d = defs.get(r.finalPinming)?.find((x) => x.name === a.name);
      attrRows.push([
        r.sourceRow,
        r.finalPinming,
        a.name,
        a.value,
        a.source,
        a.confidence.toFixed(2),
        a.valid ? "是" : "否",
        d?.required ? "是" : "否",
        d?.fieldType ?? "",
        d?.unit ?? "",
        a.note ?? "",
      ]);
    }
  }
  writeCsv(`${outDir}/attributes_long.csv`, ATTR_HEADER, attrRows);

  const review: (string | number)[][] = [];
  for (const r of results) {
    const missingRequired = r.attributes.filter((a) => !a.value && defs.get(r.finalPinming)?.find((d) => d.name === a.name)?.required);
    const reasons: string[] = [];
    if (r.reviewFlags.length) reasons.push(...r.reviewFlags);
    if (missingRequired.length) reasons.push(`必填缺失 ${missingRequired.length} 项`);
    if (r.categoryConfidence < 0.7) reasons.push(`分类置信度 ${r.categoryConfidence.toFixed(2)}`);
    if (!reasons.length) continue;
    review.push([
      r.sourceRow,
      r.inputPinming,
      r.finalPinming,
      reasons.join("; "),
      missingRequired.map((a) => a.name).join("|"),
      inputs.get(r.sourceRow)?.title ?? "",
    ]);
  }
  writeCsv(`${outDir}/review_queue.csv`, REVIEW_HEADER, review);
  return { attrRows: attrRows.length, reviewRows: review.length };
}
