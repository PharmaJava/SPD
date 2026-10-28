import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarEntradaEnvase, parsearCaducidad } from '../src/dominio/entrada-envase.ts';
import type { EntradaEnvase, ContextoEntrada } from '../src/dominio/entrada-envase.ts';
import { digitoControlGS1, GS } from '../src/dominio/gs1.ts';

const HOY = '2026-10-28';
const gtinDe = (cn: string) => { const b = '0847000' + cn; return b + digitoControlGS1(b); };
const dm = (cn: string, aammdd: string, lote: string, serie?: string) =>
  `]d201${gtinDe(cn)}17${aammdd}10${lote}` + (serie ? `${GS}21${serie}` : '');

const ctx = (extra: Partial<ContextoEntrada> = {}): ContextoEntrada => ({
  envasesExistentes: [],
  cnConocidos: new Set(['712729']),
  alertasCalidad: [],
  ...extra,
});
const ent = (extra: Partial<EntradaEnvase> = {}): EntradaEnvase => ({
  cn: '712729', lote: 'AB12C', caducidad: '2028-05-31', unidades: 28, hoy: HOY, ...extra,
});
const codigos = (l: { codigo: string }[]) => l.map(a => a.codigo);

test('caja sin DataMatrix con lote y caducidad: entrada manual correcta', () => {
  const r = validarEntradaEnvase(ent(), ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.bloqueos, []);
  assert.deepEqual(r.atencion, []);
  assert.deepEqual(r.envaseNormalizado, { cn: '712729', lote: 'AB12C', caducidad: '2028-05-31', origenLectura: 'manual', unidades: 28 });
});

test('CN con dígito de control, guion y EAN-13 normalizan al mismo CN', () => {
  for (const cn of ['712729.3', '712729-3', '7127293', 'C.N. 712729.3', gtinDe('712729').slice(1)]) {
    const r = validarEntradaEnvase(ent({ cn }), ctx());
    assert.equal(r.envaseNormalizado?.cn, '712729', cn);
  }
});

test('BLOQUEO: falta lote (ausente, vacío o sólo espacios)', () => {
  for (const lote of [undefined, '', '   ']) {
    const r = validarEntradaEnvase(ent({ lote }), ctx());
    assert.equal(r.ok, false);
    assert.ok(codigos(r.bloqueos).includes('FALTA_LOTE'));
    assert.equal(r.envaseNormalizado, undefined);
  }
});

test('BLOQUEO: falta caducidad', () => {
  for (const caducidad of [undefined, '', '  ']) {
    const r = validarEntradaEnvase(ent({ caducidad }), ctx());
    assert.ok(codigos(r.bloqueos).includes('FALTA_CADUCIDAD'));
    assert.equal(r.ok, false);
  }
});

test('BLOQUEO: caducidad inválida (no se adivina)', () => {
  for (const caducidad of ['mañana', '2028-02-30', '13/2028', '00/28', '2028-13-01', '31/12/2028', '2028']) {
    const r = validarEntradaEnvase(ent({ caducidad }), ctx());
    assert.ok(codigos(r.bloqueos).includes('CADUCIDAD_INVALIDA'), caducidad);
  }
});

test('MM/AAAA y MM/AA → último día del mes, incluido febrero bisiesto', () => {
  assert.equal(parsearCaducidad('05/2028'), '2028-05-31');
  assert.equal(parsearCaducidad('02/2028'), '2028-02-29');   // bisiesto
  assert.equal(parsearCaducidad('02/2027'), '2027-02-28');
  assert.equal(parsearCaducidad('02/2100'), '2100-02-28');   // 2100 no es bisiesto
  assert.equal(parsearCaducidad('11/27'), '2027-11-30');
  assert.equal(parsearCaducidad('2/28'), '2028-02-29');
  assert.equal(parsearCaducidad('2028-02-29'), '2028-02-29');
  assert.equal(parsearCaducidad('2027-02-29'), null);
  const r = validarEntradaEnvase(ent({ caducidad: '02/2028' }), ctx());
  assert.equal(r.envaseNormalizado?.caducidad, '2028-02-29');
  assert.ok(codigos(r.info).includes('CADUCIDAD_FIN_DE_MES'));
});

