/**
 * OAuthService 公共入口。
 *
 * 实现按流程职责拆分到 ./service/，此文件只保留稳定的导入路径和导出集合，
 * 调用方继续从 oauth/oauthService.js 获取 OAuthService 与 createOAuthService。
 */
export { OAuthService, createOAuthService } from "./service/oauthService.js";
