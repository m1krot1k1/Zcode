import {
  TID_V4_DELETE_SESSION,
  TID_V4_RENAME_INPUT,
  TID_V4_RENAME_SUBMIT,
  TID_V4_SESSION_TITLE,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, setInputValueByTestIdDom } from "../desktop-app.js";

/** 点击会话删除按钮（deleteSession 命令）。 */
export async function clickV4DeleteSession() {
  return clickTestIdByDom(TID_V4_DELETE_SESSION, {
    timeout: 15000,
    timeoutMsg: "v4 删除按钮没有出现",
  });
}

/** 读取会话标题显示（data-title 投影属性）。 */
export function getV4SessionTitle(): Promise<string | null> {
  return browser.execute((titleTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${titleTestId}"]`);
    return el?.getAttribute("data-title") ?? null;
  }, TID_V4_SESSION_TITLE);
}

/** 在 header 重命名输入框写入标题并点提交（renameSession 命令）。 */
export async function renameV4Session(title: string) {
  await setInputValueByTestIdDom(TID_V4_RENAME_INPUT, title, {
    timeout: 15000,
    timeoutMsg: "v4 重命名输入框没有出现",
  });
  await clickTestIdByDom(TID_V4_RENAME_SUBMIT, {
    timeout: 15000,
    timeoutMsg: "v4 重命名提交按钮没有出现",
  });
}