test('BLOQUEO: caducado (< hoy); caduca hoy NO está caducado pero avisa', () => {
  const ayer = validarEntradaEnvase(ent({ caducidad: '2026-10-27' }), ctx());
  assert.ok(codigos(ayer.bloqueos).includes('CADUCADO'));
  const hoy = validarEntradaEnvase(ent({ caducidad: HOY }), ctx());
  assert.equal(hoy.ok, true);
  assert.ok(codigos(hoy.atencion).includes('CADUCA_PRONTO'));
});

test('caducidad MM/AAAA del mes pasado está caducada; la del mes en curso no', () => {
  assert.ok(codigos(validarEntradaEnvase(ent({ caducidad: '09/2026' }), ctx()).bloqueos).includes('CADUCADO'));
  assert.equal(validarEntradaEnvase(ent({ caducidad: '10/2026' }), ctx()).ok, true);
});

test('ATENCIÓN: caduca en <= 60 días por defecto (límite exacto incluido)', () => {
  // 2026-10-28 + 60 = 2026-12-27
  assert.ok(codigos(validarEntradaEnvase(ent({ caducidad: '2026-12-27' }), ctx()).atencion).includes('CADUCA_PRONTO'));
  assert.ok(!codigos(validarEntradaEnvase(ent({ caducidad: '2026-12-28' }), ctx()).atencion).includes('CADUCA_PRONTO'));
});

test('ATENCIÓN: diasAvisoCaducidad configurable', () => {
  const c = ctx({ diasAvisoCaducidad: 10 });
  assert.ok(!codigos(validarEntradaEnvase(ent({ caducidad: '2026-11-30' }), c).atencion).includes('CADUCA_PRONTO'));
  assert.ok(codigos(validarEntradaEnvase(ent({ caducidad: '2026-11-07' }), c).atencion).includes('CADUCA_PRONTO'));
});

test('ATENCIÓN: caduca antes del fin previsto del periodo (igual no avisa)', () => {
  const c = ctx({ finPrevistoPeriodo: '2029-01-01' });
  assert.ok(codigos(validarEntradaEnvase(ent({ caducidad: '2028-05-31' }), c).atencion).includes('CADUCA_ANTES_DEL_PERIODO'));
  const igual = ctx({ finPrevistoPeriodo: '2028-05-31' });
  assert.ok(!codigos(validarEntradaEnvase(ent(), igual).atencion).includes('CADUCA_ANTES_DEL_PERIODO'));
});

test('BLOQUEO: lote con alerta de calidad por CN + lote', () => {
  const c = ctx({ alertasCalidad: [{ cn: '712729', lote: 'AB12C', referencia: 'R_21/2026' }] });
  const r = validarEntradaEnvase(ent(), c);
  assert.equal(r.ok, false);
  assert.ok(codigos(r.bloqueos).includes('LOTE_CON_ALERTA'));
  assert.match(r.bloqueos.find(b => b.codigo === 'LOTE_CON_ALERTA')!.texto, /R_21\/2026/);
});

test('alerta de CN + lote NO bloquea otro lote ni otro CN', () => {
  const c = ctx({ alertasCalidad: [{ cn: '712729', lote: 'ZZ99', referencia: 'R_1/2026' }, { cn: '999999', lote: 'AB12C', referencia: 'R_2/2026' }] });
  assert.equal(validarEntradaEnvase(ent(), c).ok, true);
});

test('BLOQUEO: alerta con sólo lote (sin CN) bloquea ese lote en cualquier CN, sin distinguir mayúsculas', () => {
  const c = ctx({ alertasCalidad: [{ lote: 'ab12c', referencia: 'R_9/2026' }] });
  const r = validarEntradaEnvase(ent(), c);
  assert.ok(codigos(r.bloqueos).includes('LOTE_CON_ALERTA'));
});

