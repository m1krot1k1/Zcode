/**
 * Проверка, можно ли переиспользовать уже собранный bundled Source Server release.
 *
 * Одного совпадения version/size/hash недостаточно: при пересборке того же version
 * после нового commit старый архив проходит проверку и молча попадает в приложение.
 * Поэтому рядом с bundled-release хранится commit, из которого он собран.
 */
export function shouldReuseBundledRelease(options) {
  const {
    descriptor,
    target,
    expectedRevision,
    recordedRevision,
    archiveSizeBytes,
    archiveSha256,
  } = options;
  if (!expectedRevision) return false;
  if (recordedRevision !== expectedRevision) return false;
  const archive = descriptor?.archives?.find((entry) => entry.target === target);
  if (!archive) return false;
  if (archive.sizeBytes !== archiveSizeBytes) return false;
  return archive.sha256 === archiveSha256;
}
