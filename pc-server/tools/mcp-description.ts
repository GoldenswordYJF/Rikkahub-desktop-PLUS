// tools/mcp-description.ts — MCP 工具 description 长度治理(S8)
//
// 为什么:内置工具最长的 description 约 1000 字,而 MCP 工具原样透传——不少社区
// server 把整段使用手册塞进 description,几十个工具平铺后 prompt 里一半体积是散文。
// 这里给 MCP description 设一个字符上限,超限时保留开头摘要 + 正文里的关键说明
// (IMPORTANT/NOTE/WARNING 与 Always/Never/Must/Do not 之类的强制句),其余截掉并
// 留一个短标记,告诉模型这段说明不完整。
//
// 纪律(与工具面其他开关一致):
//   - 纯函数,无 I/O、无全局状态;只在 openAiMcpTools 声明单源处按开关调用。
//   - 关闭开关时 description 逐字原样(调用方根本不进本模块)。
//   - 上限按字符数(不是字节):中文描述与英文描述对模型上下文的占用不同,但字符
//     上限对所有语言都可预测;体积统计由 S1 脚本按 UTF-8 字节算。

/** MCP description 字符上限(约 375 英文 token);只裁真正超长的说明。 */
export const MCP_DESCRIPTION_MAX_CHARS = 1500;

/** 截断标记:短、确定性、无情绪;模型看到即知说明不完整。 */
const TRUNCATION_MARKER = "\n[…description truncated]";

/** 保留摘要占预算的比例:剩余预算留给正文里的关键说明。 */
const HEAD_RATIO = 0.7;

/** 关键说明句:出现这些词(句首或「标记:」形态)视为模型必须看到的行为约束。 */
const KEY_SENTENCE = /(?:^|\s)(IMPORTANT|WARNING|CAUTION|NOTE)\s*:|^(?:Always|Never|Must|Do not|Don't|Only use|When to use|Before using)\b/i;

export interface McpDescriptionCapResult {
  /** 出线文本;未超限时与入参严格相同。 */
  text: string;
  originalChars: number;
  finalChars: number;
  truncated: boolean;
}

/** 切在自然边界,但不要为了边界把摘要砍掉大半。 */
function cutAtBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget);
  const boundary = Math.max(
    head.lastIndexOf("\n\n"),
    head.lastIndexOf(". "),
    head.lastIndexOf("。"),
    head.lastIndexOf("\n"),
    head.lastIndexOf(" "),
  );
  if (boundary >= Math.floor(budget * 0.4)) {
    // 空格边界不带空格;其他边界带上标点/换行。
    return boundary > 0 && head[boundary] === " " ? head.slice(0, boundary) : head.slice(0, boundary + 1);
  }
  return head;
}

/** 从被截掉的正文里挑出关键说明句(按原顺序,去重,受剩余预算约束)。 */
function extractKeySentences(rest: string, budget: number): string {
  if (budget <= 0) return "";
  const kept: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  // 句子切分:句末标点后的空白 / 换行。保留原句,不重写。
  for (const rawSentence of rest.split(/(?<=[.!?。！？])\s+|\n+/)) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    // Markdown 粗体/标题/列表符号不参与关键词判断(NOTE、**NOTE**、- NOTE 等价)。
    const normalized = sentence
      .replace(/[*_`#>]/g, "")
      .replace(/^\s*(?:[-+•]|\d+[.)])\s*/, "");
    if (!KEY_SENTENCE.test(normalized)) continue;
    // 只留首行:关键标记之后的细节清单通常很长,首句足以让模型知道约束存在。
    const line = sentence.split("\n", 1)[0]!.trim();
    if (!line || seen.has(line)) continue;
    if (used + line.length + 1 > budget) continue;
    seen.add(line);
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

/**
 * MCP description 裁剪:超限时 = 开头摘要(70% 预算,自然边界) + 关键说明句 + 标记。
 * 输出长度恒 ≤ maxChars;未超限时 text === raw(引用同一字符串)。
 */
export function capMcpToolDescription(raw: string, maxChars: number = MCP_DESCRIPTION_MAX_CHARS): McpDescriptionCapResult {
  const originalChars = raw.length;
  if (originalChars <= maxChars) {
    return { text: raw, originalChars, finalChars: originalChars, truncated: false };
  }
  // 上限连标记都放不下:直接硬切,绝不让标记把输出撑过上限。
  if (maxChars <= TRUNCATION_MARKER.length) {
    const text = raw.slice(0, Math.max(0, maxChars));
    return { text, originalChars, finalChars: text.length, truncated: true };
  }
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  const headBudget = Math.floor(budget * HEAD_RATIO);
  let head = cutAtBoundary(raw, headBudget);
  // 先按 70% 摘要 + 剩余预算抽关键句;若剩余预算没用完,把摘要往后延到
  // 第一条被保留关键句之前(不吞掉它们),把上限用满而非浪费。
  let tail = extractKeySentences(raw.slice(head.length), budget - head.length - 1);
  if (tail) {
    const firstKeyIndex = raw.slice(head.length).indexOf(tail.split("\n", 1)[0]!);
    const leftover = budget - head.length - 1 - tail.length;
    if (leftover > 0 && firstKeyIndex > 0) {
      head = cutAtBoundary(raw, head.length + Math.min(leftover, firstKeyIndex));
      tail = extractKeySentences(raw.slice(head.length), budget - head.length - 1);
    }
  } else {
    head = cutAtBoundary(raw, budget);
  }
  const text = tail
    ? `${head.trimEnd()}\n${tail}${TRUNCATION_MARKER}`
    : `${head.trimEnd()}${TRUNCATION_MARKER}`;
  return { text, originalChars, finalChars: text.length, truncated: true };
}
