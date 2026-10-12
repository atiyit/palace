export class PalaceError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "INVALID_REQUEST") {
    super(message);
    this.name = "PalaceError";
    this.status = status;
    this.code = code;
  }
}

export function publicError(error: unknown): { message: string; status: number; code: string } {
  if (error instanceof PalaceError) return { message: error.message, status: error.status, code: error.code };
  if (error instanceof Error && /no such table/i.test(error.message)) {
    return { message: "数据库还未完成初始化，请应用 D1 数据迁移后重试。", status: 503, code: "DATABASE_NOT_READY" };
  }
  return { message: "服务暂时无法完成请求。你的已保存记录没有改变，请稍后重试。", status: 500, code: "INTERNAL_ERROR" };
}
