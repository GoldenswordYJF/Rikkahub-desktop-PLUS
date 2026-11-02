// workspace/writable-dirs.ts — 沙盒额外可写目录（用户显式声明的例外）
//
// 受限档下低完整性后端只能写数据目录与工作区；本地 MCP 服务器的数据目录
// （如向量库）、技能调用的外部工具目录都在边界外，内核一律拒绝写入。
// 本模块只做两件事：收集声明（全局列表 + 每个 stdio MCP 服务器自己的列表）与
// 规范化校验；真正的 icacls 标注由 labeling.ts 在启动编排（Medium 准备进程）里完成。
//
// 硬约束：运行中的后端是 Low 进程，无权给自己扩权——所以声明只在下次重启生效
// （与受限沙盒开关同款语义）。这不是实现偷懒，而是沙盒能成立的前提。
//
// 安全纪律：
//   - 只接受 Windows 绝对路径（盘符或 UNC）；相对路径会随进程 cwd 漂移，不能作为边界。
//   - 拒绝盘符根目录、系统目录、用户家目录根及其父目录——把 C:\ 标成 Low 等于沙盒失效，
//     这类"脚滑"必须挡在保存前；更深的子目录（如 D:\tools\data）正常放行。
//   - 去重按大小写不敏感（Windows 路径语义），保留用户输入的大小写形态。

import { resolve } from "node:path";

export interface NormalizedWritableDirs {
  /** 规范化后的绝对路径（去重、去尾部分隔符） */
  dirs: string[];
  /** 被拒绝的原始输入（相对路径 / 危险根目录），调用方决定报错还是忽略 */
  invalid: string[];
}

function stripTrailingSeparators(dir: string): string {
  return dir.replace(/[\\/]+$/, "");
}

function isAbsoluteWindowsPath(dir: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dir) || /^\\\\[^\\]+\\[^\\]+/.test(dir);
}

/** 与某个受保护根相同、或是它的上级目录 → 拒绝（下级子目录允许）。 */
function isRootOrAncestor(dir: string, protectedRoot: string | undefined): boolean {
  if (!protectedRoot) return false;
  const d = stripTrailingSeparators(dir).toLowerCase();
  const root = stripTrailingSeparators(protectedRoot).toLowerCase();
  return d === root || root.startsWith(`${d}\\`) || root.startsWith(`${d}/`);
}

/** 返回拒绝原因；null = 允许。环境变量缺失时跳过对应比较（不误杀）。 */
export function rejectWritableDirReason(dir: string): string | null {
  if (!isAbsoluteWindowsPath(dir)) return "must be an absolute Windows path";
  // 盘符根目录（C:\、D:/）——整盘可写 = 沙盒名存实亡。
  if (/^[A-Za-z]:[\\/]*$/.test(dir)) return "drive root is not allowed";
  const protectedRoots = [
    process.env.SystemRoot,
    process.env.windir,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    process.env.USERPROFILE,
    // 用户目录的上级（C:\Users）同样过宽。
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, "..") : undefined,
  ];
  for (const root of protectedRoots) {
    if (isRootOrAncestor(dir, root)) return "system or user root is not allowed";
  }
  return null;
}

/** 规范化一组目录声明。非 Windows 平台返回空（容器边界由挂载表决定，标签机制不适用）。 */
export function normalizeSandboxWritableDirs(raw: unknown): NormalizedWritableDirs {
  if (process.platform !== "win32") return { dirs: [], invalid: [] };
  const list = Array.isArray(raw) ? raw : [];
  const dirs: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    // 用户常直接粘贴带引号的路径（资源管理器"复制为路径"）。
    const trimmed = item.trim().replace(/^"(.*)"$/, "$1").trim();
    if (!trimmed) continue;
    // 先校验原始输入：resolve() 会把相对路径悄悄拼成 cwd 下的绝对路径，
    // 若先解析就再也拦不住"相对路径"这类声明（cwd 随启动方式漂移，不能作为边界）。
    const resolved = resolve(stripTrailingSeparators(trimmed));
    if (rejectWritableDirReason(trimmed) || rejectWritableDirReason(resolved)) {
      invalid.push(item.trim());
      continue;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(resolved);
  }
  return { dirs, invalid };
}

/** 从设置快照中收集所有声明目录：全局列表 + 每个 stdio MCP 服务器自己的列表。
 *  入参是 state.json 里的裸 JSON（启动窥探与已装载的 settings 都适用），
 *  任何字段缺失/类型不对都按空列表处理。 */
export function collectDeclaredWritableDirs(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const root = settings as Record<string, unknown>;
  const raw: unknown[] = [];
  if (Array.isArray(root.sandboxExtraWritableDirs)) {
    raw.push(...root.sandboxExtraWritableDirs);
  }
  if (Array.isArray(root.mcpServers)) {
    for (const server of root.mcpServers) {
      if (!server || typeof server !== "object") continue;
      const entry = server as Record<string, unknown>;
      if (String(entry.type ?? "") !== "stdio") continue;
      if (Array.isArray(entry.sandboxWritableDirs)) raw.push(...entry.sandboxWritableDirs);
    }
  }
  return normalizeSandboxWritableDirs(raw).dirs;
}
