import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  variablesDe, renderizarDocumento, estadoConsentimientos, consentimientosBloquean, GESTIONABLES_SIN_FIRMA, textoGestionadoSinFirma,
  VARIABLES_DOCUMENTO, REQUERIDOS_PARA_VALIDAR_SPD, LIMITE_VALOR,
} from '../src/dominio/documentos.ts';

const DIR = new URL('../plantillas/consentimientos/', import.meta.url);
const ficheros = readdirSync(DIR).filter(f => f.endsWith('.md')).sort();
const plantillas = Object.fromEntries(ficheros.map(f => [f.replace(/\.md$/, ''), readFileSync(new URL(f, DIR), 'utf8')]));

/** Datos completos para cualquier plantilla. */
const completos = (): Record<string, string> =>
  Object.fromEntries(VARIABLES_DOCUMENTO.map(v => [v, `«${v}»`.replace(/[«»]/g, '') + ' ok']));

test('el repo tiene las 6 plantillas esperadas', () => {
  assert.deepEqual(ficheros, [
    'autorizacion_terceros.md', 'comunicacion_medico.md', 'consentimiento_spd.md',
    'info_rgpd.md', 'recibi_devolucion.md', 'revocacion.md',
  ]);
});

for (const [codigo, texto] of Object.entries(plantillas)) {
  test(`plantilla ${codigo}: todas sus variables están declaradas en VARIABLES_DOCUMENTO`, () => {
    const desconocidas = variablesDe(texto).filter(v => !VARIABLES_DOCUMENTO.includes(v));
    assert.deepEqual(desconocidas, [], 'variable no prevista: añádela a VARIABLES_DOCUMENTO y rellénala al imprimir');
  });

  test(`plantilla ${codigo}: con todos los datos no queda nada sin rellenar y NO lleva marca de borrador`, () => {
    const r = renderizarDocumento(texto, completos());
    assert.deepEqual(r.faltan, []);
    assert.ok(!r.texto.includes('⟦'));
    assert.ok(!r.texto.includes('{{'));
    assert.ok(!r.texto.includes('<!--'), 'los comentarios de la plantilla no se imprimen');
    assert.ok(!/borrador/i.test(r.texto), 'el documento impreso no lleva marca de borrador');
    assert.equal('esBorrador' in r, false, 'ya no existe la marca de borrador');
    assert.ok(!/borrador/i.test(texto), 'la plantilla ya no trae el comentario BORRADOR');
  });
}

test('variablesDe: distintas, en orden y sin repetir', () => {
  assert.deepEqual(variablesDe('{{a.b}} y {{ c }} y {{a.b}}'), ['a.b', 'c']);
  assert.deepEqual(variablesDe('nada'), []);
});

test('variablesDe ignora las variables de dentro de un comentario', () => {
  assert.deepEqual(variablesDe('<!-- {{oculta}} -->\n{{visible}}'), ['visible']);
});

test('variable sin valor: marcador ⟦ruta⟧, entra en faltan y bloquea el definitivo', () => {
  const r = renderizarDocumento('Hola {{paciente.nombre_completo}}.', {});
  assert.equal(r.texto, 'Hola ⟦paciente.nombre_completo⟧.');
  assert.deepEqual(r.faltan, ['paciente.nombre_completo']);
  assert.equal(r.imprimibleDefinitivo, false);
});

test('valor vacío, en blanco, null o undefined cuenta como falta', () => {
  const r = renderizarDocumento('{{a}} {{b}} {{c}} {{d}}', { a: '', b: '   ', c: null, d: undefined });
  assert.deepEqual(r.faltan, ['a', 'b', 'c', 'd']);
});

test('el número 0 es un valor, no una falta', () => {
  const r = renderizarDocumento('v{{documento.version}}', { 'documento.version': 0 });
  assert.equal(r.texto, 'v0');
  assert.deepEqual(r.faltan, []);
});

