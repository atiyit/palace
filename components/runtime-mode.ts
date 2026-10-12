// 主人，此标志仅由独立本地构建设置；托管入口保持各自的认证流程。
export const IS_LOCAL_APP = import.meta.env?.VITE_PALACE_LOCAL === "true";
export const AUTH_ERROR = IS_LOCAL_APP
  ? "本机服务暂时无法验证此请求，请重新连接庭院。"
  : "登录已过期，请重新登录。";
