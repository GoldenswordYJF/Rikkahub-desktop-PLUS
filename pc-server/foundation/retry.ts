// foundation/retry.ts — 通用重试原语(台账 §4.3)
// 纪律:纯函数,不读业务状态;供「按 HTTP 语义区分可重试错」的出站请求复用。
//
// 缘起 TTS 稳定性(对齐 Android TtsController.synthesizeWithRetry + TTSProviderException),
// 但判据/退避写成领域无关的原语——任何「400/401 不该重试、408/429/5xx/网络瞬断该重试」
// 的出站调用都能用(TTS/ASR/搜索/生图……)。本模块不擅自给 LLM 流式主链路加重试
// (那会破坏 streaming),只服务这些「一次性请求/响应」的外围域。
//
// 计时纪律:退避用 setTimeout 延迟,尊重调用方 AbortSignal——外层看门狗
// (fetchWithTimeout 的 combined signal)一 abort,等待立即以 AbortError 收尾,
// 不会把已取消的请求拖着重试。
// 退避形状可由 delayFor 覆盖(消费方按 Retry-After 决定等待);不提供时仍是纯指数
// 序列,既有调用方行为逐字不变。

/** 可重试判定常量:408 请求超时 / 429 限流 / 5xx 服务端抖动。其余(400/401/403…)视为
 *  确定性错误,重试无意义,立即抛出。对齐 Android TTSProviderException.isRetryable。 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** 一次 HTTP 出站拿到的非 2xx。保留状态码供上层判断是否值得重试。
 *  (对齐 Android TTSProviderException:message + statusCode + isRetryable。) */
export class RetryableHttpError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableHttpError";
    this.statusCode = statusCode;
  }
  get isRetryable(): boolean {
    return isRetryableHttpStatus(this.statusCode);
  }
}

/** 默认判据:网络层瞬断(fetch reject 的非 HTTP 错误)一律可重试;HTTP 错误按其状态码。 */
export function isRetryableHttpError(err: unknown): boolean {
  if (err instanceof RetryableHttpError) return err.isRetryable;
  // 无 statusCode 的错误(fetch failed / ECONNRESET / 黑洞路由超时等)视作瞬态网络问题。
  return true;
}

export interface RetryOptions {
  /** 最大尝试次数(含首次)。默认 3 = 首次 + 2 次退避重试,对齐 Android MAX_SYNTHESIS_ATTEMPTS。 */
  maxAttempts?: number;
  /** 退避基数 ms。第 n 次重试前等 baseMs * 2^(n-1):500 → 1000 → 2000…默认 500。 */
  baseDelayMs?: number;
  /** 中止信号(外层看门狗/用户取消)。等待中触发即以 AbortError 收尾,不再重试。 */
  signal?: AbortSignal;
  /** 自定义可重试判定。返回 false 立即抛出(不再退避)。默认 isRetryableHttpError。 */
  shouldRetry?: (err: unknown) => boolean;
  /** 自定义本次退避时长(ms)。返回 null = 放弃重试并抛出当前错误(如 HTTP
   *  Retry-After 要求等待超过 60s)。缺省 = baseDelayMs * 2^(failedAttempt-1)。 */
  delayFor?: (info: {
    nextAttempt: number;
    failedAttempt: number;
    baseDelayMs: number;
    error: unknown;
  }) => number | null;
  /** 每次重试前的回调(打日志/观测)。attempt 为即将进行的第几次(≥2),delayMs 为已等的退避。 */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

/** 退避等待,可被 signal 打断。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 以指数退避重试一次异步操作,直到成功/不可重试/达到上限/被中止。 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    signal,
    shouldRetry = isRetryableHttpError,
    delayFor,
    onRetry,
  } = options;
  let attempt = 1;
  while (true) {
    if (signal?.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (err) {
      // 已取消不是「失败」,是主动中止——原样抛,绝不当可重试错退避。
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (signal?.aborted) throw abortError();
      if (!shouldRetry(err) || attempt >= maxAttempts) throw err;
      const nextAttempt = attempt + 1;
      const retryDelayMs = delayFor
        ? delayFor({ nextAttempt, failedAttempt: attempt, baseDelayMs, error: err })
        : baseDelayMs * 2 ** (attempt - 1);
      if (retryDelayMs === null) throw err;
      onRetry?.({ attempt: nextAttempt, delayMs: retryDelayMs, error: err });
      await delay(retryDelayMs, signal);
      attempt = nextAttempt;
    }
  }
}
