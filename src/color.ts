/** 严格的颜色识别：避免「易加粉」「墨粉」「碳粉」被当成粉色。 */
const COLORS = ["黑", "白", "红", "蓝", "银", "灰", "绿", "粉", "黄", "紫", "彩"];

export function strictColor(title: string): string | null {
  // 1) 「红色 / 黑色」这种带「色」的写法
  const m1 = title.match(/(黑|白|红|蓝|银|灰|绿|粉|黄|紫|彩)色/);
  if (m1) return `${m1[1]}色`;
  // 2) 括号里的单字，如 (红) （黑）
  const m2 = title.match(/[（(]\s*(黑|白|红|蓝|银|灰|绿|粉|黄|紫|彩)\s*[）)]/);
  if (m2) return `${m2[1]}色`;
  // 3) 被分隔符包围的单字，且前面不是「加/墨/碳/粉」这类会误伤的词
  const re = /(^|[\s，,/、|])(黑|白|红|蓝|银|灰|绿|粉|黄|紫|彩)(?=$|[\s，,/、|])/g;
  for (const m of title.matchAll(re)) return `${m[2]}色`;
  return null;
}

export const isColorAttr = (name: string) => /颜色/.test(name);
export const COLORS_ALL = COLORS;
