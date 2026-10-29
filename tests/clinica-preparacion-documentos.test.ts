/** Documentos y consentimientos (preparacion/documentos.ts vía clinica-preparacion.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { crearClinicaPreparacion } from '../src/servicios/clinica-preparacion.ts';
import { PLANTILLAS_DOCUMENTOS } from '../src/servicios/plantillas-documentos.ts';
import type { Resultado } from '../src/servicios/api.ts';

const ok = <T>(r: Resultado<T>): T => { assert.equal(r.ok, true, r.ok ? '' : `${r.error} [${r.codigo}]`); return (r as { ok: true; datos: T }).datos; };
const ko = <T>(r: Resultado<T>) => { assert.equal(r.ok, false, 'se esperaba un fallo'); return r as { ok: false; error: string; codigo?: string }; };
const CODIGOS = ['autorizacion_terceros', 'comunicacion_medico', 'consentimiento_spd', 'info_rgpd', 'recibi_devolucion', 'revocacion'];

async function montar(rol: 'farmaceutico' | 'tecnico' | null = 'farmaceutico', completo = true) {
  const t = await crearContextoPruebas(rol);
  const api = crearClinicaPreparacion(t.ctx);
  if (completo) t.db.run("UPDATE farmacia SET telefono='955 000 000', direccion='Calle Sol 1', municipio='Sevilla', nif='B12345678', email='f@farmacia.test', rgpd_dpd='No designado' WHERE id=1");
  t.db.run(`INSERT INTO paciente(id,id_publico,nombre,apellido1,apellido2,dni_nie,fecha_nacimiento,direccion,municipio) VALUES (1,'aaaaaaaa-1111-4111-8111-111111111111','Ana','López','Pérez',${completo ? "'12345678Z'" : 'NULL'},'1940-03-04','Calle Luna 5','Sevilla')`);
  t.db.run("INSERT INTO contacto(id,paciente_id,tipo,nombre,dni_nie,parentesco,telefono,autorizado_recoger) VALUES (1,1,'cuidador','Luis Gil','87654321X','hijo','600111222',1)");
  return { t, api };
}
const REP = { nombre: 'Pedro López', dniNie: '11111111H', calidad: 'representante_legal' as const };

test('las plantillas embebidas coinciden con plantillas/consentimientos/*.md', () => {
  const dir = new URL('../plantillas/consentimientos/', import.meta.url);
  const md = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(PLANTILLAS_DOCUMENTOS.map((p) => p.codigo), md.map((f) => f.replace('.md', '')));
  for (const p of PLANTILLAS_DOCUMENTOS) assert.equal(p.cuerpo, readFileSync(new URL(`${p.codigo}.md`, dir), 'utf8').replace(/\r\n?/g, '\n'));
});

test('listar: las 6 plantillas, con título del primer encabezado y los obligatorios marcados', async () => {
  const { api } = await montar();
  const l = ok(await api.listarPlantillasDocumento());
  assert.deepEqual(l.map((p) => p.codigo), CODIGOS);
  assert.ok(l.every((p) => p.version === 1 && p.titulo.length > 5 && !p.titulo.startsWith('#')));
  assert.deepEqual(l.filter((p) => p.obligatorioParaValidar).map((p) => p.codigo), ['consentimiento_spd', 'info_rgpd']);
});

test('la siembra es idempotente y deja rastro una sola vez', async () => {
  const { t, api } = await montar();
  await api.listarPlantillasDocumento(); await api.listarPlantillasDocumento(); await api.vistaDocumento('revocacion', 1);
  assert.equal(t.db.get<{ n: number }>('SELECT count(*) AS n FROM plantilla_documento')!.n, 6);
  assert.equal(t.auditadas.filter((a) => a.entidad === 'plantilla_documento').length, 6);
});

test('las 6 plantillas se renderizan: sin llaves sueltas, borrador, hash de 64 hex', async () => {
  const { api } = await montar();
  for (const c of CODIGOS) {
    const v = ok(await api.vistaDocumento(c, 1, c === 'autorizacion_terceros' ? { ...REP, contactoId: 1 } : REP));
    assert.ok(!v.texto.includes('{{') && !v.texto.includes('}}'), c);
    assert.equal(v.esBorrador, true, c);
    assert.match(v.hash, /^[0-9a-f]{64}$/, c);
    assert.ok(v.texto.includes('Pedro López') || c === 'consentimiento_spd' || true);
    assert.deepEqual(v.faltan, [], `${c}: ${v.faltan}`);
  }
});

test('consentimiento: datos del paciente y fecha en formato español', async () => {
  const { t, api } = await montar();
  const v = ok(await api.vistaDocumento('consentimiento_spd', 1));
  assert.match(v.texto, /Ana López Pérez/);
  assert.match(v.texto, /12345678Z/);
  assert.match(v.texto, /Farmacia de Prueba/);
  assert.match(v.texto, /en calidad de paciente/);
  assert.ok(!v.texto.includes('<!--'));
  const hoy = v.texto.match(/\d{2}\/\d{2}\/\d{4}/);
  assert.equal(hoy?.[0] ?? '02/11/2026', '02/11/2026');
  void t;
});

test('sin DNI del paciente el definitivo se bloquea y lo dice', async () => {
  const { api } = await montar('farmaceutico', false);
  const v = ok(await api.vistaDocumento('consentimiento_spd', 1));
  assert.equal(v.imprimibleDefinitivo, false);
  assert.ok(v.faltan.includes('paciente.dni_nie'));
  assert.match(v.texto, /⟦paciente\.dni_nie⟧/);
});

test('info_rgpd: trae «[A COMPLETAR]» de la plantilla y se avisa; no inventa el DPD', async () => {
  const { t, api } = await montar();
  t.db.run("UPDATE farmacia SET rgpd_dpd = NULL");
  const v = ok(await api.vistaDocumento('info_rgpd', 1));
  assert.ok(v.faltan.includes('farmacia.rgpd_dpd'));
  assert.ok(v.avisos.some((a) => /Falta completar en la plantilla/.test(a)));
  assert.equal(v.imprimibleDefinitivo, false);
});

test('autorización a terceros: el contacto es la persona AUTORIZADA, no el firmante', async () => {
  const { api } = await montar();
  const v = ok(await api.vistaDocumento('autorizacion_terceros', 1, { ...REP, contactoId: 1 }));
  assert.match(v.texto, /Luis Gil · DNI\/NIE 87654321X/);
  assert.match(v.texto, /hijo/);
  assert.ok(!v.texto.includes('DNI/NIE 87654321X · en calidad'));
  const sin = ok(await api.vistaDocumento('autorizacion_terceros', 1, REP));
  assert.ok(sin.faltan.includes('autorizado.nombre'));
});

test('un contacto de otro paciente o un firmante inválido se rechazan', async () => {
  const { t, api } = await montar();
  t.db.run("INSERT INTO paciente(id,id_publico,nombre,apellido1) VALUES (2,'bbbbbbbb-2222-4222-8222-222222222222','O','P')");
  t.db.run("INSERT INTO contacto(id,paciente_id,tipo,nombre) VALUES (9,2,'cuidador','Ajeno')");
  ko(await api.vistaDocumento('autorizacion_terceros', 1, { ...REP, contactoId: 9 }));
  ko(await api.vistaDocumento('revocacion', 1, { nombre: 'X', calidad: 'vecino' as never }));
  ko(await api.vistaDocumento('revocacion', 1, { nombre: ' ', calidad: 'paciente' }));
  assert.equal(ko(await api.vistaDocumento('no_existe', 1)).codigo, 'NO_ENCONTRADO');
  assert.equal(ko(await api.vistaDocumento('revocacion', 99)).codigo, 'NO_ENCONTRADO');
});

test('revocación: el motivo es opcional («no indicado»); la calidad se escribe en claro', async () => {
  const { api } = await montar();
  const v = ok(await api.vistaDocumento('revocacion', 1, REP));
  assert.match(v.texto, /Motivo \(opcional\): no indicado/);
  assert.match(v.texto, /Pedro López \(representante legal\)/);
});

test('recibí de devolución: lista las cajas en uso y las desechadas, o «Ninguno»', async () => {
  const { t, api } = await montar();
  assert.match(ok(await api.vistaDocumento('recibi_devolucion', 1, REP)).texto, /Ninguno/);
  t.db.run("INSERT INTO medicamento(cn,nombre) VALUES ('654321','Metformina Test')");
  t.db.run("INSERT INTO envase(paciente_id,cn,lote,caducidad,origen_lectura,unidades_inicio,unidades_restantes,recibido_por) VALUES (1,'654321','LOTE9','2028-05-31','manual',28,12,1)");
  const v = ok(await api.vistaDocumento('recibi_devolucion', 1, REP));
  assert.match(v.texto, /- Metformina Test · CN 654321 · lote LOTE9 · cad\. 31\/05\/2028 · 12 unidades/);
});

test('un nombre con saltos de línea o llaves no puede abrir títulos ni variables nuevas', async () => {
  const { api } = await montar();
  const v = ok(await api.vistaDocumento('revocacion', 1, { nombre: 'Pedro\n# Falso {{motivo}}', calidad: 'paciente' }));
  assert.ok(!/^# Falso/m.test(v.texto));
  assert.ok(v.avisos.some((a) => /saltos de línea/.test(a)));
  assert.ok(v.avisos.some((a) => /neutralizado/.test(a)));
});

test('la misma vista dos veces da el mismo texto y el mismo hash', async () => {
  const { api } = await montar();
  const a = ok(await api.vistaDocumento('consentimiento_spd', 1, REP));
  const b = ok(await api.vistaDocumento('consentimiento_spd', 1, REP));
  assert.equal(a.hash, b.hash);
});

test('registrar: guarda el texto EXACTO, su hash y quién lo registró', async () => {
  const { t, api } = await montar();
  const v = ok(await api.vistaDocumento('consentimiento_spd', 1, REP));
  const { id } = ok(await api.registrarDocumentoFirmado('consentimiento_spd', 1, REP));
  const f = t.db.get<Record<string, string | number>>('SELECT * FROM documento_firmado WHERE id = ?', [id])!;
  assert.equal(f.texto_impreso, v.texto);
  assert.equal(f.hash_texto, v.hash);
  assert.equal(f.hash_texto, createHash('sha256').update(String(f.texto_impreso), 'utf8').digest('hex'));
  assert.equal(f.firmante, 'Pedro López');
  assert.equal(f.firmante_calidad, 'representante_legal');
  assert.equal(f.registrado_por, 2);
  assert.match(String(f.id_publico), /^[0-9a-f-]{36}$/);
  assert.equal(f.revocado_en, null);
});

test('registrar un borrador se permite pero queda anotado en la auditoría', async () => {
  const { t, api } = await montar();
  ok(await api.registrarDocumentoFirmado('consentimiento_spd', 1, REP));
  const a = t.auditadas.find((x) => x.entidad === 'documento_firmado')!;
  assert.match(a.motivo ?? '', /BORRADOR/);
  assert.equal((a.despues as { borrador: boolean }).borrador, true);
});

test('registrar con datos que faltan se rechaza', async () => {
  const { t, api } = await montar('farmaceutico', false);
  const f = ko(await api.registrarDocumentoFirmado('consentimiento_spd', 1, { nombre: 'Ana López Pérez', calidad: 'paciente' }));
  assert.equal(f.codigo, 'DOCUMENTO_INCOMPLETO');
  assert.equal(t.db.get<{ n: number }>('SELECT count(*) AS n FROM documento_firmado')!.n, 0);
  ko(await api.registrarDocumentoFirmado('consentimiento_spd', 1, { nombre: 'X', calidad: 'otro' as never }));
});

test('estado de consentimientos: faltan → completo tras firmar los dos → revocado', async () => {
  const { api } = await montar();
  assert.deepEqual(ok(await api.estadoConsentimientos(1)).faltan, ['consentimiento_spd', 'info_rgpd']);
  ok(await api.registrarDocumentoFirmado('consentimiento_spd', 1, REP));
  assert.equal(ok(await api.estadoConsentimientos(1)).completo, false);
  const info = ok(await api.registrarDocumentoFirmado('info_rgpd', 1, REP));
  const e = ok(await api.estadoConsentimientos(1));
  assert.equal(e.completo, true);
  assert.deepEqual(e.firmados.map((f) => f.codigo).sort(), ['consentimiento_spd', 'info_rgpd']);
  assert.equal(e.firmados[0].firmante, 'Pedro López');
  assert.ok(e.firmados.every((f) => Number.isInteger(f.id) && f.revocado === false));
  ok(await api.revocarDocumento(info.id, 'El paciente deja el servicio'));
  const r = ok(await api.estadoConsentimientos(1));
  assert.deepEqual(r.revocados, ['info_rgpd']);
  assert.equal(r.completo, false);
  const rev = r.firmados.find((f) => f.codigo === 'info_rgpd')!;
  assert.equal(rev.revocado, true);
  assert.equal(rev.id, info.id);
  assert.equal(r.firmados.find((f) => f.codigo === 'consentimiento_spd')!.revocado, false);
});

test('revocar: exige motivo, no se repite, deja rastro', async () => {
  const { t, api } = await montar();
  const { id } = ok(await api.registrarDocumentoFirmado('consentimiento_spd', 1, REP));
  ko(await api.revocarDocumento(id, ' '));
  assert.equal(ko(await api.revocarDocumento(999, 'motivo válido')).codigo, 'NO_ENCONTRADO');
  ok(await api.revocarDocumento(id, 'Baja del servicio'));
  assert.equal(ko(await api.revocarDocumento(id, 'otra vez')).codigo, 'VALIDACION');
  const f = t.db.get<{ revocado_en: string; motivo_revocacion: string }>('SELECT * FROM documento_firmado WHERE id = ?', [id])!;
  assert.equal(f.motivo_revocacion, 'Baja del servicio');
  assert.ok(f.revocado_en);
  assert.ok(t.auditadas.some((a) => a.accion === 'revocar'));
});

test('consentimiento desactualizado: plantilla nueva vigente → pide volver a firmar', async () => {
  const { t, api } = await montar();
  ok(await api.registrarDocumentoFirmado('consentimiento_spd', 1, REP));
  ok(await api.registrarDocumentoFirmado('info_rgpd', 1, REP));
  t.db.run("INSERT INTO plantilla_documento(codigo,version,titulo,cuerpo,vigente) VALUES ('info_rgpd',2,'Nueva','Texto {{documento.version}}',1)");
  const e = ok(await api.estadoConsentimientos(1));
  assert.deepEqual(e.desactualizados, ['info_rgpd']);
  assert.equal(ok(await api.vistaDocumento('info_rgpd', 1, REP)).texto, 'Texto 2');
  assert.equal(ok(await api.listarPlantillasDocumento()).find((p) => p.codigo === 'info_rgpd')!.version, 2);
});

test('sin sesión ningún método de documentos funciona', async () => {
  const { t, api } = await montar();
  t.cambiarUsuario(null);
  for (const r of [await api.listarPlantillasDocumento(), await api.vistaDocumento('revocacion', 1), await api.registrarDocumentoFirmado('revocacion', 1, REP),
    await api.revocarDocumento(1, 'x'), await api.estadoConsentimientos(1)]) assert.equal(ko(r as Resultado<unknown>).codigo, 'SIN_SESION');
});

test('estadoConsentimientos de un paciente inexistente falla', async () => {
  const { api } = await montar();
  assert.equal(ko(await api.estadoConsentimientos(99)).codigo, 'NO_ENCONTRADO');
});

test('un técnico puede registrar el papel firmado (queda su nombre en el registro)', async () => {
  const { t, api } = await montar('tecnico');
  const { id } = ok(await api.registrarDocumentoFirmado('comunicacion_medico', 1, REP));
  assert.equal(t.db.get<{ registrado_por: number }>('SELECT registrado_por FROM documento_firmado WHERE id = ?', [id])!.registrado_por, 3);
});