test('BLOQUEO: alerta de CN sin lote afecta a todos los lotes de ese CN', () => {
  const c = ctx({ alertasCalidad: [{ cn: '712729.3', referencia: 'R_3/2026' }] });
  assert.ok(codigos(validarEntradaEnvase(ent(), c).bloqueos).includes('LOTE_CON_ALERTA'));
  assert.equal(validarEntradaEnvase(ent({ cn: '111111' }), c).ok, true);
});

test('una alerta sin CN ni lote no identifica nada y no bloquea', () => {
  const c = ctx({ alertasCalidad: [{ referencia: 'R_0/2026' }] });
  assert.equal(validarEntradaEnvase(ent(), c).ok, true);
});

test('BLOQUEO: nº de serie repetido para el mismo CN', () => {
  const c = ctx({ envasesExistentes: [{ cn: '712729', numeroSerie: 'S1', lote: 'AB12C', estado: 'en_stock' }] });
  const r = validarEntradaEnvase(ent({ numeroSerie: 'S1' }), c);
  assert.ok(codigos(r.bloqueos).includes('SERIE_REPETIDA'));
});

test('el mismo nº de serie con OTRO CN no bloquea (la serie sólo es única por producto)', () => {
  const c = ctx({ envasesExistentes: [{ cn: '999999', numeroSerie: 'S1', lote: 'X', estado: 'en_stock' }] });
  assert.equal(validarEntradaEnvase(ent({ numeroSerie: 'S1' }), c).ok, true);
});

test('sin nº de serie (caja sin DataMatrix) no hay nada que comparar', () => {
  const c = ctx({ envasesExistentes: [{ cn: '712729', lote: 'AB12C', estado: 'en_stock' }] });
  assert.equal(validarEntradaEnvase(ent(), c).ok, true);
});

test('serie repetida detectada también cuando viene del DataMatrix', () => {
  const c = ctx({ envasesExistentes: [{ cn: '712729', numeroSerie: 'SER1', lote: 'L1', estado: 'devuelto' }] });
  const r = validarEntradaEnvase(ent({ cn: '', lote: undefined, caducidad: undefined, lecturaDatamatrix: dm('712729', '280531', 'L1', 'SER1') }), c);
  assert.ok(codigos(r.bloqueos).includes('SERIE_REPETIDA'));
});

test('BLOQUEO: CN no válido (vacío, corto, EAN extranjero)', () => {
  for (const cn of ['', '12345', 'abc', '4006381333931']) {
    const r = validarEntradaEnvase(ent({ cn }), ctx());
    assert.ok(codigos(r.bloqueos).includes('CN_INVALIDO'), cn);
  }
});

test('BLOQUEO: unidades <= 0, NaN o no múltiplo de 0,25', () => {
  for (const unidades of [0, -1, NaN, Infinity]) {
    assert.ok(codigos(validarEntradaEnvase(ent({ unidades }), ctx()).bloqueos).includes('UNIDADES_INVALIDAS'), String(unidades));
  }
  for (const unidades of [0.3, 28.1, 0.1]) {
    assert.ok(codigos(validarEntradaEnvase(ent({ unidades }), ctx()).bloqueos).includes('UNIDADES_NO_MULTIPLO'), String(unidades));
  }
});

test('unidades fraccionarias válidas: 0,25 · 0,5 · 28,75', () => {
  for (const unidades of [0.25, 0.5, 28.75, 100]) {
    assert.equal(validarEntradaEnvase(ent({ unidades }), ctx()).ok, true, String(unidades));
  }
});

