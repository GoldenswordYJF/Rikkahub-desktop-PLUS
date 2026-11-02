// agent-loop/halt.ts — 判定表终局的传输载具(S3)
//
// 为什么用异常:聊天引擎的工具循环骨架以 return 表示"答完",以 throw 表示"异常收尾"。
// 判定表要表达的是第三种:生成正常停下,但不是成功,也不是上游失败。用一个带
// status/reason 的类型化错误穿过骨架,协调器按类型识别后走"保留计划与进度、交给
// 人处理"的收尾路径(不弹请求失败、不报告供应商错误)。
//
// 纪律:只有判定表与骨架允许构造它;协调器只在 catch 里识别,不从异常里猜语义
// (status 是显式字段,不解析 message)。

export type AgentLoopHaltStatus = "stalled" | "awaiting_user" | "exhausted" | "failed";

export class AgentLoopHaltError extends Error {
  readonly status: AgentLoopHaltStatus;
  /** 给人看的停滞/耗尽原因(进运行记录与消息注解)。 */
  readonly reason: string;

  constructor(status: AgentLoopHaltStatus, reason: string) {
    super(reason);
    this.name = "AgentLoopHaltError";
    this.status = status;
    this.reason = reason;
  }

  /** 跨模块识别(instanceof 在热重载/双实例下不可靠,名字 + 字段双重校验)。 */
  static is(err: unknown): err is AgentLoopHaltError {
    return (
      err instanceof Error &&
      err.name === "AgentLoopHaltError" &&
      typeof (err as { status?: unknown }).status === "string" &&
      typeof (err as { reason?: unknown }).reason === "string"
    );
  }
}

/** 判定表终局 → 运行记录状态。awaiting_user 只是相位,记录上仍是 stalled。 */
export function runStatusForHalt(status: AgentLoopHaltStatus): "stalled" | "exhausted" | "failed" {
  return status === "awaiting_user" ? "stalled" : status;
}
