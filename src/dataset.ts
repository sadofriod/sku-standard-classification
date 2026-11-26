/**
 * 数据集解析：把"目录 → 四个输入文件"的约定集中在一处。
 *
 * 目录约定（与客户交付格式一致，也适用于自带样例）：
 *   <root>/待提取商品信息表*.xlsx          —— 待清洗商品（一行一件）
 *   <root>/测试输入/*.jsonl                —— 同批数据（程序输入，按 source_row 对齐）
 *   <root>/分类与03模板/.../02_品名分类汇总.xlsx      —— 品名 → 三级分类 + 分类代码
 *   <root>/分类与03模板/.../03_品名属性表.xlsx        —— 品名 → 属性模板
 *   <root>/分类与03模板/.../1-4级完整最终对照表*.xlsx —— 人工复核后的四级对照
 */
import fs from "node:fs";
import path from "node:path";
import { Ontology } from "./ontology.ts";

export interface DatasetPaths {
  root: string;
  excel: string;
  jsonl: string;
  catalog: string;
  reviewed: string;
  attributes: string;
}

function findOne(dir: string, test: (name: string) => boolean, label: string): string {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (test(e.name)) return p;
    }
  }
  throw new Error(`在 ${dir} 下找不到 ${label}`);
}

export function resolveDataset(root: string): DatasetPaths {
  const excel = findOne(root, (n) => /^待提取商品信息表.*\.xlsx$/.test(n) && !n.startsWith("~$"), "待提取商品信息表*.xlsx");
  const jsonl = findOne(root, (n) => n.endsWith(".jsonl"), "测试输入/*.jsonl");
  const catalog = findOne(root, (n) => n.startsWith("02_品名分类汇总") && n.endsWith(".xlsx"), "02_品名分类汇总.xlsx");
  const reviewed = findOne(root, (n) => n.includes("1-4级完整最终对照表") && n.endsWith(".xlsx"), "1-4级完整最终对照表.xlsx");
  const attributes = findOne(root, (n) => n.startsWith("03_品名属性表") && n.endsWith(".xlsx"), "03_品名属性表.xlsx");
  return { root, excel, jsonl, catalog, reviewed, attributes };
}

export function ontologyFrom(root: string): Ontology {
  const d = resolveDataset(root);
  return new Ontology({ catalog: d.catalog, reviewed: d.reviewed, attributes: d.attributes });
}