test('una variable repetida y ausente aparece una sola vez en faltan', () => {
  const r = renderizarDocumento('{{x}} {{x}}', {});
  assert.deepEqual(r.faltan, ['x']);
  assert.equal(r.texto, '⟦x⟧ ⟦x⟧');
});

test('una clave heredada del prototipo no cuenta como dato', () => {
  const r = renderizarDocumento('{{constructor}}', {});
  assert.deepEqual(r.faltan, ['constructor']);
});

test('inyección: «{{x}}» dentro de un valor se neutraliza y NO se re-evalúa', () => {
  const r = renderizarDocumento('Paciente: {{a}} / DNI: {{b}}', { a: '{{b}}', b: '12345678Z' });
  assert.ok(!r.texto.includes('{{'));
  assert.ok(!r.texto.includes('}}'));
  assert.equal(r.texto, 'Paciente: { {b} } / DNI: 12345678Z');
  assert.ok(r.avisos.some(a => /neutralizado/.test(a)));
  assert.deepEqual(r.faltan, []);
});

test('inyección de un valor que apunta a una variable inexistente no genera faltas', () => {
  const r = renderizarDocumento('{{a}}', { a: '{{secreto}}' });
  assert.deepEqual(r.faltan, []);
  assert.ok(!r.texto.includes('{{secreto}}'));
});

test('saltos de línea en un valor se neutralizan (no pueden abrir un título nuevo)', () => {
  const r = renderizarDocumento('Nombre: {{a}}', { a: 'Ana\n# Título falso\r\n\nresto' });
  assert.ok(!r.texto.includes('\n'));
  assert.equal(r.texto, 'Nombre: Ana # Título falso resto');
  assert.ok(r.avisos.some(a => /saltos de línea/.test(a)));
});

test('las variables de tabla conservan sus líneas pero también se neutralizan', () => {
  const r = renderizarDocumento('{{tabla_envases_devueltos}}', { tabla_envases_devueltos: '| a | b |\n| 1 | {{x}} |' });
  assert.equal(r.texto, '| a | b |\n| 1 | { {x} } |');
});

test('longitud: un valor de más de 300 caracteres se recorta y se avisa', () => {
  const largo = 'x'.repeat(LIMITE_VALOR + 50);
  const r = renderizarDocumento('{{a}}', { a: largo });
  assert.equal(r.texto.length, LIMITE_VALOR);
  assert.ok(r.avisos.some(a => /recortado/.test(a)));
  const justo = renderizarDocumento('{{a}}', { a: 'y'.repeat(LIMITE_VALOR) });
  assert.equal(justo.texto.length, LIMITE_VALOR);
  assert.deepEqual(justo.avisos, []);
});

test('el valor se inserta tal cual en Markdown (no se escapa ni se transforma)', () => {
  const r = renderizarDocumento('{{a}}', { a: 'Ana *María* <b>x</b> & co' });
  assert.equal(r.texto, 'Ana *María* <b>x</b> & co');
});

test('un comentario de la plantilla no se imprime y ya no marca nada (no hay marca de borrador)', () => {
  const r = renderizarDocumento('<!-- BORRADOR v1 — revisar -->\n# Título', {});
  assert.equal(r.texto, '# Título');
  assert.equal('esBorrador' in r, false);
  assert.equal(r.imprimibleDefinitivo, true);
});

test('comentario cualquiera: se quita y el texto es el mismo', () => {
  const r = renderizarDocumento('<!-- nota interna -->\n# Título', {});
  assert.equal(r.texto, '# Título');
});

test('sin comentarios: definitivo si no falta nada', () => {
  const r = renderizarDocumento('Hola {{a}}', { a: 'mundo' });
  assert.equal(r.imprimibleDefinitivo, true);
});

