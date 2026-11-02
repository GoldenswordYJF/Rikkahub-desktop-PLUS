// app/tests/api-not-found.test.ts — 404 判定只认 ApiError.code。
// 用途:设置页写入失败时区分「后端没有这个接口(界面比服务端新,产物错配)」与普通报错。
// 只认 code 不认文案,网络错误 / 超时 / 其它 4xx 一律不算。
import { describe, expect, test } from "bun:test";

import { ApiError, isApiNotFound } from "~/services/api";

describe("isApiNotFound", () => {
  test("ApiError 404 为真", () => {
    expect(isApiNotFound(new ApiError("Not found", 404))).toBe(true);
  });

  test("其它 ApiError 为假", () => {
    expect(isApiNotFound(new ApiError("bad request", 400))).toBe(false);
    expect(isApiNotFound(new ApiError("boom", 500))).toBe(false);
  });

  test("非 ApiError 为假", () => {
    expect(isApiNotFound(new Error("network"))).toBe(false);
    expect(isApiNotFound(undefined)).toBe(false);
    expect(isApiNotFound("Not found")).toBe(false);
  });
});
