// FE-P1-2:线上契约 DTO 单源——本文件只做 type-only re-export,权威声明在
// pc-server/foundation/types/dto.ts(后端 DTO 生成函数已标注返回类型做编译期契约校验)。
// 字段增删属冻结契约变更,必须两端同评审。
export type {
  AppErrorDto,
  AppErrorPushEventDto,
  AppErrorSnapshotEventDto,
  ConversationDto,
  ConversationErrorEventDto,
  ConversationListDto,
  ConversationListInvalidateEventDto,
  ConversationNodesPageDto,
  ConversationNodeUpdateEventDto,
  ConversationSnapshotEventDto,
  ConversationSnapshotMetaEventDto,
  ConversationTextDeltaEventDto,
  EngineStatusEventDto,
  ExtractionStatusDto,
  McpFailureKindDto,
  McpHealthEntryDto,
  McpHealthSnapshotDto,
  MessageDto,
  MessageNodeDto,
  MessageQueueItemDto,
  MessageQueueSnapshotDto,
  MessageSearchResultDto,
  PagedResult,
  UploadedFileDto,
  UploadFilesResponseDto,
  WorkspaceDto,
} from "@server/foundation/types/dto";

// 自主循环(S1):运行记录契约。权威声明在 pc-server/agent-loop/types.ts(PC-only,
// 不进 foundation 跨端域),前端 type-only 复用,不手写镜像。
export type {
  AgentRunEventDto,
  AgentRunEventKind,
  AgentRunEventPageDto,
  AgentRunListDto,
  AgentRunPhase,
  AgentRunPushDto,
  AgentRunSnapshotDto,
  AgentRunStatus,
  AgentRunSummary,
  RunBoundarySnapshotDto,
  RunPlanProjectionDto,
  RunPlanToolLocationDto,
  RunPlanUnavailableReason,
  RunProjectionDto,
} from "@server/agent-loop/types";
// 生命周期 L2:恢复判定 DTO(服务端算,前端只展示,不自行推断可恢复性)。
// 与其余 run DTO 同源:必须从纯类型模块引入,否则会把 bun 运行时依赖带进前端图。
export type {
  AgentRunRecoveryDto,
  AgentRunResumeMode,
  RunCheckpointDto,
} from "@server/agent-loop/types";
