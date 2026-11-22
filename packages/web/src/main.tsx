import "./styles.css";

import { bootstrapWebApp } from "./bootstrap/app.js";
import { createHomeOnlyWebRemoteControlServices } from "./bootstrap/home-only-services.js";

// 测试与其他入口通过 main 直接拿到 home-only 服务工厂，保留公开入口。
export { createHomeOnlyWebRemoteControlServices };

void bootstrapWebApp();
