/** 文本归一化：全角/半角、HTML 实体、空白、单位与规格解析。 */

const FULLWIDTH_MAP: Record<string, string> = {
  "（": "(", "）": ")", "：": ":", "，": ",", "；": ";", "／": "/", "　": " ",
  "－": "-", "～": "~", "．": ".", "、": "/",
};

export function normalizeText(s: string): string {
  if (!s) return "";
  let out = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[\u3000]/g, " ");
  out = [...out].map((ch) => FULLWIDTH_MAP[ch] ?? ch).join("");
  return out.replace(/\s+/g, " ").trim();
}

/** 品牌：中文品牌名 + 英文后缀，如「得力DELI」→ { zh: "得力", en: "DELI" } */
export function splitBrand(raw: string): { zh: string; en: string } {
  const s = normalizeText(raw);
  const m = s.match(/^([\u4e00-\u9fa5（）()·]+)\s*([A-Za-z][A-Za-z0-9\-. ]*)?$/);
  if (m) return { zh: m[1].trim(), en: (m[2] ?? "").trim() };
  const letters = s.match(/[A-Za-z][A-Za-z0-9\-. ]*/);
  const zh = s.replace(/[A-Za-z][A-Za-z0-9\-. ]*/g, "").trim();
  return { zh: zh || s, en: letters ? letters[0].trim() : "" };
}

/** 制造商型号清洗：实体、空格分隔，如「50ml&nbsp;680」→「50ml 680」 */
export function cleanModel(raw: string): string {
  return normalizeText(raw).replace(/\s+/g, " ").trim();
}

/** 从标题里抓规格：数值 + 单位（mm / cm / ml / g / kg / 页 / 只 / 支 / 卷 / m 等） */
export const SPEC_RE =
  /(\d+(?:\.\d+)?)\s*(mm|cm|m|ml|l|g|kg|页|张|只|支|卷|个|片|抽|米|升|克|瓦|w|v|a|mah|芯)/gi;

export function specsInTitle(title: string): { value: string; unit: string }[] {
  const out: { value: string; unit: string }[] = [];
  for (const m of normalizeText(title).matchAll(SPEC_RE)) {
    out.push({ value: m[1], unit: m[2].toLowerCase() });
  }
  return out;
}

/** 标题中的「N 只/包」「48只/筒」等包装数量 */
export const PACK_RE = /(\d+)\s*(只|个|支|片|张|卷|包|筒|盒|瓶|套|袋)\s*(?:\/|每)\s*(只|个|支|片|张|卷|包|筒|盒|瓶|套|袋)?/g;

export function packInfo(title: string): { count: string; inner: string; outer: string } | null {
  const t = normalizeText(title);
  const m = [...t.matchAll(PACK_RE)].pop();
  if (!m) return null;
  return { count: m[1], inner: m[2], outer: m[3] ?? "" };
}

/** 单位归一：把标题/单位列里的同义单位收敛到模板单位 */
export const UNIT_ALIASES: Record<string, string> = {
  毫升: "ml", 升: "l", 克: "g", 千克: "kg", 毫米: "mm", 厘米: "cm", 米: "m",
  页: "页", 张: "张", 只: "只", 支: "支", 卷: "卷", 个: "个", 套: "套", 盒: "盒",
  包: "包", 瓶: "瓶", 筒: "筒", 袋: "袋", 瓦: "w", 伏: "v",
};

export function canonUnit(u: string): string {
  const s = normalizeText(u).toLowerCase().replace(/\s+/g, "");
  return UNIT_ALIASES[s] ?? s;
}
