/**
 * 远程连接字段的稳定公开入口。实现按连接类型拆分在 remote-connection-fields/ 下：
 * SSH / Server / WSL / Docker 各自一个字段组，共用的分段控件与 SSH config 选择器
 * 同目录导出；此文件只保留原有导入路径与公共 API。
 */
export { RemoteConnectionFields } from "@/remote-connection-fields/RemoteConnectionFields.js";
export { RemoteSegmentedControl } from "@/remote-connection-fields/RemoteSegmentedControl.js";
export { SshConfigAliasPicker } from "@/remote-connection-fields/SshConfigAliasPicker.js";
