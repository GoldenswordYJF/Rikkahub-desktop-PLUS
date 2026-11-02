// workspace/ops/revision.ts — 文件 revision(内容版本)单源
//
// 与文件面板编辑态的 etag 同一算法:SHA-256(字节)前 32 hex。read 契约里回灌给模型
// 的 revision 与侧边栏编辑冲突检测的 etag 因而可直接对照——模型持有旧 revision 提交
// 编辑时,服务端用同一函数算出当前值即可判定冲突(S3)。
// 单源纪律:files.ts 原先内联的私有实现改为从这里导入,禁止再复制第三份。

import { createHash } from "node:crypto";

export function sha256Short(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}
