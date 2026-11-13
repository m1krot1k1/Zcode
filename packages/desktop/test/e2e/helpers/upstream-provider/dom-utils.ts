export async function hasAnyExactTestId(testIds: string[]) {
  return browser.execute((currentTestIds) => {
    const existing = new Set(
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).map(
        (element) => element.dataset.testid ?? "",
      ),
    );
    return currentTestIds.some((currentTestId) => existing.has(currentTestId));
  }, testIds);
}

export async function hasExactTestId(currentTestId: string) {
  return browser.execute((expectedTestId) => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
      (element) => element.dataset.testid === expectedTestId,
    );
  }, currentTestId);
}

export async function clickFirstExistingTestId(testIds: string[]) {
  return browser.execute((currentTestIds) => {
    for (const currentTestId of currentTestIds) {
      const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
      if (element) {
        element.click();
        return {
          testId: currentTestId,
          text: element.innerText.trim(),
        };
      }
    }
    return null;
  }, testIds);
}