test('ATENCIÓN: CN distinto del último de la línea', () => {
  const c = ctx({ cnUltimoDeLaLinea: '654321', cnConocidos: new Set(['712729', '654321']) });
  const r = validarEntradaEnvase(ent(), c);
  assert.equal(r.ok, true);
  assert.ok(codigos(r.atencion).includes('CN_DISTINTO_DE_LA_LINEA'));
  assert.match(r.atencion.find(a => a.codigo === 'CN_DISTINTO_DE_LA_LINEA')!.texto, /descripción física/);
});

test('mismo CN que el último de la línea (en otra forma) no avisa', () => {
  const c = ctx({ cnUltimoDeLaLinea: '712729.3' });
  assert.ok(!codigos(validarEntradaEnvase(ent(), c).atencion).includes('CN_DISTINTO_DE_LA_LINEA'));
});

test('ATENCIÓN: CN desconocido en el catálogo local', () => {
  const r = validarEntradaEnvase(ent({ cn: '555555' }), ctx());
  assert.equal(r.ok, true);
  assert.ok(codigos(r.atencion).includes('CN_DESCONOCIDO'));
});

test('lote con espacios: se normaliza (trim + colapsar) y se AVISA', () => {
  const r = validarEntradaEnvase(ent({ lote: '  AB  12C ' }), ctx());
  assert.equal(r.envaseNormalizado?.lote, 'AB 12C');
  assert.ok(codigos(r.atencion).includes('LOTE_NORMALIZADO'));
});

test('lote en minúsculas: se conserva tal cual y se informa', () => {
  const r = validarEntradaEnvase(ent({ lote: 'ab12c' }), ctx());
  assert.equal(r.envaseNormalizado?.lote, 'ab12c');
  assert.ok(codigos(r.info).includes('LOTE_CON_MINUSCULAS'));
  assert.ok(!codigos(r.atencion).includes('LOTE_NORMALIZADO'));
});

test('lote ya limpio no genera avisos de normalización', () => {
  const r = validarEntradaEnvase(ent({ lote: 'Ab12C' }), ctx());
  assert.equal(r.envaseNormalizado?.lote, 'Ab12C');
  assert.ok(!codigos(r.atencion).includes('LOTE_NORMALIZADO'));
});

test('DataMatrix: rellena CN, lote, caducidad y serie que faltan', () => {
  const r = validarEntradaEnvase(
    ent({ cn: '', lote: undefined, caducidad: undefined, lecturaDatamatrix: dm('712729', '280531', 'LOTE7', 'SER9') }), ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.envaseNormalizado, {
    cn: '712729', lote: 'LOTE7', caducidad: '2028-05-31', numeroSerie: 'SER9', origenLectura: 'datamatrix', unidades: 28,
  });
  assert.deepEqual(r.atencion, []);
});

test('DataMatrix coherente con el teclado: sin avisos de contradicción', () => {
  const r = validarEntradaEnvase(ent({ lote: 'LOTE7', caducidad: '31/05/2028'.slice(3), lecturaDatamatrix: dm('712729', '280531', 'LOTE7') }), ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.atencion, []);
  assert.equal(r.envaseNormalizado?.origenLectura, 'datamatrix');
});

test('código CONTRADICTORIO con el teclado: gana el código y se avisa (lote, caducidad y CN)', () => {
  const c = ctx({ cnConocidos: new Set(['712729', '654321']) });
  const r = validarEntradaEnvase(ent({ cn: '654321', lote: 'TECLADO', caducidad: '2030-01-31', lecturaDatamatrix: dm('712729', '280531', 'LOTE7') }), c);
  assert.equal(r.ok, true);
  assert.equal(r.envaseNormalizado?.cn, '712729');
  assert.equal(r.envaseNormalizado?.lote, 'LOTE7');
  assert.equal(r.envaseNormalizado?.caducidad, '2028-05-31');
  const cods = codigos(r.atencion);
  assert.ok(cods.includes('CN_CONTRADICE_CODIGO'));
  assert.ok(cods.includes('LOTE_CONTRADICE_CODIGO'));
  assert.ok(cods.includes('CADUCIDAD_CONTRADICE_CODIGO'));
});

