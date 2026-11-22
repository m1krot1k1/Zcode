export async function clickAboutMenuItem() {
  await browser.electron.execute((electron) => {
    const menu = electron.Menu.getApplicationMenu();
    const topMenuLabel = process.platform === "darwin" ? electron.app.name : "Help";
    const topMenu = menu?.items.find((item) => item.label === topMenuLabel);
    const menuItem = topMenu?.submenu?.items.find((item) => item.label === "About ZCode");

    if (!menuItem) {
      throw new Error(`未找到 About ZCode 菜单项: ${topMenuLabel}`);
    }

    menuItem.click(undefined as never, undefined, undefined as never);
  });
}

export async function clickDockMenuItem(itemLabel: string) {
  await browser.electron.execute((electron, itemLabel) => {
    const menu = electron.app.dock?.getMenu();
    const menuItem = menu?.items.find((item) => item.label === itemLabel);
    menuItem?.click(undefined as never, undefined, undefined as never);
  }, itemLabel);
}

export async function getDockMenuLabels(): Promise<string[]> {
  return browser.electron.execute((electron) => {
    return (
      electron.app.dock
        ?.getMenu()
        ?.items.map((item) => item.label)
        .filter((label): label is string => Boolean(label)) ?? []
    );
  });
}

export async function clearRecentDocuments() {
  await browser.electron.execute((electron) => {
    if (process.platform === "darwin" || process.platform === "win32") {
      electron.app.clearRecentDocuments();
    }
  });
}

export async function getRecentDocuments(): Promise<string[]> {
  return browser.electron.execute((electron) => {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return [];
    }

    return electron.app.getRecentDocuments();
  });
}

export async function minimizePrimaryWindow() {
  await browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    win?.minimize();
  });
}

export async function isPrimaryWindowMinimized(): Promise<boolean> {
  return browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    return win?.isMinimized() ?? false;
  });
}
