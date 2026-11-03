import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compararVersiones, decidirActualizacion, elegirInstalador, elegirSumas, esUrlDescargaPermitida, esUrlRedireccionPermitida,
  interpretarRelease, listarVersionesPublicadas, normalizarPreferencias, parsearSumas, parsearVersion, coincideSuma,
} from '../src/dominio/actualizaciones.ts';

const H = 'a'.repeat(64);
const url = (tag: string, n: string) => `https://github.com/PharmaJava/SPD/releases/download/${tag}/${n}`;
const rel = (tag: string, extra: Record<string, unknown> = {}) => interpretarRelease({
  tag_name: tag, name: 'SPD ' + tag, body: 'Notas\r\n\u0007x', published_at: '2026-10-01T10:00:00Z',
  assets: [
    { name: `SPD-${tag.slice(1)}-win-x64.exe`, browser_download_url: url(tag, `SPD-${tag.slice(1)}-win-x64.exe`), size: 100 },
    { name: `SPD-${tag.slice(1)}-portable.exe`, browser_download_url: url(tag, `SPD-${tag.slice(1)}-portable.exe`), size: 100 },
    { name: 'SHA256SUMS.txt', browser_download_url: url(tag, 'SHA256SUMS.txt'), size: 10 },
  ], ...extra,
})!;