test('el hash es SHA-256 hex del texto resultante y es estable', () => {
  const datos = { a: 'mundo' };
  const r1 = renderizarDocumento('Hola {{a}}', datos);
  const r2 = renderizarDocumento('Hola {{a}}', { ...datos });
  assert.equal(r1.hash, r2.hash);
  assert.equal(r1.hash, createHash('sha256').update('Hola mundo', 'utf8').digest('hex'));
  assert.match(r1.hash, /^[0-9a-f]{64}$/);
});

test('un valor distinto da un hash distinto; el comentario no entra en el hash', () => {
  const a = renderizarDocumento('<!-- BORRADOR -->\nHola {{a}}', { a: 'uno' });
  const b = renderizarDocumento('<!-- BORRADOR -->\nHola {{a}}', { a: 'dos' });
  const c = renderizarDocumento('Hola {{a}}', { a: 'uno' });
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.hash, c.hash);
});

test('revocación: «motivo» es opcional y vacío se imprime «no indicado» sin bloquear', () => {
  const datos = completos();
  datos['motivo'] = '';
  const r = renderizarDocumento(plantillas['revocacion'], datos);
  assert.deepEqual(r.faltan, []);
  assert.match(r.texto, /Motivo \(opcional\): no indicado/);
});

test('consentimiento_spd con datos incompletos: faltan lo que falta y no es definitivo', () => {
  const datos = completos();
  delete datos['paciente.dni_nie'];
  datos['firmante.nombre'] = '';
  const r = renderizarDocumento(plantillas['consentimiento_spd'], datos);
  assert.deepEqual(r.faltan.sort(), ['firmante.nombre', 'paciente.dni_nie']);
  assert.equal(r.imprimibleDefinitivo, false);
  assert.match(r.texto, /⟦paciente\.dni_nie⟧/);
});

test('info_rgpd: los «[A COMPLETAR …]» de la plantilla impiden el definitivo aunque estén todos los datos', () => {
  const r = renderizarDocumento(plantillas['info_rgpd'], completos());
  assert.deepEqual(r.faltan, []);
  assert.ok(r.sinCompletar.length >= 2);
  assert.equal(r.imprimibleDefinitivo, false);
});

test('una plantilla sin «A COMPLETAR» y con datos completos sí es definitiva y no lleva marca de borrador', () => {
  const r = renderizarDocumento(plantillas['comunicacion_medico'], completos());
  assert.equal(r.imprimibleDefinitivo, true);
  assert.ok(!/borrador/i.test(r.texto));
});

// ── estadoConsentimientos ────────────────────────────────────────────────

const vigentes = [
  { codigo: 'consentimiento_spd', version: 2 },
  { codigo: 'info_rgpd', version: 1 },
];

test('estado: todo firmado en la versión vigente → completo', () => {
  const e = estadoConsentimientos(
    [{ codigo: 'consentimiento_spd', version: 2 }, { codigo: 'info_rgpd', version: 1, revocadoEn: null }],
    vigentes, ['consentimiento_spd', 'info_rgpd']);
  assert.deepEqual(e, { completo: true, faltan: [], desactualizados: [], revocados: [], gestionados: [], exigido: true });
});

test('estado: nunca firmado → falta, y sin consentimiento_spd no está completo', () => {
  const e = estadoConsentimientos([], vigentes, REQUERIDOS_PARA_VALIDAR_SPD as string[]);
  assert.equal(e.completo, false);
  assert.deepEqual(e.faltan, ['consentimiento_spd', 'info_rgpd']);
});

test('estado: versión vieja → desactualizado', () => {
  const e = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 1 }], vigentes, ['consentimiento_spd']);
  assert.equal(e.completo, false);
  assert.deepEqual(e.desactualizados, ['consentimiento_spd']);
  assert.deepEqual(e.faltan, []);
});

