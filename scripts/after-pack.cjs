/**
 * afterPack de electron-builder: endurece el ejecutable con @electron/fuses (docs/10-seguridad.md §10.5).
 *   RunAsNode=false · EnableNodeOptionsEnvironmentVariable=false · EnableNodeCliInspectArguments=false ·
 *   OnlyLoadAppFromAsar=true · EnableEmbeddedAsarIntegrityValidation=true · EnableCookieEncryption=true
 * electron-builder 26 ya deja la integridad del asar embebida en el .exe ANTES de este hook, así que activar la validación es coherente.
 * Sólo se ejecuta en `npm run dist:win` (no en `npm run build`). Si algo falla, el empaquetado FALLA: no se publica un ejecutable sin endurecer.
 */
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const plataforma = context.electronPlatformName;
  const nombre = context.packager.appInfo.productFilename;
  const binario = plataforma === 'win32' ? path.join(context.appOutDir, `${nombre}.exe`)
    : plataforma === 'darwin' || plataforma === 'mas' ? path.join(context.appOutDir, `${nombre}.app`)
    : path.join(context.appOutDir, context.packager.executableName ?? nombre);
  await flipFuses(binario, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
  });
  console.log('[spd] fuses de Electron aplicados a', binario);
};