test('semver: orden, prerelease y basura', () => {
  assert.equal(compararVersiones('1.2.3', 'v1.2.4'), -1);
  assert.equal(compararVersiones('1.10.0', '1.9.9'), 1);
  assert.equal(compararVersiones('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compararVersiones('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compararVersiones('1.0.0+a', '1.0.0+b'), 0);
  for (const x of ['1.2', 'latest', '', null, '1.2.3.4', 'x1.2.3', '1.2.3-', 7]) { assert.equal(parsearVersion(x), null, String(x)); assert.equal(compararVersiones(x, '1.0.0'), null); }
});

test('URLs: sólo github.com/PharmaJava/SPD/releases/download; redirecciones sólo a GitHub', () => {
  assert.ok(esUrlDescargaPermitida(url('v1.0.0', 'a.exe')));
  for (const u of ['http://github.com/PharmaJava/SPD/releases/download/v1/a.exe', 'https://github.com/otro/SPD/releases/download/v1/a.exe', 'https://github.com.evil.com/PharmaJava/SPD/releases/download/v1/a.exe',
    'https://evil.com/PharmaJava/SPD/releases/download/v1/a.exe', 'https://github.com/PharmaJava/SPD/releases/download/v1/../x', 'https://x@github.com/PharmaJava/SPD/releases/download/v1/a.exe', 'https://github.com:8443/PharmaJava/SPD/releases/download/v1/a.exe', 'https://github.com/PharmaJava/SPD/archive/v1.zip', 5, null]) assert.equal(esUrlDescargaPermitida(u), false, String(u));
  assert.ok(esUrlRedireccionPermitida('https://objects.githubusercontent.com/x'));
  for (const u of ['http://objects.githubusercontent.com/x', 'https://evilgithubusercontent.com/x', 'https://evil.com/x']) assert.equal(esUrlRedireccionPermitida(u), false, u);
});

test('release: borrador fuera, assets de otra release o URL ajena descartados, notas saneadas', () => {
  assert.equal(interpretarRelease({ tag_name: 'v1.0.0', draft: true }), null);
  assert.equal(interpretarRelease({ tag_name: 'nightly' }), null);
  const r = interpretarRelease({ tag_name: 'v1.0.0', body: 'a\u0000b', assets: [
    { name: 'a.exe', browser_download_url: url('v0.9.0', 'a.exe') },        // de otra etiqueta
    { name: 'b.exe', browser_download_url: 'https://evil.com/b.exe' },
    { name: 'c.exe', browser_download_url: url('v1.0.0', 'c.exe') },
  ] })!;
  assert.deepEqual(r.assets.map(a => a.nombre), ['c.exe']);
  assert.equal(r.notas, 'ab');
  assert.equal(r.urlPagina, 'https://github.com/PharmaJava/SPD/releases/tag/v1.0.0');
});

test('instalador: el NSIS de esa versión, nunca el portable; sumas', () => {
  const r = rel('v1.2.0');
  assert.equal(elegirInstalador(r)!.nombre, 'SPD-1.2.0-win-x64.exe');
  assert.equal(elegirSumas(r)!.nombre, 'SHA256SUMS.txt');
  const sin = rel('v1.2.0', { assets: [{ name: 'SPD-1.2.0-portable.exe', browser_download_url: url('v1.2.0', 'SPD-1.2.0-portable.exe') }] });
  assert.equal(elegirInstalador(sin), null);
});

test('sumas: formatos, BOM/CRLF, ambiguas y hashes inválidos', () => {
  const m = parsearSumas(`﻿${H}  SPD-1.0.0-win-x64.exe\r\n${'B'.repeat(64)} *SPD-1.0.0-portable.exe\r\nbasura\r\n${'c'.repeat(63)}  corto.exe\r\n${H}  dup.exe\r\n${'d'.repeat(64)}  dup.exe\r\n`);
  assert.equal(m.get('SPD-1.0.0-win-x64.exe'), H);
  assert.equal(m.get('SPD-1.0.0-portable.exe'), 'b'.repeat(64));
  assert.equal(m.has('corto.exe'), false); assert.equal(m.has('dup.exe'), false);
  assert.equal(coincideSuma(H, 'A'.repeat(64)), true);
  assert.equal(coincideSuma(null, H), false); assert.equal(coincideSuma('zz', 'zz'), false);
});

test('decidir: sin downgrade, sin prerelease, ignorada sólo en automático, sin instalador no se ofrece', () => {
  const d = (actual: string, release: ReturnType<typeof rel> | null, extra = {}) => decidirActualizacion({ actual, release, manual: false, ...extra }).estado;
  assert.equal(d('1.0.0', rel('v1.1.0')), 'disponible');
  assert.equal(d('1.1.0', rel('v1.1.0')), 'al_dia');
  assert.equal(d('1.2.0', rel('v1.1.0')), 'al_dia');
  assert.equal(d('1.0.0', null), 'al_dia');
  assert.equal(d('1.0.0', rel('v1.1.0', { prerelease: true })), 'al_dia');
  assert.equal(d('1.0.0', rel('v1.1.0'), { versionIgnorada: '1.1.0' }), 'ignorada');
  assert.equal(d('1.0.0', rel('v1.1.0'), { versionIgnorada: '1.1.0', manual: true }), 'disponible');
  assert.equal(d('1.0.0', rel('v1.2.0'), { versionIgnorada: '1.1.0' }), 'disponible');
  assert.equal(d('1.0.0', rel('v1.1.0', { assets: [] })), 'sin_instalador');
});

test('preferencias y lista de versiones', () => {
  assert.deepEqual(normalizarPreferencias(null), { comprobarAlArrancar: true, versionIgnorada: null, ultimaComprobacion: null });
  assert.equal(normalizarPreferencias({ comprobarAlArrancar: false, versionIgnorada: 'v2.0.0' }).versionIgnorada, '2.0.0');
  assert.equal(normalizarPreferencias({ versionIgnorada: 'evil' }).versionIgnorada, null);
  const l = listarVersionesPublicadas([rel('v1.0.0'), rel('v1.2.0'), rel('v1.1.0'), rel('v1.3.0-rc.1', { prerelease: true })], '1.1.0',
    new Map([['v1.0.0', new Map([['SPD-1.0.0-win-x64.exe', H]])]]));
  assert.deepEqual(l.map(v => v.version), ['1.2.0', '1.1.0', '1.0.0']);
  assert.deepEqual(l.map(v => [v.esActual, v.esAnterior]), [[false, false], [true, false], [false, true]]);
  assert.equal(l[2].instalador!.sha256, H); assert.equal(l[0].instalador!.sha256, null);
});