test('estado: revocado → revocado (no cuenta como falta ni como desactualizado)', () => {
  const e = estadoConsentimientos(
    [{ codigo: 'consentimiento_spd', version: 2, revocadoEn: '2026-10-01' }], vigentes, ['consentimiento_spd']);
  assert.equal(e.completo, false);
  assert.deepEqual(e.revocados, ['consentimiento_spd']);
  assert.deepEqual(e.faltan, []);
  assert.deepEqual(e.desactualizados, []);
});

test('estado: revocó la vieja y firmó la nueva → completo', () => {
  const e = estadoConsentimientos(
    [{ codigo: 'consentimiento_spd', version: 1, revocadoEn: '2026-05-01' }, { codigo: 'consentimiento_spd', version: 2 }],
    vigentes, ['consentimiento_spd']);
  assert.equal(e.completo, true);
});

test('estado: revocó la versión más reciente aunque quede una anterior sin revocar → revocado', () => {
  const e = estadoConsentimientos(
    [{ codigo: 'consentimiento_spd', version: 1 }, { codigo: 'consentimiento_spd', version: 2, revocadoEn: '2026-10-02' }],
    vigentes, ['consentimiento_spd']);
  assert.deepEqual(e.revocados, ['consentimiento_spd']);
  assert.equal(e.completo, false);
});

test('estado: revocación con cadena vacía no cuenta como revocado', () => {
  const e = estadoConsentimientos([{ codigo: 'info_rgpd', version: 1, revocadoEn: '' }], vigentes, ['info_rgpd']);
  assert.equal(e.completo, true);
});

test('estado: firmado en una versión posterior a la vigente conocida no se marca como desactualizado', () => {
  const e = estadoConsentimientos([{ codigo: 'info_rgpd', version: 3 }], vigentes, ['info_rgpd']);
  assert.equal(e.completo, true);
});

test('estado: sólo se evalúan los requeridos; lo demás firmado no influye', () => {
  const e = estadoConsentimientos([{ codigo: 'comunicacion_medico', version: 1, revocadoEn: '2026-01-01' }], vigentes, []);
  assert.equal(e.completo, true);
});

test('estado: requerido firmado pero sin plantilla vigente conocida → falta (no se da por bueno)', () => {
  const e = estadoConsentimientos([{ codigo: 'otro', version: 1 }], vigentes, ['otro']);
  assert.deepEqual(e.faltan, ['otro']);
  assert.equal(e.completo, false);
});

test('REQUERIDOS_PARA_VALIDAR_SPD incluye siempre consentimiento_spd', () => {
  assert.ok(REQUERIDOS_PARA_VALIDAR_SPD.includes('consentimiento_spd'));
});

// ── Consentimientos opcionales y «gestionado sin firma individual» ──────────────

test('estado: por defecto se EXIGE; sólo exigir:false lo relaja, y completo sigue siendo un hecho', () => {
  assert.equal(estadoConsentimientos([], vigentes, ['info_rgpd']).exigido, true);
  assert.equal(estadoConsentimientos([], vigentes, ['info_rgpd'], {}).exigido, true);
  assert.equal(estadoConsentimientos([], vigentes, ['info_rgpd'], { exigir: true }).exigido, true);
  const e = estadoConsentimientos([], vigentes, ['info_rgpd'], { exigir: false });
  assert.equal(e.exigido, false);
  assert.equal(e.completo, false, 'lo pendiente se sigue viendo como pendiente (informativo)');
  assert.deepEqual(e.faltan, ['info_rgpd']);
});

test('consentimientosBloquean: sólo si hay algo pendiente Y se exige', () => {
  assert.equal(consentimientosBloquean(estadoConsentimientos([], vigentes, ['info_rgpd'])), true);
  assert.equal(consentimientosBloquean(estadoConsentimientos([], vigentes, ['info_rgpd'], { exigir: false })), false);
  assert.equal(consentimientosBloquean(estadoConsentimientos([{ codigo: 'info_rgpd', version: 1 }], vigentes, ['info_rgpd'])), false);
  // un estado antiguo sin el campo `exigido` se trata como exigido
  assert.equal(consentimientosBloquean({ completo: false, faltan: ['x'], desactualizados: [], revocados: [], gestionados: [] } as never), true);
});

