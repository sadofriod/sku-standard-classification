#!/usr/bin/env bun
/**
 * 缺口分析：必填缺失的 cell 里，有多少是"标题里有证据但没抽出来"，多少是"标题里真的没有"。
 * 这是决定还能不能继续提覆盖率的关键——有证据的才值得再跑一轮。
 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import { Ontology } from "../src/ontology.ts";
import { readExcel } from "../src/ingest.ts";
import { normalizeText } from "../src/text.ts";

const dataRoot = argv(2) ?? "./data/dataset";
const longPath = argv(3) ?? "./out-final/属性明细_长表.csv";

function argv(i: number) {
  return process.argv[i];
}

const onto = ontologyFrom(dataRoot);
const titleByRow = new Map(readExcel(resolveDataset(dataRoot).excel).map((s) => [s.sourceRow, normalizeText(s.title)]));

function parseCsv(line: string): string[] {
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
}

const lines = fs.readFileSync(longPath, "utf8").replace(/^\uFEFF/, "").split("\n").filter(Boolean);
const h = parseCsv(lines[0]!);
const I = (n: string) => h.indexOf(n);
const iRow = I("原表行号"), iPin = I("品名_标准"), iName = I("属性名称"), iVal = I("属性值"), iReq = I("是否必填"), iType = I("字段类型");

const buckets: Record<string, { total: number; evidence: number; noEvidence: number; samples: string[] }> = {};
let evTotal = 0, noEvTotal = 0;

for (const line of lines.slice(1)) {
  const c = parseCsv(line);
  if (c[iReq] !== "是" || c[iVal]) continue;
  const pin = c[iPin]!, name = c[iName]!, type = c[iType]!;
  const title = titleByRow.get(Number(c[iRow])) ?? "";
  const def = onto.attrDefs(pin).find((d) => d.name === name);

  let evidence = false;
  if (type === "枚举" && def) {
    evidence = def.enumValues.some((v) => v.length >= 2 && title.includes(v));
  } else if (type === "数值") {
    // 标题里有没有数字（任何数字都算弱证据，有单位算强证据）
    evidence = /\d/.test(title) && (!def?.unit || new RegExp(`\\d\\s*${def.unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title));
  } else {
    evidence = false;
  }

  const key = `${pin}｜${name}`;
  const b = (buckets[key] ??= { total: 0, evidence: 0, noEvidence: 0, samples: [] });
  b.total++;
  if (evidence) {
    b.evidence++;
    evTotal++;
    if (b.samples.length < 2) b.samples.push(title.slice(0, 60));
  } else {
    b.noEvidence++;
    noEvTotal++;
  }
}

const top = Object.entries(buckets)
  .map(([k, v]) => ({ key: k, ...v }))
  .sort((a, b) => b.evidence - a.evidence || b.total - a.total)
  .slice(0, 25);

console.log(JSON.stringify({ missingRequiredCells: evTotal + noEvTotal, evidenceExists: evTotal, noEvidence: noEvTotal, top }, null, 1));
await Bun.write("./report/missing-analysis.json", JSON.stringify({ evTotal, noEvTotal, top, all: buckets }, null, 2));
