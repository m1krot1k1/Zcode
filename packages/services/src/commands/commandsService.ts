// 公开入口：命令服务的实现按目录来源、CLI 配置、插件扫描和文件发现拆分到 service/，
// 这里保持原路径与 createCommandsService 的导出形态不变。
export { createCommandsService } from "./service/commandsService.js";
