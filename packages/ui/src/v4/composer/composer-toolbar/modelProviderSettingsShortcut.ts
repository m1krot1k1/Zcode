/**
 * Условие показа входа в настройки провайдера вместо пустого меню моделей.
 *
 * Вынесено из V4ComposerToolbar.tsx как чистый предикат: им пользуется и
 * представление тулбара, и тесты через реэкспорт из исходного модуля.
 */
export function shouldShowModelProviderSettingsShortcut(params: {
  modelMenuVisible: boolean;
  providerSourcesLoading: boolean;
  selectableModelGroupCount: number;
  connectionSwitchPending: boolean;
}): boolean {
  return (
    params.modelMenuVisible &&
    !params.providerSourcesLoading &&
    params.selectableModelGroupCount === 0 &&
    !params.connectionSwitchPending
  );
}