test('nº de serie tecleado que contradice al código: gana el código y se avisa', () => {
  const r = validarEntradaEnvase(ent({ numeroSerie: 'OTRA', lecturaDatamatrix: dm('712729', '280531', 'LOTE7', 'SER9') }), ctx());
  assert.equal(r.envaseNormalizado?.numeroSerie, 'SER9');
  assert.ok(codigos(r.atencion).includes('SERIE_CONTRADICE_CODIGO'));
});

test('lectura AMBIGUA (sin separador GS): error pidiendo confirmar y no se usa ninguna interpretación', () => {
  const lectura = `01${gtinDe('712729')}1728053110AB1221SER9`;
  const r = validarEntradaEnvase(ent({ lote: undefined, caducidad: undefined, lecturaDatamatrix: lectura }), ctx());
  assert.equal(r.ok, false);
  assert.deepEqual(codigos(r.bloqueos), ['LECTURA_AMBIGUA']);
  assert.match(r.bloqueos[0].texto, /confirma/i);
  assert.equal(r.envaseNormalizado, undefined);
});

test('lectura ambigua + lote tecleado correcto: sigue bloqueando hasta confirmar', () => {
  const lectura = `01${gtinDe('712729')}1728053110AB1221SER9`;
  const r = validarEntradaEnvase(ent({ lote: 'AB12', lecturaDatamatrix: lectura }), ctx());
  assert.equal(r.ok, false);
  assert.ok(codigos(r.bloqueos).includes('LECTURA_AMBIGUA'));
});

test('DataMatrix ilegible: se usa la entrada manual y se avisa (no se bloquea si lote y caducidad están)', () => {
  const r = validarEntradaEnvase(ent({ lecturaDatamatrix: 'basura' }), ctx());
  assert.equal(r.ok, true);
  assert.ok(codigos(r.atencion).includes('LECTURA_NO_VALIDA'));
  assert.equal(r.envaseNormalizado?.origenLectura, 'manual');
});

test('DataMatrix ilegible y sin lote ni caducidad tecleados: bloquea las dos cosas', () => {
  const r = validarEntradaEnvase(ent({ lote: undefined, caducidad: undefined, lecturaDatamatrix: 'basura' }), ctx());
  assert.deepEqual(codigos(r.bloqueos).sort(), ['FALTA_CADUCIDAD', 'FALTA_LOTE']);
});

test('DataMatrix caducado: bloquea aunque el teclado diga otra cosa', () => {
  const r = validarEntradaEnvase(ent({ caducidad: '2030-01-01', lecturaDatamatrix: dm('712729', '260930', 'L1') }), ctx());
  assert.ok(codigos(r.bloqueos).includes('CADUCADO'));
});

test('alerta de calidad detectada con el lote que viene del DataMatrix', () => {
  const c = ctx({ alertasCalidad: [{ cn: '712729', lote: 'LOTE7', referencia: 'R_5/2026' }] });
  const r = validarEntradaEnvase(ent({ lote: undefined, lecturaDatamatrix: dm('712729', '280531', 'LOTE7') }), c);
  assert.ok(codigos(r.bloqueos).includes('LOTE_CON_ALERTA'));
});

test('varios bloqueos a la vez se acumulan todos', () => {
  const c = ctx({ alertasCalidad: [{ lote: 'AB12C', referencia: 'R_1/2026' }] });
  const r = validarEntradaEnvase(ent({ caducidad: '2020-01-01', unidades: 0 }), c);
  assert.deepEqual(codigos(r.bloqueos).sort(), ['CADUCADO', 'LOTE_CON_ALERTA', 'UNIDADES_INVALIDAS']);
});

test('«hoy» inválido es un error de programación, no un resultado', () => {
  assert.throws(() => validarEntradaEnvase(ent({ hoy: '28/10/2026' }), ctx()), RangeError);
});
