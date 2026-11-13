import type { BrowserDialog } from "@zcode/contracts/browser-control";

export type JsDialog = AlertDialog | ConfirmDialog | PromptDialog | BeforeUnloadDialog;

class DialogBase {
  constructor(
    readonly type: BrowserDialog["type"],
    protected readonly respond: (accept: boolean, promptText?: string) => Promise<void>,
  ) {}

  dismiss(): Promise<void> {
    return this.respond(false);
  }
}

class AlertDialog extends DialogBase {
  declare readonly type: "alert";
}

class BeforeUnloadDialog extends DialogBase {
  declare readonly type: "beforeunload";
}

class ConfirmDialog extends DialogBase {
  declare readonly type: "confirm";

  accept(): Promise<void> {
    return this.respond(true);
  }
}

class PromptDialog extends DialogBase {
  declare readonly type: "prompt";

  accept(text: string): Promise<void> {
    return this.respond(true, text);
  }
}

export function createJsDialog(
  dialog: BrowserDialog,
  respond: (accept: boolean, promptText?: string) => Promise<void>,
): JsDialog {
  switch (dialog.type) {
    case "confirm":
      return new ConfirmDialog("confirm", respond);
    case "prompt":
      return new PromptDialog("prompt", respond);
    case "beforeunload":
      return new BeforeUnloadDialog("beforeunload", respond);
    default:
      return new AlertDialog("alert", respond);
  }
}
