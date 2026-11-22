import {
  applyMacAdHocSignature,
  resolveMacAdHocAppBundlePath,
  resolveMacAdHocSigningDecision,
} from "../scripts/macos-adhoc-signing.mjs";

export function createMacAdHocSigner(ctx) {
  /**
   * Ad-hoc подпись unsigned macOS Preview.
   *
   * Точка вставки — конец afterPack: electron-builder вызывает hook после копирования app.asar,
   * extraResources и runtime modules, затем выполняет sanityCheck/fuses и только потом
   * packageInDistributableFormat собирает DMG/ZIP из готового `.app`. Поэтому подпись попадает
   * в оба артефакта, а не только в staging bundle.
   *
   * Developer ID не затрагивается: решение принимает resolveMacAdHocSigningDecision по
   * signingEnabled/forceCodeSigning и signing-credentials в env; причина всегда логируется.
   */
  function applyMacAdHocSignatureIfNeeded(context) {
    const decision = resolveMacAdHocSigningDecision({
      electronPlatformName: context.electronPlatformName,
      productFlavor: ctx.desktopProductIdentity.flavor,
      signingEnabled: ctx.shouldEnableMacSigning,
      forceCodeSigning: ctx.macBuildSecurity.forceCodeSigning,
    });
    if (!decision.enabled) {
      if (context.electronPlatformName === "darwin") {
        console.log(`[macos-adhoc-signing] skipped: ${decision.reason}`);
      }
      return;
    }
    const appPath = resolveMacAdHocAppBundlePath({
      appOutDir: context.appOutDir,
      productFilename: context.packager?.appInfo?.productFilename,
    });
    console.log(`[macos-adhoc-signing] applying ad-hoc signature (${decision.reason}): ${appPath}`);
    applyMacAdHocSignature(appPath);
  }

  return { applyMacAdHocSignatureIfNeeded };
}
