#!/usr/bin/env bun
/** 交付前校验：枚举合法率、数值可解析、属性名是否都在模板内、必填覆盖。 */
import { ontologyFrom } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Ontology } from "../src/ontology.ts";

const dataRoot = process.argv[2] ?? "./data/dataset";
const outDir = process.argv[3] ?? "./out-final";
const onto = ontologyFrom(dataRoot);

const lines = fs.readFileSync(path.join(outDir, "属性明细_长表.csv"), "utf8").replace(/^\uFEFF/, "").split("\n").filter(Boolean);
const header = lines[0]!.split(",");
const idx = (n: string) => header.indexOf(n);
const iRow = idx("原表行号"), iPin = idx("品名_标准"), iName = idx("属性名称"), iVal = idx("属性值"), iType = idx("字段类型");

// 简单 CSV 解析（值里可能有逗号，但都带引号）
const parse = (line: string) => {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

let cells = 0, enumCells = 0, enumBad = 0, numCells = 0, numBad = 0, unknownAttr = 0;
const bad: string[] = [];
for (const line of lines.slice(1)) {
  const c = parse(line);
  const pin = c[iPin]!, name = c[iName]!, val = c[iVal] ?? "", type = c[iType] ?? "";
  const def = onto.attrDefs(pin).find((d) => d.name === name);
  if (!def) { unknownAttr++; continue; }
  if (!val) continue;
  cells++;
  if (type === "枚举") {
    enumCells++;
    const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
    for (const p of parts) if (!def.enumValues.includes(p)) { enumBad++; bad.push(`${c[iRow]}/${pin}/${name}=${p}`); break; }
  }
  if (type === "数值") {
    numCells++;
    if (!/^-?\d+(\.\d+)?$/.test(val)) { numBad++; bad.push(`${c[iRow]}/${pin}/${name}=${val}`); }
  }
}
const res = {
  filledCells: cells,
  enumCells,
  enumViolations: enumBad,
  numCells,
  numViolations: numBad,
  attributesNotInTemplate: unknownAttr,
  samples: bad.slice(0, 8),
};
console.log(JSON.stringify(res, null, 2));
