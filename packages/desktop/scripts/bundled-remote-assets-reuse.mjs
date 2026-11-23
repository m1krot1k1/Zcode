/**
 * Проверка, можно ли переиспользовать уже собранный bundled Source Server release.
 *
 * Одного совпадения version/size/hash недостаточно: при пересборке того же version
 * после нового commit старый архив проходит проверку и молча попадает в приложение.
 * Поэтому рядом с bundled-release хранится commit, из которого он собран.
 *
 * Набор целей обязателен целиком: bundle, собранный только под хост-платформу,
 * не должен переиспользоваться — иначе клиент снова получит descriptor без
 * удалённой цели (например, macOS-приложение без linux-x64).
 */
export function shouldReuseBundledRelease(options) {
  const { descriptor, targets, expectedRevision, recordedRevision, archives } = options;
  if (!expectedRevision) return false;
  if (recordedRevision !== expectedRevision) return false;
  if (!Array.isArray(targets) || targets.length === 0) return false;
  return targets.every((target) => {
    const archive = descriptor?.archives?.find((entry) => entry.target === target);
    if (!archive) return false;
    const fingerprint = archives?.[target];
    if (!fingerprint) return false;
    if (archive.sizeBytes !== fingerprint.sizeBytes) return false;
    return archive.sha256 === fingerprint.sha256;
  });
}