test('estado: «gestionado sin firma» cuenta como vigente (completo) y se distingue de una firma real', () => {
  const g = { codigo: 'consentimiento_spd', version: 2, origen: 'gestionado_sin_firma' as const };
  const e = estadoConsentimientos([g, { codigo: 'info_rgpd', version: 1, origen: 'firma' }], vigentes, ['consentimiento_spd', 'info_rgpd']);
  assert.equal(e.completo, true);
  assert.deepEqual(e.gestionados, ['consentimiento_spd']);
});

test('estado: gestionado + firma real vigente → es firma (no figura como gestionado)', () => {
  const e = estadoConsentimientos(
    [{ codigo: 'info_rgpd', version: 1, origen: 'gestionado_sin_firma' }, { codigo: 'info_rgpd', version: 1, origen: 'firma' }], vigentes, ['info_rgpd']);
  assert.deepEqual(e.gestionados, []);
});

test('estado: un gestionado REVOCADO deja de valer, como una firma', () => {
  const e = estadoConsentimientos([{ codigo: 'info_rgpd', version: 1, origen: 'gestionado_sin_firma', revocadoEn: '2026-11-01' }], vigentes, ['info_rgpd']);
  assert.equal(e.completo, false);
  assert.deepEqual(e.revocados, ['info_rgpd']);
  assert.deepEqual(e.gestionados, []);
});

test('estado: un gestionado de una versión vieja está desactualizado (no se da por bueno)', () => {
  const e = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 1, origen: 'gestionado_sin_firma' }], vigentes, ['consentimiento_spd']);
  assert.deepEqual(e.desactualizados, ['consentimiento_spd']);
  assert.deepEqual(e.gestionados, []);
});

test('GESTIONABLES_SIN_FIRMA: sólo consentimiento/información; lo que se firma en el acto no se puede dar por gestionado', () => {
  assert.deepEqual([...GESTIONABLES_SIN_FIRMA].sort(), ['comunicacion_medico', 'consentimiento_spd', 'info_rgpd']);
  for (const c of ['recibi_devolucion', 'revocacion', 'autorizacion_terceros']) assert.ok(!GESTIONABLES_SIN_FIRMA.includes(c), c);
  for (const c of REQUERIDOS_PARA_VALIDAR_SPD) assert.ok(GESTIONABLES_SIN_FIRMA.includes(c), 'los obligatorios para validar son gestionables');
});

test('textoGestionadoSinFirma: dice que NO hay firma, con motivo, quién y cuándo; no imita el documento ni una firma', () => {
  const t = textoGestionadoSinFirma({ titulo: 'Consentimiento informado SPD', version: 2, motivo: 'Consentimiento recogido por el centro', usuario: 'Ana Titular', fecha: '03/11/2026', centro: 'Residencia Sol' });
  assert.match(t, /^GESTIONADO SIN FIRMA INDIVIDUAL/);
  assert.match(t, /Consentimiento informado SPD \(versión 2\)/);
  assert.match(t, /Residencia Sol/);
  assert.match(t, /Consentimiento recogido por el centro/);
  assert.match(t, /Ana Titular el 03\/11\/2026/);
  assert.match(t, /No consta firma del paciente/);
  assert.doesNotMatch(t, /\bfirmado por\b|\bfdo\b/i);
  assert.ok(!t.includes('Residencia Sol.\nResidencia'), 'el centro sólo sale una vez');
  // sin centro no deja una línea vacía ni «null»
  const s = textoGestionadoSinFirma({ titulo: 'X', version: 1, motivo: 'motivo largo', usuario: 'U', fecha: '01/01/2026' });
  assert.doesNotMatch(s, /null|undefined|\n\n/);
});
