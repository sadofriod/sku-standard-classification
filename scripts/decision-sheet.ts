#!/usr/bin/env bun
/** 待裁定清单：把 441 行口径冲突压成「品名 → 两个候选路径 + 影响行数」，让业务一次拍板。 */
import { ontologyFrom } from "../src/dataset.ts";
import { resolveDataset } from "../src/dataset.ts";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import { Ontology } from "../src/ontology.ts";
import { readExcel } from "../src/ingest.ts";

const dataRoot = process.argv[2] ?? "./data/dataset";
const outDir = process.argv[3] ?? "./out-final";
const onto = ontologyFrom(dataRoot);
const skus = readExcel(resolveDataset(dataRoot).excel);

const counts = new Map<string, number>();
for (const s of skus) counts.set(s.pinming, (counts.get(s.pinming) ?? 0) + 1);

const rows = onto.conflicts
  .filter((c) => counts.has(c.pinming))
  .map((c) => {
    const cat = onto.catalog.get(c.pinming)!;
    const rev = onto.reviewed.get(c.pinming)!;
    return [
      c.pinming,
      counts.get(c.pinming)!,
      `${cat.level1} / ${cat.level2} / ${cat.level3}`,
      cat.code,
      `${rev.level1} / ${rev.level2} / ${rev.level3}`,
      "待裁定",
      "选 02 表 / 选复核表 / 其他",
    ];
  })
  .sort((a, b) => Number(b[1]) - Number(a[1]));

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "待裁定_口径冲突.csv"),
  stringify(
    [
      ["品名", "影响行数", "02_品名分类汇总路径", "02_分类代码", "1-4级复核表路径", "状态", "业务裁定"],
      ...rows,
    ],
    { bom: true },
  ),
  "utf8",
);
console.log(JSON.stringify({ pins: rows.length, affectedRows: rows.reduce((a, r) => a + Number(r[1]), 0) }));
