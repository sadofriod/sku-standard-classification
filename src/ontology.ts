/**
 * 本体层：把三张权威表读成可查询的索引，并显式暴露两张权威表之间的冲突。
 *
 * 权威来源：
 *  - catalog  = 02_品名分类汇总.xlsx         （品名 → 大类/中类/小类 + 6 位分类代码）
 *  - reviewed = 1-4级完整最终对照表_复核调整版 （品名 → 调整后 1/2/3 级，人工复核口径）
 *  - attrs    = 03_品名属性表.xlsx           （品名 → 属性定义，含枚举值/单位/必填）
 *
 * 两张分类表并不一致（本批 169 个品名里有 5 个、441 行受影响），所以「分类以谁为准」
 * 必须是显式配置，不能由代码默认决定。
 */
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import type { AttrDef, CategoryPath } from "./types.ts";
import { normalizeText } from "./text.ts";

type Row = Record<string, string>;
const n = (v: unknown) => normalizeText(String(v ?? ""));

export interface OntologyPaths {
  catalog: string;
  reviewed: string;
  attributes: string;
}

export interface PathConflict {
  pinming: string;
  catalogPath: string;
  reviewedPath: string;
  skuRows: number;
}

export class Ontology {
  /** 品名 → catalog 路径（启用优先） */
  readonly catalog = new Map<string, CategoryPath>();
  /** 品名 → reviewed 调整后路径（无分类代码） */
  readonly reviewed = new Map<string, CategoryPath>();
  /** 品名 → 属性定义（仅启用） */
  readonly attrs = new Map<string, AttrDef[]>();
  /** 小类 → 品名集合（社区/候选召回用） */
  readonly pinsByLevel3 = new Map<string, Set<string>>();
  /** 分类代码 → 路径样本 */
  readonly byCode = new Map<string, CategoryPath>();
  /** 两张表口径冲突 */
  readonly conflicts: PathConflict[] = [];
  /** catalog 里被标为停用的品名 */
  readonly retired = new Set<string>();

  constructor(paths: OntologyPaths) {
    this.loadCatalog(paths.catalog);
    this.loadReviewed(paths.reviewed);
    this.loadAttributes(paths.attributes);
    this.detectConflicts();
  }

  private static read(file: string, sheet?: string): Row[] {
    const wb = XLSX.readFile(file);
    return XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheet ?? wb.SheetNames[0]], {
      defval: "",
      raw: false,
    });
  }

  private loadCatalog(file: string) {
    for (const r of Ontology.read(file)) {
      const pin = n(r["商品品名"]);
      if (!pin) continue;
      const p: CategoryPath = {
        level1: n(r["大类"]),
        level2: n(r["中类"]),
        level3: n(r["小类"]),
        level4: pin,
        code: n(r["分类代码"]),
      };
      const enabled = n(r["启停状态"]) === "启用";
      const prev = this.catalog.get(pin);
      if (!prev || enabled) {
        if (prev && !enabled) this.retired.add(pin);
        this.catalog.set(pin, p);
      }
      const key = `${p.level3}|${p.code}`;
      if (!this.byCode.has(key) && p.code) this.byCode.set(key, p);
      if (p.level3) {
        const set = this.pinsByLevel3.get(p.level3) ?? this.pinsByLevel3.set(p.level3, new Set()).get(p.level3)!;
        set.add(pin);
      }
    }
  }

  private loadReviewed(file: string) {
    for (const r of Ontology.read(file)) {
      const pin = n(r["调整后4级（品名）"]);
      if (!pin) continue;
      const p: CategoryPath = {
        level1: n(r["调整后1级（大类）"]),
        level2: n(r["调整后2级（中类）"]),
        level3: n(r["调整后3级（小类）"]),
        level4: pin,
        code: "",
      };
      if (!this.reviewed.has(pin)) this.reviewed.set(pin, p);
    }
  }

  private loadAttributes(file: string) {
    for (const r of Ontology.read(file)) {
      const pin = n(r["品名"]);
      if (!pin) continue;
      if (n(r["启停状态"]) !== "启用") continue;
      const name = n(r["属性名称"]);
      if (!name) continue;
      const def: AttrDef = {
        pinming: pin,
        name,
        attrType: n(r["属性类型"]),
        required: n(r["是否必填"]) === "是",
        fieldType: n(r["字段类型"]),
        unit: n(r["单位"]),
        enumValues: splitEnum(n(r["属性值"])),
        code: n(r["分类代码"]),
      };
      const arr = this.attrs.get(pin) ?? this.attrs.set(pin, []).get(pin)!;
      if (!arr.some((a) => a.name === name)) arr.push(def);
    }
  }

  private detectConflicts() {
    for (const [pin, c] of this.catalog) {
      const r = this.reviewed.get(pin);
      if (!r) continue;
      const a = `${c.level1}/${c.level2}/${c.level3}`;
      const b = `${r.level1}/${r.level2}/${r.level3}`;
      if (a !== b) {
        this.conflicts.push({ pinming: pin, catalogPath: a, reviewedPath: b, skuRows: 0 });
      }
    }
  }

  /** 取最终分类路径。authority=reviewed 时优先复核表，并尽量回填分类代码。 */
  pathFor(pin: string, authority: "catalog" | "reviewed"): CategoryPath | undefined {
    const c = this.catalog.get(pin);
    const r = this.reviewed.get(pin);
    if (authority === "catalog") return c;
    if (!r) return c;
    const code =
      c && `${c.level1}/${c.level2}/${c.level3}` === `${r.level1}/${r.level2}/${r.level3}` ? c.code : "";
    return { ...r, code };
  }

  attrDefs(pin: string): AttrDef[] {
    return this.attrs.get(pin) ?? [];
  }

  /** 同小类的其他品名：图谱里「易混邻居」的候选来源 */
  siblings(pin: string): string[] {
    const c = this.catalog.get(pin);
    if (!c) return [];
    return [...(this.pinsByLevel3.get(c.level3) ?? [])].filter((x) => x !== pin);
  }

  dumpJson(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          counts: {
            catalogPinming: this.catalog.size,
            reviewedPinming: this.reviewed.size,
            pinmingWithAttrs: this.attrs.size,
            attrDefs: [...this.attrs.values()].reduce((a, b) => a + b.length, 0),
            conflicts: this.conflicts.length,
            retired: this.retired.size,
          },
          conflicts: this.conflicts,
        },
        null,
        2,
      ),
    );
  }
}

/** 枚举值分隔符在同一张表里混用（, | / ;），统一拆开去重 */
export function splitEnum(raw: string): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[,，|;；\n]+/)
    .flatMap((p) => (p.includes("/") && !/\d\/\d/.test(p) ? p.split("/") : [p]))
    .map((p) => normalizeText(p))
    .filter(Boolean);
  return [...new Set(parts)];
}
