/**
 * 属性抽取层：模板约束优先（03 表），证据其次，猜测最后且必须被标记。
 *
 * 设计原则（这条是业务红线）：
 *  - 模板没定义的属性一律不输出（避免幻觉属性）；
 *  - 枚举属性只能取模板给出的候选值，取不到就判缺失；
 *  - 数值属性必须能解析出数字，否则判缺失；
 *  - 「缺失」是合法结果，进复核队列，不允许用同义猜测填充必填位。
 */
import type { AttrDef, AttrValue, SkuInput } from "./types.ts";
import { canonUnit, normalizeText, packInfo, splitBrand } from "./text.ts";
import { strictColor } from "./color.ts";

const COLUMN_SOURCES: Record<string, (s: SkuInput) => string> = {
  产品名称: (s) => s.productName || s.pinming,
  商品名称: (s) => s.productName || s.pinming,
  品牌: (s) => splitBrand(s.brandRaw).zh || s.brandRaw,
  制造商型号: (s) => s.modelRaw,
  型号: (s) => s.modelRaw,
  适用机型: () => "",
};

/** 「属性名 → 标题关键词 → 枚举/文本值」的确定性规则；只覆盖高频品名 */
const KEYWORD_RULES: { attr: RegExp; pick: (t: string, s: SkuInput) => string | null }[] = [
  {
    attr: /^是否带芯片$/,
    pick: (t) => (/不带芯片|无芯片/.test(t) ? "不带芯片" : /带芯片|有芯片|芯片/.test(t) ? "带芯片" : null),
  },
  { attr: /^类型$/, pick: (t) => (/原装/.test(t) ? "原装耗材" : /通用|兼容/.test(t) ? "通用耗材" : null) },
  {
    attr: /^规格$/,
    pick: (t) =>
      /超大容量/.test(t) ? "超大容量"
      : /高容量|大容量/.test(t) ? "高容量"
      : /低容量/.test(t) ? "低容量"
      : /套装/.test(t) ? "套装"
      : /标准容量|标准/.test(t) ? "标准容量"
      : null,
  },
  {
    attr: /^类别$/,
    pick: (t) =>
      /一体式硒鼓/.test(t) ? "一体式硒鼓"
      : /成像鼓|感光鼓/.test(t) ? "成像鼓"
      : /粉仓|粉盒/.test(t) ? "粉盒/粉仓"
      : /碳粉|墨粉/.test(t) ? "碳粉"
      : null,
  },
  { attr: /^是否可加粉$/, pick: (t) => (/可加粉|加粉/.test(t) ? "是" : /不可加粉|原装/.test(t) ? "否" : null) },
  {
    attr: /^闭合方式$/,
    pick: (t) => (/按动/.test(t) ? "按动" : /拔帽/.test(t) ? "拔帽" : /旋转/.test(t) ? "旋转" : null),
  },
  {
    attr: /^基础功能$/,
    pick: (t) =>
      ["复印", "打印", "扫描", "传真"].filter((k) => t.includes(k)).join(",") || null,
  },
  { attr: /^(打印功能|双面)$/, pick: (t) => (/自动双面|双面/.test(t) ? "自动双面" : /非自动双面|单面/.test(t) ? "非自动双面" : null) },
  { attr: /^最大支持幅面$/, pick: (t) => (/\bA3\b/i.test(t) ? "A3" : /\bA4\b/i.test(t) ? "A4" : /\bA2\b/i.test(t) ? "A2" : null) },
  { attr: /^包装形式$/, pick: (t) => (/盒装/.test(t) ? "盒装" : /袋装/.test(t) ? "袋装" : /套装/.test(t) ? "套装" : null) },
  { attr: /^(颜色|笔芯颜色)$/, pick: (t) => colorOf(t) },
];

const COLORS = ["黑色", "黑", "白色", "白", "红色", "红", "蓝色", "蓝", "银色", "银", "灰色", "灰", "绿色", "绿", "粉色", "粉", "彩色", "彩"];

function colorOf(t: string): string | null {
  return strictColor(normalizeText(t));
}

