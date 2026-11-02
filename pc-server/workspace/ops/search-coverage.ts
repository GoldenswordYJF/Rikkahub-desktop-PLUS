// workspace/ops/search-coverage.ts — S5:搜索覆盖可见化(三个兜底工具共用)
//
// 问题:grep/find/ls 的"没找到"既可能是真的没有,也可能是部分范围根本没搜到
// (文件读失败、体积/二进制跳过、遍历安全罩截断)。两者混在同一句话里,模型会把
// "没搜完"当成"不存在"。
//
// 口径(docs/plan-ops-tool-surface.md §4 S5):
// - 范围外排除不算缺口:.gitignore / glob 过滤掉的条目是用户划定的范围,不是缺口;
// - 范围之内没能搜成的算缺口:读失败、二进制、超过单文件上限、遍历安全罩截断;
// - 有缺口时不得给出总数断言("没有匹配"要补一句"这不等于不存在");
// - details 只增不改:计数挂 details.coverage,旧字段名与前端渲染不变;
// - 开关默认关(searchCoverage):关闭时工具输出与历史逐字一致,计数也不采集上报。
//
// 本模块只放纯函数与类型,内核把计数递进来换取尾部文案。

import { state } from "../../persistence/json-store";

export interface SearchCoverage {
  /** 实际进入搜索的条目/文件数(读成功且非二进制/可列出的条目)。 */
  scanned: number;
  /** 二进制跳过(范围之内、按文本搜不了)。 */
  binary: number;
  /** 超过单文件体积上限跳过。 */
  oversized: number;
  /** 读失败/不可列出的条目。 */
  unreadable: number;
  /** 遍历安全罩截断(目录树过大提前停)。 */
  visitCapReached: boolean;
}

/** S5 开关(灰度;默认关)。关闭时工具输出与历史逐字一致。 */
export function searchCoverageEnabled(): boolean {
  return state?.settings?.workspaceTools?.searchCoverage === true;
}

export function emptySearchCoverage(): SearchCoverage {
  return { scanned: 0, binary: 0, oversized: 0, unreadable: 0, visitCapReached: false };
}

export function hasSearchGaps(coverage: SearchCoverage): boolean {
  return coverage.binary > 0 || coverage.oversized > 0 || coverage.unreadable > 0 || coverage.visitCapReached;
}

type CoverageNoun = "file" | "entry";

function plural(count: number, noun: CoverageNoun): string {
  return count === 1 ? noun : `${noun}s`;
}

/** "1 binary file, 2 over the 512KB limit, 3 unreadable" 之类的缺口清单(无缺口返回空数组)。 */
function notSearchedParts(coverage: SearchCoverage, options: { noun: CoverageNoun; sizeLabel: string }): string[] {
  const parts: string[] = [];
  if (coverage.binary > 0) parts.push(`${coverage.binary} binary ${plural(coverage.binary, options.noun)}`);
  if (coverage.oversized > 0) parts.push(`${coverage.oversized} over the ${options.sizeLabel} limit`);
  if (coverage.unreadable > 0) parts.push(`${coverage.unreadable} unreadable`);
  if (coverage.visitCapReached) parts.push("directory traversal stopped at the visit cap");
  return parts;
}

/** 有缺口时追加到结果尾部的覆盖说明;无缺口返回 null(不打扰正常结果)。 */
export function searchCoverageNotice(
  coverage: SearchCoverage,
  options: { noun: CoverageNoun; sizeLabel: string },
): string | null {
  if (!hasSearchGaps(coverage)) return null;
  const notSearched = notSearchedParts(coverage, options).join(", ");
  return (
    `[Coverage: searched ${coverage.scanned} ${plural(coverage.scanned, options.noun)}; not searched: ${notSearched}. `
    + "Results may be incomplete — narrow the path or inspect the skipped entries directly.]"
  );
}

/** 零结果文案:有缺口时补上覆盖说明,明确"没找到"不等于"不存在"。 */
export function noResultWithCoverage(
  base: string,
  coverage: SearchCoverage,
  options: { noun: CoverageNoun; sizeLabel: string },
): string {
  if (!hasSearchGaps(coverage)) return base;
  const notSearched = notSearchedParts(coverage, options).join(", ");
  return (
    `${base} (searched ${coverage.scanned} ${plural(coverage.scanned, options.noun)}; not searched: ${notSearched} — `
    + "this is not proof of absence)"
  );
}

/** 工具 description 追加句(开关开启时由内核拼进 description;关闭时不出现)。 */
export function searchCoverageDescriptionAppend(noun: CoverageNoun): string {
  return (
    `\nCoverage reporting is on: ${noun}s excluded by scope filters (.gitignore/glob) are not counted as gaps, `
    + `while in-scope ${noun}s that could not be searched (read failures, binary/size limits, visit cap) are reported `
    + "in a trailing [Coverage: ...] line, and empty results say so instead of claiming absence."
  );
}