export interface ExtractOptions {
  /** 是否允许把模板里的枚举值当兜底（默认否，必须标题里有证据） */
  enumFromTitleOnly?: boolean;
}

export class AttributeExtractor {
  constructor(private readonly opts: ExtractOptions = {}) {}

  extract(sku: SkuInput, defs: AttrDef[]): AttrValue[] {
    const title = normalizeText(sku.title);
    const pack = packInfo(sku.title);
    return defs.map((def) => this.one(def, sku, title, pack));
  }

  private one(def: AttrDef, sku: SkuInput, title: string, pack: ReturnType<typeof packInfo>): AttrValue {
    const col = COLUMN_SOURCES[def.name];
    if (col) {
      const v = col(sku);
      if (v) return { name: def.name, value: v, source: "column", confidence: 1, valid: true };
    }

    // 枚举：先看关键词规则，再退回「枚举值直接出现在标题里」
    if (def.fieldType === "枚举") {
      const rule = KEYWORD_RULES.find((r) => r.attr.test(def.name));
      const guess = rule?.pick(title, sku) ?? null;
      if (guess) {
        const canons = guess.split(",").map((g) => this.canonEnum(def, g)).filter(Boolean) as string[];
        if (canons.length) {
          const v = canons.join(",");
          return { name: def.name, value: v, source: "title", confidence: rule ? 0.8 : 0.7, valid: this.validateEnum(def, v) };
        }
      }
      const direct = this.enumInText(def, title);
      if (direct) return { name: def.name, value: direct, source: "title", confidence: 0.9, valid: true };
      return missing(def);
    }

    // 数值：必须带模板单位，否则不接受
    if (def.fieldType === "数值") {
      const unit = canonUnit(def.unit);
      if (unit) {
        const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${escapeRe(unit)}\\b`, "i");
        const m = title.match(re) ?? title.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${escapeRe(def.unit)}`));
        if (m) return { name: def.name, value: m[1], source: "title", confidence: 0.75, valid: true };
      }
      if (/数量/.test(def.name) && pack) {
        return { name: def.name, value: pack.count, source: "title", confidence: 0.7, valid: true };
      }
      return missing(def);
    }

    // 文本：数量类可从包装推断，其余留缺失
    if (/^数量$/.test(def.name)) {
      const v = pack ? `${pack.count}${pack.inner}` : sku.unit || "";
      if (v) return { name: def.name, value: v, source: "title", confidence: 0.7, valid: true };
    }
    if (/^包装清单$/.test(def.name) && pack) {
      return {
        name: def.name,
        value: `${pack.count}${pack.inner}${pack.outer ? "/" + pack.outer : ""}`,
        source: "title",
        confidence: 0.7,
        valid: true,
      };
    }
    if (/^颜色$/.test(def.name)) {
      const c = colorOf(title);
      if (c) return { name: def.name, value: c, source: "title", confidence: 0.8, valid: true };
    }
    return missing(def);
  }

  private canonEnum(def: AttrDef, raw: string): string | null {
    const v = normalizeText(raw);
    if (!v) return null;
    const exact = def.enumValues.find((e) => e === v);
    if (exact) return exact;
    const loose = def.enumValues.find((e) => e.replace(/\s/g, "") === v.replace(/\s/g, ""));
    if (loose) return loose;
    const contains = def.enumValues
      .filter((e) => e.length >= 2 && (v.includes(e) || e.includes(v)))
      .sort((a, b) => b.length - a.length)[0];
    return contains ?? null;
  }

  private enumInText(def: AttrDef, title: string): string | null {
    const hits = def.enumValues
      .filter((v) => v.length >= 2 && title.includes(v))
      .sort((a, b) => b.length - a.length);
    return hits[0] ?? null;
  }

  private validateEnum(def: AttrDef, value: string): boolean {
    const parts = value.split(",").map((s) => s.trim());
    return parts.every((p) => def.enumValues.some((e) => e === p));
  }
}

function missing(def: AttrDef): AttrValue {
  return {
    name: def.name,
    value: "",
    source: "missing",
    confidence: 0,
    valid: false,
    note: def.required ? "必填缺失，需人工补齐" : "无证据",
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
