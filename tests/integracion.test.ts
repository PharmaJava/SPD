/**
 * Pruebas de INTEGRACIÓN entre módulos de src/dominio/.
 *
 * Cada módulo tiene su prueba unitaria; aquí se compone el flujo completo:
 *   pauta → tomas → blíster → reparto a cajas → caducidad del SPD →
 *   etiqueta → entrada de cajas (DataMatrix real) → auditoría.
 *
 * Convención de este fichero:
 *  - `test(...)` normal  = comportamiento que HOY encaja y debe seguir encajando.
 *  - `test(..., { todo })` = DESAJUSTE conocido entre módulos: la prueba describe
 *    lo que DEBERÍA pasar y falla hoy. No rompe la suite; al arreglar el módulo
 *    se quita el `todo`.
 *  - `test('BRECHA: ...')` normal = fija el comportamiento actual de un desajuste
 *    para que un cambio no pase inadvertido (ver informe).
 *
 * El «pegamento» (glue) que ningún módulo ofrece vive aquí, en helpers marcados
 * con `GLUE:`; cada uno es candidato a pasar a src/dominio/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tomasDelPeriodo, unidadesTotales, pautaVigenteEn, validarPauta, avisosPauta } from '../src/dominio/calendario-pauta.ts';
import { construirMapas, ubicarToma } from '../src/dominio/disposicion-blister.ts';
import type { MapaBlister } from '../src/dominio/disposicion-blister.ts';
import { repartirTomas, aplicarConsumo } from '../src/dominio/consumo-envases.ts';
import type { ResultadoTomas } from '../src/dominio/consumo-envases.ts';
import { calcularCaducidadSpd, periodoCabe, puedeValidar } from '../src/dominio/caducidad-spd.ts';
import type { ResultadoCaducidad } from '../src/dominio/caducidad-spd.ts';
import { filasTablaTomas, renderizarEtiqueta, validarPlantilla } from '../src/dominio/etiquetas.ts';
import type { Plantilla, TomaEntrada } from '../src/dominio/etiquetas.ts';
import { validarEntradaEnvase } from '../src/dominio/entrada-envase.ts';
import type { ContextoEntrada, EnvaseExistente, EnvaseNormalizado } from '../src/dominio/entrada-envase.ts';
import { digitoControlGS1, GS } from '../src/dominio/gs1.ts';
import { crearEntrada, verificarCadena, HASH_GENESIS } from '../src/dominio/auditoria.ts';
import type { EntradaAuditoria } from '../src/dominio/auditoria.ts';
import type { Envase, MomentoToma, Pauta, TomaDia } from '../src/dominio/tipos.ts';

// ───────────────────────── datos comunes ─────────────────────────

const HOY = '2026-10-28';                 // miércoles
const INICIO = '2026-11-04';              // miércoles (día de la semana 3)
const FIN_14 = '2026-11-17';              // INICIO + 13 días
const PREPARACION = '2026-11-03';

const MOMENTOS: MomentoToma[] = [
  { id: 1, nombre: 'Desayuno', orden: 1 },
  { id: 2, nombre: 'Comida', orden: 2 },
  { id: 3, nombre: 'Cena', orden: 3 },
];
const NOMBRE_MOMENTO = new Map(MOMENTOS.map(m => [m.id, m.nombre]));

const MS = 86_400_000;
const sumar = (f: string, n: number) => new Date(Date.parse(f + 'T00:00:00Z') + n * MS).toISOString().slice(0, 10);
const rango = (desde: string, dias: number) => Array.from({ length: dias }, (_, i) => sumar(desde, i));
const dow = (f: string) => { const d = new Date(f + 'T00:00:00Z').getUTCDay(); return d === 0 ? 7 : d; };

/** DataMatrix GS1 real: ]d2 + (01)GTIN-14 español + (17)AAMMDD + (10)lote [+ GS (21)serie]. */
function dm(cn: string, lote: string, caducidadAAMMDD: string, serie?: string): string {
  const base = '0847000' + cn;
  return `]d201${base}${digitoControlGS1(base)}17${caducidadAAMMDD}10${lote}` + (serie ? `${GS}21${serie}` : '');
}

// ───────────────────────── GLUE (candidato a src/dominio/) ─────────────────────────

interface Med {
  nombre: string;
  tratamientoId: number;
  versiones: Pauta[];
  envases: Envase[];
}

/** GLUE: tomas de un medicamento con VERSIONES de pauta (la vigente cada día). */
function tomasVersionadas(versiones: Pauta[], desde: string, dias: number): TomaDia[] {
  const out: TomaDia[] = [];
  for (const f of rango(desde, dias)) {
    const p = pautaVigenteEn(versiones, f);
    if (p) out.push(...tomasDelPeriodo(p, f, f));
  }
  return out;
}

/** GLUE: de las cajas del medicamento, la caja y el lote de cada línea. */
const cajaDe = (med: Med, id: number): Envase => {
  const e = med.envases.find(x => x.id === id);
  if (!e) throw new Error(`caja ${id} no existe`);
  return e;
};

interface Preparacion {
  desde: string;
  dias: number;
  fin: string;
  meds: Med[];
  tomas: TomaDia[][];            // por medicamento
  repartos: ResultadoTomas[];    // por medicamento
  mapas: MapaBlister[];
  celdasSinUbicar: string[];     // tomas sin celda en el blíster
  caducidad: ResultadoCaducidad;
  cabe: boolean;
  validable: boolean;
  motivos: string[];
  tomasEtiqueta: TomaEntrada[];
}

interface CfgPrep {
  desde: string;
  dias: number;
  fechaPreparacion: string;
  meds: Med[];
  diasValidez?: number;
  validezExtendidaPermitida?: boolean;
  justificacion?: string;
  rol?: Parameters<typeof puedeValidar>[0];
  inicioDia?: 'convencional' | 'cronologico';
}

/** GLUE: orquesta todo el flujo y decide si la preparación es VALIDABLE. */
function preparar(cfg: CfgPrep): Preparacion {
  const fin = sumar(cfg.desde, cfg.dias - 1);
  const tomas = cfg.meds.map(m => tomasVersionadas(m.versiones, cfg.desde, cfg.dias));
  const repartos = cfg.meds.map((m, i) =>
    repartirTomas(m.envases, tomas[i], { fechaPreparacion: cfg.fechaPreparacion, fechaFinPeriodo: fin }));
  const mapas = construirMapas(cfg.desde, cfg.dias, MOMENTOS, { inicioDia: cfg.inicioDia ?? 'convencional' });
  const celdasSinUbicar: string[] = [];
  tomas.forEach((ts, i) => ts.forEach(t => {
    if (!ubicarToma(mapas, t.fecha, t.momentoId)) celdasSinUbicar.push(`${cfg.meds[i].nombre} ${t.fecha} m${t.momentoId}`);
  }));

  const lotesUsados = new Set<string>();
  const caducidades: string[] = [];
  repartos.forEach((r, i) => r.lineas.forEach(l => {
    const c = cajaDe(cfg.meds[i], l.envaseId);
    if (!lotesUsados.has(`${i}|${c.lote}`)) { lotesUsados.add(`${i}|${c.lote}`); caducidades.push(c.caducidad); }
  }));
  const caducidad = caducidades.length === 0
    ? { ok: false, fueraDeEstandar: false, avisos: [], errores: ['No se ha usado ningún lote.'] } as ResultadoCaducidad
    : calcularCaducidadSpd({
      caducidadesLotes: caducidades, fechaPreparacion: cfg.fechaPreparacion,
      diasValidez: cfg.diasValidez ?? 14, validezExtendidaPermitida: cfg.validezExtendidaPermitida ?? false,
      justificacion: cfg.justificacion,
    });
  const cabe = caducidad.ok && caducidad.caducidadSpd !== undefined && periodoCabe(fin, caducidad.caducidadSpd);

  const motivos: string[] = [];
  repartos.forEach((r, i) => { if (!r.ok) motivos.push(`${cfg.meds[i].nombre}: faltan ${r.faltan}`); });
  if (!caducidad.ok) motivos.push(...caducidad.errores);
  else if (!cabe) motivos.push('El periodo no cabe en la caducidad del SPD.');
  if (celdasSinUbicar.length) motivos.push(`Tomas sin celda: ${celdasSinUbicar.join(', ')}`);
  if (!puedeValidar(cfg.rol ?? 'farmaceutico')) motivos.push('El rol no puede validar.');

  // Etiqueta: una entrada por (fecha, momento) con TODAS las líneas (lotes múltiples incluidos).
  const grupos = new Map<string, TomaEntrada>();
  repartos.forEach((r, i) => r.lineas.forEach(l => {
    const k = `${l.fecha}|${String(l.momentoId).padStart(3, '0')}`;
    const g = grupos.get(k) ?? { fecha: l.fecha, momentoNombre: NOMBRE_MOMENTO.get(l.momentoId) ?? `?${l.momentoId}`, medicamentos: [] };
    const c = cajaDe(cfg.meds[i], l.envaseId);
    g.medicamentos.push({ nombre: cfg.meds[i].nombre, unidades: l.unidades, lote: c.lote, caducidad: c.caducidad });
    grupos.set(k, g);
  }));
  const tomasEtiqueta = [...grupos.keys()].sort().map(k => grupos.get(k)!);

  return { desde: cfg.desde, dias: cfg.dias, fin, meds: cfg.meds, tomas, repartos, mapas, celdasSinUbicar, caducidad, cabe, validable: motivos.length === 0, motivos, tomasEtiqueta };
}

/** GLUE: unidades por (fecha, momento) a partir del reparto, para cruzarlas con el mapa. */
const sumaUnidades = (xs: { unidades: number }[]) => xs.reduce((s, x) => s + Math.round(x.unidades * 4), 0) / 4;

// ───────────────────────── plantilla de etiqueta (docs/07 §7.3) ─────────────────────────

const PLANTILLA_DOC07: Plantilla = {
  pagina: { ancho_mm: 100, alto_mm: 150, orientacion: 'vertical' },
  plancha: null,
  margenes_mm: [3, 3, 3, 3],
  fuente_base_pt: 7,
  bloques: [
    { tipo: 'texto', x: 0, y: 0, w: 94, h: 8, contenido: '{{farmacia.nombre}} · {{farmacia.telefono}}', negrita: true },
    { tipo: 'texto', x: 0, y: 9, w: 94, h: 6, contenido: '{{paciente.nombre_completo}}', tam_pt: 10 },
    { tipo: 'tabla_tomas', x: 0, y: 16, w: 94, h: 80, columnas: ['medicamento', 'descripcion', 'momentos', 'lote_caducidad'] },
    { tipo: 'aparte', x: 0, y: 98, w: 70, h: 20 },
    { tipo: 'codigo', simbologia: 'qrcode', x: 74, y: 98, w: 20, h: 20, contenido: '{{preparacion.id_publico}}' },
    { tipo: 'texto', x: 0, y: 120, w: 94, h: 20,
      contenido: 'Del {{periodo.inicio}} al {{periodo.fin}} · Caduca {{preparacion.caducidad}} · Prep. {{prep.iniciales}} / Val. {{val.iniciales}}' },
  ],
};

/** Misma estructura que docs/07 pero en A4 (la de 100×150 no admite 14 días de tomas: ver BRECHA). */
const PLANTILLA_A4: Plantilla = {
  ...PLANTILLA_DOC07,
  pagina: { ancho_mm: 210, alto_mm: 297, orientacion: 'vertical' },
  bloques: [
    { tipo: 'texto', x: 0, y: 0, w: 204, h: 8, contenido: '{{farmacia.nombre}} · {{farmacia.telefono}}', negrita: true },
    { tipo: 'texto', x: 0, y: 9, w: 204, h: 6, contenido: '{{paciente.nombre_completo}}', tam_pt: 10 },
    { tipo: 'tabla_tomas', x: 0, y: 16, w: 204, h: 200, columnas: ['medicamento', 'descripcion', 'momentos', 'lote_caducidad'] },
    { tipo: 'aparte', x: 0, y: 218, w: 150, h: 20 },
    { tipo: 'codigo', simbologia: 'qrcode', x: 160, y: 218, w: 20, h: 20, contenido: '{{preparacion.id_publico}}' },
    { tipo: 'texto', x: 0, y: 240, w: 204, h: 20,
      contenido: 'Del {{periodo.inicio}} al {{periodo.fin}} · Caduca {{preparacion.caducidad}} · Prep. {{prep.iniciales}} / Val. {{val.iniciales}}' },
  ],
};

function datosEtiqueta(p: Preparacion, caducidadSpd: string, tomas?: TomaEntrada[]): Record<string, unknown> {
  return {
    farmacia: { nombre: 'Farmacia Ñandú', telefono: '954 000 000', direccion: 'C/ Sierpes 1' },
    paciente: { nombre_completo: 'María Peña Núñez', id_corto: 'MPN-01' },
    preparacion: { id_publico: 'SPD-8F3K', caducidad: caducidadSpd },
    periodo: { inicio: p.desde, fin: p.fin },
    prep: { iniciales: 'AB' }, val: { iniciales: 'CD' },
    tomas: tomas ?? p.tomasEtiqueta,
    aparte: [],
  };
}

// ───────────────────────── escenario (a): entrada de cajas con DataMatrix ─────────────────────────

const CN_METFORMINA = '712729';
const CN_ALENDRONATO = '654321';
const CN_CICLO = '501234';

interface Libro { existentes: EnvaseExistente[]; cn: Set<string> }
const contexto = (l: Libro, extra: Partial<ContextoEntrada> = {}): ContextoEntrada => ({
  envasesExistentes: l.existentes, cnConocidos: l.cn, alertasCalidad: [], finPrevistoPeriodo: FIN_14, ...extra,
});

/** GLUE: de una entrada validada a un Envase de custodia (id y tratamiento los pone la capa de datos).
 *  OJO: `numeroSerie: undefined` explícito haría fallar la auditoría (ver BRECHA de auditoría): se omite la clave. */
function aEnvase(n: EnvaseNormalizado, id: number, tratamientoId: number): Envase {
  return { id, tratamientoId, cn: n.cn, lote: n.lote, caducidad: n.caducidad, ...(n.numeroSerie ? { numeroSerie: n.numeroSerie } : {}), unidadesRestantes: n.unidades, estado: 'en_uso' };
}

function entrarCaja(l: Libro, id: number, trat: number, e: Parameters<typeof validarEntradaEnvase>[0], extra: Partial<ContextoEntrada> = {}): Envase {
  const r = validarEntradaEnvase(e, contexto(l, extra));
  assert.ok(r.ok, `entrada rechazada: ${JSON.stringify(r.bloqueos)}`);
  const env = aEnvase(r.envaseNormalizado!, id, trat);
  l.existentes.push({ cn: env.cn, numeroSerie: env.numeroSerie, lote: env.lote, estado: env.estado });
  return env;
}

const PAUTA_METFORMINA: Pauta = { vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1.5 }, { momentoId: 3, unidades: 1 }] };
const PAUTA_ALENDRONATO: Pauta = { vigenteDesde: INICIO, patron: 'dias_semana', diasSemana: [1], dosis: [{ momentoId: 1, unidades: 1 }] };
const PAUTA_CICLO: Pauta = { vigenteDesde: INICIO, patron: 'ciclo', cicloOn: 5, cicloOff: 2, fechaAncla: INICIO, dosis: [{ momentoId: 3, unidades: 1 }] };

/** Escenario (a): 3 medicamentos, metformina con 3 cajas de lotes distintos (una entrada MANUAL). */
function escenarioA() {
  const libro: Libro = { existentes: [], cn: new Set([CN_METFORMINA, CN_ALENDRONATO, CN_CICLO]) };
  const metformina: Med = {
    nombre: 'Metformina 850 mg', tratamientoId: 1, versiones: [PAUTA_METFORMINA],
    envases: [
      entrarCaja(libro, 11, 1, { cn: '', unidades: 12, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'M-A', '270228', 'SA1') }),
      // Manual, sin DataMatrix: MM/AAAA → último día del mes
      entrarCaja(libro, 12, 1, { cn: CN_METFORMINA, lote: 'M-B', caducidad: '12/2026', unidades: 8.5, hoy: HOY }),
      entrarCaja(libro, 13, 1, { cn: '', unidades: 20, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'M-C', '280131', 'SC1') }),
    ],
  };
  const alendronato: Med = {
    nombre: 'Alendronato 70 mg', tratamientoId: 2, versiones: [PAUTA_ALENDRONATO],
    envases: [entrarCaja(libro, 21, 2, { cn: '', unidades: 4, hoy: HOY, lecturaDatamatrix: dm(CN_ALENDRONATO, 'AL1', '271130', 'SD1') })],
  };
  const ciclo: Med = {
    nombre: 'Medicamento en ciclo 5+2', tratamientoId: 3, versiones: [PAUTA_CICLO],
    envases: [entrarCaja(libro, 31, 3, { cn: '', unidades: 30, hoy: HOY, lecturaDatamatrix: dm(CN_CICLO, 'CI1', '270930', 'SE1') })],
  };
  return { libro, metformina, alendronato, ciclo, meds: [metformina, alendronato, ciclo] };
}

// ════════════════════════════ ESCENARIO (a) ════════════════════════════

test('(a) entrada de cajas: DataMatrix real y entrada manual normalizan a los mismos tipos', () => {
  const { metformina } = escenarioA();
  const [a, b, c] = metformina.envases;
  assert.deepEqual([a.cn, a.lote, a.caducidad, a.numeroSerie], [CN_METFORMINA, 'M-A', '2027-02-28', 'SA1']);
  // manual: MM/AAAA → fin de mes, sin serie
  assert.deepEqual([b.cn, b.lote, b.caducidad, b.numeroSerie], [CN_METFORMINA, 'M-B', '2026-12-31', undefined]);
  assert.deepEqual([c.lote, c.caducidad], ['M-C', '2028-01-31']);
  assert.ok([a, b, c].every(e => e.estado === 'en_uso'));
});

test('(a) pauta → tomas: 35 + 2 + 10 unidades y coherencia con unidadesTotales', () => {
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  assert.deepEqual(p.tomas.map(ts => sumaUnidades(ts)), [35, 2, 10]);
  assert.deepEqual(
    meds.map(m => unidadesTotales(m.versiones[0], INICIO, FIN_14)),
    [35, 2, 10],
  );
  // alendronato semanal: sólo los dos lunes del periodo, en el momento 1
  assert.deepEqual(p.tomas[1].map(t => t.fecha), ['2026-11-09', '2026-11-16']);
  assert.ok(p.tomas[1].every(t => dow(t.fecha) === 1 && t.momentoId === 1));
  // ciclo 5+2 anclado al inicio: 4-8 y 11-15 → 10 tomas
  assert.equal(p.tomas[2].length, 10);
  assert.ok(avisosPauta(PAUTA_ALENDRONATO).some(a => a.includes('PAUTA SEMANAL')));
});

test('(a) invariante: unidades en celdas del mapa == unidadesTotales == suma asignada a cajas', () => {
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  assert.deepEqual(p.celdasSinUbicar, []);
  assert.equal(p.mapas.length, 2);

  for (const modo of ['convencional', 'cronologico'] as const) {
    const mapas = construirMapas(INICIO, 14, MOMENTOS, { inicioDia: modo });
    let enCeldas = 0;
    const porCelda = new Map<string, number>();
    p.tomas.forEach(ts => ts.forEach(t => {
      const u = ubicarToma(mapas, t.fecha, t.momentoId);
      assert.ok(u, `${modo}: toma sin celda ${t.fecha} m${t.momentoId}`);
      assert.equal(u.celda.fecha, t.fecha);
      assert.equal(u.celda.momentoId, t.momentoId);
      assert.ok(u.celda.usada);
      enCeldas += Math.round(t.unidades * 4);
      const k = `${u.mapa.indice}|${u.celda.fila}|${u.celda.columna}`;
      porCelda.set(k, (porCelda.get(k) ?? 0) + Math.round(t.unidades * 4));
    }));
    // celdas distintas ↔ (fecha,momento) distintos: dos medicamentos en la misma celda se suman
    const distintas = new Set(p.tomas.flat().map(t => `${t.fecha}|${t.momentoId}`));
    assert.equal(porCelda.size, distintas.size, `${modo}: una celda por (fecha,momento)`);
    const total = enCeldas / 4;
    const pauta = meds.reduce((s, m) => s + unidadesTotales(m.versiones[0], INICIO, FIN_14), 0);
    const asignado = p.repartos.reduce((s, r) => s + sumaUnidades(r.lineas), 0);
    assert.equal(total, 47);
    assert.equal(total, pauta);
    assert.equal(total, asignado);
  }
  // por medicamento
  p.repartos.forEach((r, i) => assert.equal(sumaUnidades(r.lineas), unidadesTotales(meds[i].versiones[0], INICIO, FIN_14)));
});

test('(a) reparto: FEFO entre 3 lotes y una toma con DOS lotes', () => {
  const { metformina } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [metformina] });
  const r = p.repartos[0];
  assert.ok(r.ok);
  const porCaja = new Map<number, number>();
  for (const l of r.lineas) porCaja.set(l.envaseId, (porCaja.get(l.envaseId) ?? 0) + l.unidades);
  // M-B (2026-12-31) primero, luego M-A, luego M-C
  assert.equal(porCaja.get(12), 8.5);
  assert.equal(porCaja.get(11), 12);
  assert.equal(porCaja.get(13), 14.5);
  // exactamente dos tomas partidas entre lotes (8,5 y 20,5 caen a mitad de toma de 1,5)
  const claves = r.lineas.map(l => `${l.fecha}|${l.momentoId}`);
  const partidas = [...new Set(claves)].filter(k => claves.filter(x => x === k).length === 2);
  assert.equal(partidas.length, 2);
  assert.equal(r.avisos.filter(a => a.startsWith('Toma con dos lotes')).length, 2);
});

test('(a) caducidad del SPD (14 días) limitada por el lote que antes caduca y periodoCabe', () => {
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  // todos los lotes caducan después → manda la validez: preparación + 14
  assert.equal(p.caducidad.ok, true);
  assert.equal(p.caducidad.caducidadSpd, '2026-11-17');
  assert.equal(p.caducidad.limitadaPor, 'validez');
  assert.equal(p.caducidad.fueraDeEstandar, false);
  assert.equal(p.fin, FIN_14);
  assert.equal(p.cabe, true);
  assert.equal(periodoCabe('2026-11-18', p.caducidad.caducidadSpd!), false);
  assert.equal(p.validable, true, p.motivos.join(' | '));
});

test('(a) consumo: aplicarConsumo acepta las líneas del reparto y deja las cajas coherentes', () => {
  const { metformina } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [metformina] });
  const despues = aplicarConsumo(metformina.envases, p.repartos[0].lineas);
  const antes = metformina.envases.reduce((s, e) => s + e.unidadesRestantes, 0);
  const resto = despues.reduce((s, e) => s + e.unidadesRestantes, 0);
  assert.equal(antes - resto, 35);
  assert.equal(despues.find(e => e.id === 12)!.estado, 'agotado');
  assert.equal(despues.find(e => e.id === 11)!.estado, 'agotado');
  assert.equal(despues.find(e => e.id === 13)!.unidadesRestantes, 5.5);
  // no muta los originales
  assert.equal(metformina.envases.find(e => e.id === 12)!.estado, 'en_uso');
});

test('(a) etiqueta: muestra TODOS los lotes usados, incluida la toma con dos lotes (plantilla docs/07 en A4)', () => {
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  assert.deepEqual(validarPlantilla(PLANTILLA_A4), []);
  const r = renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, p.caducidad.caducidadSpd!));
  assert.equal(r.cabe, true, r.problemas.join(' | '));
  assert.deepEqual(r.faltan, []);
  assert.equal(r.imprimible, true);
  // todos los lotes de todas las cajas usadas
  for (const lote of ['M-A', 'M-B', 'M-C', 'AL1', 'CI1']) assert.ok(r.html.includes(`Lote ${lote}`), `falta el lote ${lote}`);
  // la etiqueta lleva la caducidad del SPD y el periodo
  assert.ok(r.html.includes('Caduca 2026-11-17'));
  assert.ok(r.html.includes(`Del ${INICIO} al ${FIN_14}`));

  // cada línea de la etiqueta cuadra con el reparto
  const filas = filasTablaTomas(p.tomasEtiqueta);
  const lineas = p.repartos.flatMap(x => x.lineas);
  assert.equal(filas.length, lineas.length);
  assert.equal(sumaUnidades(filas), sumaUnidades(lineas));
  assert.equal((r.html.match(/<tr>/g) ?? []).length, filas.length);
  p.repartos.forEach((rep, i) => rep.lineas.forEach(l => {
    const c = cajaDe(meds[i], l.envaseId);
    assert.ok(
      filas.some(f => f.fecha === l.fecha && f.momento === NOMBRE_MOMENTO.get(l.momentoId) && f.medicamento === meds[i].nombre
        && f.unidades === l.unidades && f.lote === c.lote && f.caducidad === c.caducidad),
      `línea sin fila en la etiqueta: ${JSON.stringify(l)}`);
  }));
  // la toma con dos lotes: dos filas del mismo (fecha, momento, medicamento) con lotes distintos
  const dobles = new Map<string, Set<string>>();
  for (const f of filas) {
    const k = `${f.fecha}|${f.momento}|${f.medicamento}`;
    dobles.set(k, (dobles.get(k) ?? new Set()).add(f.lote));
  }
  assert.equal([...dobles.values()].filter(s => s.size === 2).length, 2);
  // por (fecha, momento, medicamento) la suma de unidades de la etiqueta == la dosis de la pauta
  const porToma = new Map<string, number>();
  for (const f of filas) porToma.set(`${f.fecha}|${f.momento}|${f.medicamento}`, (porToma.get(`${f.fecha}|${f.momento}|${f.medicamento}`) ?? 0) + Math.round(f.unidades * 4));
  p.tomas.forEach((ts, i) => ts.forEach(t => {
    assert.equal((porToma.get(`${t.fecha}|${NOMBRE_MOMENTO.get(t.momentoId)}|${meds[i].nombre}`) ?? 0) / 4, t.unidades);
  }));
});

test('(a) auditoría: cada paso queda registrado y la cadena verifica; manipular un paso la rompe', () => {
  const { meds, libro } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  const cadena: EntradaAuditoria[] = [];
  let t = 0;
  const reg = (accion: string, entidad: string, id: string, antes: unknown, despues: unknown, motivo: string | null = null) => {
    const previo = cadena.length ? cadena[cadena.length - 1].hash : HASH_GENESIS;
    cadena.push(crearEntrada({
      momento: new Date(Date.UTC(2026, 10, 3, 9, 0, t++, 0)).toISOString(), usuarioId: 7,
      accion, entidad, entidadId: id, antes, despues, motivo,
    }, previo));
  };
  for (const m of meds) for (const e of m.envases) reg('envase.entrada', 'envase', String(e.id), null, e);
  p.repartos.forEach((r, i) => reg('preparacion.reparto', 'tratamiento', String(meds[i].tratamientoId), null, r));
  reg('preparacion.caducidad', 'preparacion', 'SPD-8F3K', null, p.caducidad);
  reg('preparacion.etiqueta', 'preparacion', 'SPD-8F3K', null, { filas: filasTablaTomas(p.tomasEtiqueta).length });
  reg('preparacion.validar', 'preparacion', 'SPD-8F3K', { validable: false }, { validable: p.validable });
  assert.equal(cadena.length, 5 + 3 + 3);
  assert.deepEqual(verificarCadena(cadena), { ok: true });
  assert.ok(libro.existentes.length === 5);

  const rota = structuredClone(cadena);
  (rota[6].despues as { ok: boolean }).ok = false;      // alguien «corrige» un reparto
  const v = verificarCadena(rota);
  assert.equal(v.ok, false);
  assert.equal(v.primerError?.indice, 6);
  assert.equal(v.primerError?.motivo, 'hash_incorrecto');
});

// ════════════════════════════ ESCENARIO (b) ════════════════════════════

test('(b) cambio de pauta a mitad de periodo: pautaVigenteEn por día, totales y mapa', () => {
  const v1: Pauta = { vigenteDesde: INICIO, vigenteHasta: '2026-11-10', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  const v2: Pauta = { vigenteDesde: '2026-11-11', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }, { momentoId: 3, unidades: 0.5 }] };
  const envases: Envase[] = [
    { id: 1, tratamientoId: 1, cn: CN_METFORMINA, lote: 'X1', caducidad: '2027-06-30', unidadesRestantes: 20, estado: 'en_uso' },
  ];
  const med: Med = { nombre: 'Cambio de pauta', tratamientoId: 1, versiones: [v1, v2], envases };
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [med] });
  // 7 días × 1 + 7 días × 1,5
  assert.equal(sumaUnidades(p.tomas[0]), 7 + 10.5);
  assert.equal(sumaUnidades(p.repartos[0].lineas), 17.5);
  assert.equal(p.tomas[0].filter(t => t.momentoId === 3).length, 7);
  assert.ok(p.tomas[0].filter(t => t.momentoId === 3).every(t => t.fecha >= '2026-11-11'));
  assert.equal(pautaVigenteEn([v1, v2], '2026-11-10'), v1);
  assert.equal(pautaVigenteEn([v1, v2], '2026-11-11'), v2);
  assert.equal(p.celdasSinUbicar.length, 0);
  assert.equal(p.validable, true, p.motivos.join(' | '));
  assert.ok(validarPauta(v1).length === 0 && validarPauta(v2).length === 0);
});

test('(b) BRECHA: unidadesTotales por versión sin vigenteHasta DUPLICA el tramo de la versión siguiente', () => {
  const v1: Pauta = { vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };     // sin vigenteHasta
  const v2: Pauta = { vigenteDesde: '2026-11-11', patron: 'diario', dosis: [{ momentoId: 1, unidades: 2 }] };
  const correcto = sumaUnidades(tomasVersionadas([v1, v2], INICIO, 14));                    // 7×1 + 7×2 = 21
  const ingenuo = unidadesTotales(v1, INICIO, FIN_14) + unidadesTotales(v2, INICIO, FIN_14); // 14 + 14 = 28
  assert.equal(correcto, 21);
  assert.equal(ingenuo, 28);
  assert.notEqual(ingenuo, correcto);
});

test('(b) tomasVersionadas debería ser una función del dominio', { todo: 'falta tomasDelPeriodoVersiones(versiones, desde, hasta) en calendario-pauta' }, async () => {
  const mod = await import('../src/dominio/calendario-pauta.ts') as Record<string, unknown>;
  assert.equal(typeof mod.tomasDelPeriodoVersiones, 'function');
});

// ════════════════════════════ ESCENARIO (c) ════════════════════════════

test('(c) caja que caduca a mitad del periodo: se excluye, se avisa y el SPD sale del resto', () => {
  const { metformina } = escenarioA();
  // M-B pasa a caducar el 10-nov (mitad del periodo 4–17)
  const envases = metformina.envases.map(e => e.id === 12 ? { ...e, caducidad: '2026-11-10' } : e);
  const med: Med = { ...metformina, envases };
  // la entrada ya avisaba de ello (atención, no bloqueo)
  const ent = validarEntradaEnvase({ cn: CN_METFORMINA, lote: 'M-B', caducidad: '2026-11-10', unidades: 8.5, hoy: HOY },
    { envasesExistentes: [], cnConocidos: new Set([CN_METFORMINA]), alertasCalidad: [], finPrevistoPeriodo: FIN_14 });
  assert.ok(ent.ok);
  assert.ok(ent.atencion.some(a => a.codigo === 'CADUCA_ANTES_DEL_PERIODO'));

  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [med] });
  const r = p.repartos[0];
  assert.ok(r.avisos.some(a => a.includes('lote M-B') && a.includes('no se usa')));
  assert.ok(!r.lineas.some(l => l.envaseId === 12));
  // quedan 12 + 20 = 32 ≥ 35? no: faltan 3 → no validable
  assert.equal(r.ok, false);
  assert.equal(r.faltan, 3);
  assert.equal(p.validable, false);
  // con una caja más, sí
  const extra: Envase = { id: 14, tratamientoId: 1, cn: CN_METFORMINA, lote: 'M-D', caducidad: '2027-05-31', unidadesRestantes: 10, estado: 'en_uso' };
  const p2 = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [{ ...med, envases: [...envases, extra] }] });
  assert.equal(p2.repartos[0].ok, true);
  assert.ok(!p2.repartos[0].lineas.some(l => l.envaseId === 12));
  assert.ok(p2.repartos[0].avisos.some(a => a.includes('M-B')));
  assert.equal(p2.validable, true, p2.motivos.join(' | '));
  // el lote excluido NO aparece en la etiqueta
  const html = renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p2, p2.caducidad.caducidadSpd!)).html;
  assert.ok(!html.includes('M-B'));
});

test('(c) caja que caduca EXACTAMENTE el último día: se usa y limita la caducidad del SPD (encaja con periodoCabe)', () => {
  const env: Envase[] = [{ id: 1, tratamientoId: 1, cn: CN_METFORMINA, lote: 'LIM', caducidad: FIN_14, unidadesRestantes: 14, estado: 'en_uso' }];
  const med: Med = { nombre: 'Límite', tratamientoId: 1, versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] }], envases: env };
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [med] });
  assert.equal(p.repartos[0].ok, true);
  assert.equal(p.caducidad.caducidadSpd, FIN_14);
  assert.equal(p.caducidad.caducidadSpd, '2026-11-17');  // coincide con preparación+14, pero limitada por…
  assert.equal(p.cabe, true);
  // misma situación con caducidad un día antes: la caja se excluye
  const p2 = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [{ ...med, envases: [{ ...env[0], caducidad: '2026-11-16' }] }] });
  assert.equal(p2.repartos[0].ok, false);
  assert.equal(p2.validable, false);
});

// ════════════════════════════ ESCENARIO (d) ════════════════════════════

test('(d) falta de unidades: no se puede marcar validable y se dice cuántas faltan', () => {
  const { metformina, alendronato, ciclo } = escenarioA();
  const corta: Med = { ...metformina, envases: metformina.envases.map(e => e.id === 13 ? { ...e, unidadesRestantes: 10 } : e) };
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [corta, alendronato, ciclo] });
  assert.equal(p.repartos[0].ok, false);
  assert.equal(p.repartos[0].faltan, 4.5);          // 35 − (8,5 + 12 + 10)
  assert.equal(p.validable, false);
  assert.ok(p.motivos.some(m => m.includes('faltan 4.5')));
  // los demás medicamentos sí están completos
  assert.ok(p.repartos[1].ok && p.repartos[2].ok);
  // ni el rol correcto lo arregla
  assert.equal(puedeValidar('farmaceutico'), true);
  // un técnico no puede validar aunque todo cuadre
  const bien = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [metformina, alendronato, ciclo], rol: 'tecnico' });
  assert.equal(bien.validable, false);
  assert.ok(bien.motivos.includes('El rol no puede validar.'));
});

test('(d) BRECHA: con unidades que faltan, la etiqueta se genera «imprimible» con tomas que desaparecen', () => {
  const { metformina } = escenarioA();
  const corta: Med = { ...metformina, envases: metformina.envases.map(e => e.id === 13 ? { ...e, unidadesRestantes: 10 } : e) };
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [corta] });
  assert.equal(p.validable, false);
  const total = sumaUnidades(p.tomas[0]);
  const enEtiqueta = sumaUnidades(filasTablaTomas(p.tomasEtiqueta));
  assert.ok(enEtiqueta < total, 'la etiqueta lleva menos unidades que la pauta');
  const r = renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, '2026-11-17'));
  // HOY imprimible == true aunque falten tomas: etiquetas.ts no conoce lo esperado
  assert.equal(r.imprimible, true);
});

test('(d) la etiqueta debería rechazarse si lleva menos unidades que la pauta', { todo: 'renderizarEtiqueta no recibe lo esperado; imprimible no detecta tomas ausentes' }, () => {
  const { metformina } = escenarioA();
  const corta: Med = { ...metformina, envases: metformina.envases.map(e => e.id === 13 ? { ...e, unidadesRestantes: 10 } : e) };
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [corta] });
  const r = renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, '2026-11-17'));
  assert.equal(r.imprimible, false);
});

test('(d) toma de una pauta cuyo momento no existe en el blíster: se detecta (celda sin ubicar)', () => {
  const med: Med = {
    nombre: 'Momento fantasma', tratamientoId: 1,
    versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 99, unidades: 1 }] }],
    envases: [{ id: 1, tratamientoId: 1, cn: CN_METFORMINA, lote: 'Z1', caducidad: '2027-06-30', unidadesRestantes: 30, estado: 'en_uso' }],
  };
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [med] });
  assert.equal(p.celdasSinUbicar.length, 14);
  assert.equal(p.validable, false);
  // BRECHA: ningún módulo del dominio lo comprueba por sí solo; sólo este glue.
  assert.equal(p.repartos[0].ok, true);
  assert.equal(p.caducidad.ok, true);
});

// ════════════════════════════ ESCENARIO (e) ════════════════════════════

test('(e) lote con alerta de calidad: la entrada se bloquea (CN+lote, sólo lote y todo el CN)', () => {
  const libro: Libro = { existentes: [], cn: new Set([CN_METFORMINA]) };
  const base = { cn: '', unidades: 10, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'M-ALERTA', '280131', 'S9') };
  for (const alerta of [
    { cn: CN_METFORMINA, lote: 'M-ALERTA', referencia: 'R_21/2026' },
    { lote: 'm-alerta', referencia: 'R_22/2026' },                // por lote en cualquier CN, sin importar mayúsculas
    { cn: '7127290', referencia: 'R_23/2026' },                  // todo el CN (con dígito de control)
  ]) {
    const r = validarEntradaEnvase(base, contexto(libro, { alertasCalidad: [alerta] }));
    assert.equal(r.ok, false, JSON.stringify(alerta));
    assert.ok(r.bloqueos.some(b => b.codigo === 'LOTE_CON_ALERTA'));
    assert.equal(r.envaseNormalizado, undefined);
  }
  // otro lote del mismo CN: pasa
  const ok = validarEntradaEnvase({ ...base, lecturaDatamatrix: dm(CN_METFORMINA, 'M-OK', '280131', 'S10') },
    contexto(libro, { alertasCalidad: [{ cn: CN_METFORMINA, lote: 'M-ALERTA', referencia: 'R_21/2026' }] }));
  assert.equal(ok.ok, true);
});

test('(e) la alerta bloquea también la entrada manual y NO usa un lote contradictorio del teclado', () => {
  const libro: Libro = { existentes: [], cn: new Set([CN_METFORMINA]) };
  const alertas = [{ cn: CN_METFORMINA, lote: 'M-ALERTA', referencia: 'R_21/2026' }];
  const manual = validarEntradaEnvase({ cn: CN_METFORMINA, lote: ' M-ALERTA ', caducidad: '2028-01-31', unidades: 5, hoy: HOY }, contexto(libro, { alertasCalidad: alertas }));
  assert.equal(manual.ok, false);
  // teclado dice lote OK pero el DataMatrix (manda el código) es el alertado
  const contradice = validarEntradaEnvase({ cn: CN_METFORMINA, lote: 'M-OK', unidades: 5, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'M-ALERTA', '280131') },
    contexto(libro, { alertasCalidad: alertas }));
  assert.equal(contradice.ok, false);
  assert.ok(contradice.atencion.some(a => a.codigo === 'LOTE_CONTRADICE_CODIGO'));
});

test('(e) BRECHA: una alerta posterior sobre una caja YA en uso no la excluye del reparto', () => {
  const { metformina } = escenarioA();
  const alertas = [{ cn: CN_METFORMINA, lote: 'M-A', referencia: 'R_30/2026' }];
  // el reparto no conoce las alertas: sigue usando la caja con alerta
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [metformina] });
  assert.ok(p.repartos[0].lineas.some(l => cajaDe(metformina, l.envaseId).lote === 'M-A'));
  assert.equal(p.validable, true);
  assert.equal(alertas.length, 1);
});

test('(e) debería existir un cruce alertas × cajas en uso antes de validar', { todo: 'ningún módulo cruza alertasCalidad con Envase[] ya custodiados' }, async () => {
  const mod = await import('../src/dominio/entrada-envase.ts') as Record<string, unknown>;
  assert.equal(typeof mod.envasesAfectadosPorAlertas, 'function');
});

// ════════════════════════════ ESCENARIO (f) ════════════════════════════

test('(f) etiqueta bloqueada si falta el lote (o la caducidad) de CUALQUIER medicamento', () => {
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  const cad = p.caducidad.caducidadSpd!;
  // control: completa, imprimible
  assert.equal(renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, cad)).imprimible, true);

  for (const nombre of meds.map(m => m.nombre)) {
    for (const campo of ['lote', 'caducidad'] as const) {
      const tomas = structuredClone(p.tomasEtiqueta);
      const t = tomas.find(x => x.medicamentos.some(m => m.nombre === nombre))!;
      t.medicamentos.find(m => m.nombre === nombre)![campo] = '';
      const r = renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, cad, tomas));
      assert.equal(r.imprimible, false, `${nombre} sin ${campo}`);
      assert.ok(r.faltan.some(f => f.includes('lote_caducidad')), `${nombre} sin ${campo}: faltan=${r.faltan}`);
      assert.ok(r.html.includes(campo === 'lote' ? '⟦lote⟧' : '⟦caducidad⟧'));
    }
  }
  // lote en blanco con espacios también cuenta como falta
  const tomas = structuredClone(p.tomasEtiqueta);
  tomas[0].medicamentos[0].lote = '   ';
  assert.equal(renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, cad, tomas)).imprimible, false);
  // y sin caducidad del SPD (variable de la plantilla)
  assert.equal(renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, '')).imprimible, false);
});

test('(f) la entrada de envase NUNCA deja pasar un envase sin lote o sin caducidad (no llega vacío a la etiqueta)', () => {
  const libro: Libro = { existentes: [], cn: new Set([CN_METFORMINA]) };
  const sinLote = validarEntradaEnvase({ cn: CN_METFORMINA, caducidad: '2028-01-31', unidades: 10, hoy: HOY }, contexto(libro));
  assert.deepEqual(sinLote.bloqueos.map(b => b.codigo), ['FALTA_LOTE']);
  const sinCad = validarEntradaEnvase({ cn: CN_METFORMINA, lote: 'X', unidades: 10, hoy: HOY }, contexto(libro));
  assert.deepEqual(sinCad.bloqueos.map(b => b.codigo), ['FALTA_CADUCIDAD']);
  const caducada = validarEntradaEnvase({ cn: CN_METFORMINA, lote: 'X', caducidad: '2026-10-01', unidades: 10, hoy: HOY }, contexto(libro));
  assert.ok(caducada.bloqueos.some(b => b.codigo === 'CADUCADO'));
  // lectura ambigua (sin GS entre lote y serie): bloquea y no inventa
  const ambiguo = validarEntradaEnvase({ cn: '', unidades: 10, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'AB12', '280131') + '21SER9' }, contexto(libro));
  assert.equal(ambiguo.ok, false);
  assert.ok(ambiguo.bloqueos.some(b => b.codigo === 'LECTURA_AMBIGUA'));
  // serie duplicada
  const dupLibro: Libro = { existentes: [{ cn: CN_METFORMINA, numeroSerie: 'SA1', lote: 'M-A', estado: 'en_uso' }], cn: new Set([CN_METFORMINA]) };
  const dup = validarEntradaEnvase({ cn: '', unidades: 10, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'M-A', '270228', 'SA1') }, contexto(dupLibro));
  assert.ok(dup.bloqueos.some(b => b.codigo === 'SERIE_REPETIDA'));
});

test('(f) BRECHA: la plantilla de docs/07 (100×150 mm) NO admite las tomas de 14 días: no cabe y queda no imprimible', () => {
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  assert.deepEqual(validarPlantilla(PLANTILLA_DOC07), []);
  const r = renderizarEtiqueta(PLANTILLA_DOC07, datosEtiqueta(p, '2026-11-17'));
  assert.equal(r.cabe, false);
  assert.equal(r.imprimible, false);
  assert.ok(r.problemas.some(x => x.includes('no cabe')));
  // con 3 días sí cabe (la plantilla funciona; es una cuestión de tamaño)
  const p3 = preparar({ desde: INICIO, dias: 3, fechaPreparacion: PREPARACION, meds: [meds[0]] });
  const r3 = renderizarEtiqueta(PLANTILLA_DOC07, datosEtiqueta(p3, '2026-11-17'));
  assert.equal(r3.imprimible, true, r3.problemas.join(' | '));
});

test('(f) BRECHA: la columna «descripcion» de la plantilla docs/07 no se imprime en ningún sitio', () => {
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 3, fechaPreparacion: PREPARACION, meds: [meds[0]] });
  const filas = filasTablaTomas(p.tomasEtiqueta);
  assert.ok(!('descripcion' in filas[0]), 'FilaTomas no tiene descripción física');
  const r = renderizarEtiqueta(PLANTILLA_DOC07, datosEtiqueta(p, '2026-11-17'));
  assert.ok(!/blanc|redond|ranur|descripci/i.test(r.html));
});

// ════════════════════════════ ESCENARIO (g) ════════════════════════════

test('(g) periodo que empieza en miércoles: inicio convencional vs cronológico', () => {
  assert.equal(dow(INICIO), 3);
  const conv = construirMapas(INICIO, 14, MOMENTOS, { inicioDia: 'convencional' });
  const cron = construirMapas(INICIO, 14, MOMENTOS, { inicioDia: 'cronologico' });
  assert.equal(conv.length, 2);
  assert.equal(cron.length, 2);

  // convencional: filas = lunes … domingo; la fila del lunes lleva el lunes SIGUIENTE (9-nov)
  assert.deepEqual(conv[0].filas.map(f => f.diaSemana), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(conv[0].filas.map(f => f.fecha), ['2026-11-09', '2026-11-10', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  // cronológico: la primera fila es el miércoles de inicio
  assert.deepEqual(cron[0].filas.map(f => f.fecha), rango(INICIO, 7));
  assert.equal(cron[0].filas[0].diaSemana, 3);

  // la misma toma cae en filas distintas según el modo, pero SIEMPRE en una celda con su fecha y momento
  const lunes9 = ubicarToma(conv, '2026-11-09', 1)!;
  const lunes9c = ubicarToma(cron, '2026-11-09', 1)!;
  assert.equal(lunes9.mapa.indice, 0);
  assert.equal(lunes9.celda.fila, 0);        // fila del lunes
  assert.equal(lunes9c.celda.fila, 5);       // sexta fila cronológica
  // segundo blíster: 11-nov (miércoles) en ambos modos
  assert.equal(ubicarToma(conv, '2026-11-11', 1)!.mapa.indice, 1);
  assert.equal(ubicarToma(cron, '2026-11-11', 1)!.mapa.indice, 1);

  // unidades por celda == pauta, en ambos modos y sumando todos los medicamentos
  const { meds } = escenarioA();
  for (const inicioDia of ['convencional', 'cronologico'] as const) {
    const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds, inicioDia });
    assert.deepEqual(p.celdasSinUbicar, []);
    const usadas = p.mapas.flatMap(m => m.celdas.filter(c => c.usada)).length;
    assert.equal(usadas, 14 * MOMENTOS.length);
    assert.equal(p.validable, true, p.motivos.join(' | '));
  }
});

test('(g) convencional con periodo de 10 días desde un miércoles: el segundo blíster sólo rellena 3 filas', () => {
  const conv = construirMapas(INICIO, 10, MOMENTOS, { inicioDia: 'convencional' });
  assert.equal(conv.length, 2);
  assert.equal(conv[1].desde, '2026-11-11');
  assert.equal(conv[1].hasta, '2026-11-13');
  assert.equal(conv[1].filas.filter(f => f.fecha !== null).length, 3);
  assert.equal(conv[1].celdas.filter(c => c.usada).length, 3 * MOMENTOS.length);
  // el semanal (lunes) del 9-nov cae en el primer blíster, el del 16 queda fuera del periodo de 10 días
  const tomas = tomasDelPeriodo(PAUTA_ALENDRONATO, INICIO, sumar(INICIO, 9));
  assert.deepEqual(tomas.map(t => t.fecha), ['2026-11-09']);
});

// ════════════════════════════ CADUCIDAD: modo 30 días ════════════════════════════

test('modo 30 días: exige ajuste activo y justificación; queda marcado como fuera de estándar', () => {
  const { meds } = escenarioA();
  // 28 días de periodo; cajas suficientes (se amplía metformina)
  const ampliadas = meds.map(m => ({
    ...m,
    envases: m.envases.map(e => ({ ...e, unidadesRestantes: e.unidadesRestantes * 2 + 4 })),
  }));
  const base = { desde: INICIO, dias: 28, fechaPreparacion: PREPARACION, meds: ampliadas };
  const fin28 = sumar(INICIO, 27);

  // 14 días de validez no alcanzan para 28 días de periodo
  const p14 = preparar(base);
  assert.equal(p14.caducidad.ok, true);
  assert.equal(p14.cabe, false);
  assert.equal(p14.validable, false);

  // 30 días sin activar el ajuste
  const sinAjuste = preparar({ ...base, diasValidez: 30 });
  assert.equal(sinAjuste.caducidad.ok, false);
  assert.equal(sinAjuste.validable, false);

  // activado pero sin justificación
  const sinJust = preparar({ ...base, diasValidez: 30, validezExtendidaPermitida: true });
  assert.equal(sinJust.caducidad.ok, false);
  assert.ok(sinJust.caducidad.errores.some(e => e.includes('justificación')));
  assert.equal(sinJust.validable, false);

  // activado y justificado
  const justificacion = 'Paciente en residencia, reposición mensual coordinada con el centro.';
  const ok = preparar({ ...base, diasValidez: 30, validezExtendidaPermitida: true, justificacion });
  assert.equal(ok.caducidad.ok, true);
  assert.equal(ok.caducidad.fueraDeEstandar, true);
  assert.equal(ok.caducidad.caducidadSpd, sumar(PREPARACION, 30));
  assert.equal(ok.fin, fin28);
  assert.equal(ok.cabe, true);
  assert.equal(ok.mapas.length, 4);
  assert.equal(ok.validable, true, ok.motivos.join(' | '));
  assert.ok(ok.caducidad.avisos.length > 0);

  // el invariante de unidades se mantiene en 4 blísteres
  let enCeldas = 0;
  ok.tomas.forEach(ts => ts.forEach(t => { assert.ok(ubicarToma(ok.mapas, t.fecha, t.momentoId)); enCeldas += Math.round(t.unidades * 4); }));
  assert.equal(enCeldas / 4, ok.repartos.reduce((s, r) => s + sumaUnidades(r.lineas), 0));

  // la desviación y su justificación quedan en la auditoría
  const e = crearEntrada({
    momento: '2026-11-03T09:00:00.000Z', usuarioId: 7, accion: 'preparacion.validez_extendida', entidad: 'preparacion',
    entidadId: 'SPD-8F3K', antes: null, despues: { diasValidez: 30, fueraDeEstandar: ok.caducidad.fueraDeEstandar, caducidadSpd: ok.caducidad.caducidadSpd }, motivo: justificacion,
  }, HASH_GENESIS);
  assert.deepEqual(verificarCadena([e]), { ok: true });
  assert.equal(e.motivo, justificacion);
});

test('límite de caducidad: un lote que caduca durante el periodo hace imposible el periodo completo (encaje reparto ↔ caducidad)', () => {
  // si el reparto usa una caja, su caducidad >= fin; por tanto la caducidad del SPD >= fin siempre que validez >= periodo
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  const minLote = p.repartos.flatMap((r, i) => r.lineas.map(l => cajaDe(meds[i], l.envaseId).caducidad)).sort()[0];
  assert.ok(minLote >= p.fin);
  assert.equal(p.cabe, true);
});

test('BRECHA: convención «14 días»: un periodo de 15 días empezando el día de la preparación «cabe» con validez 14', () => {
  // preparación 4-nov, periodo 4–18 nov (15 días de administración): caducidad = 4+14 = 18 → periodoCabe true
  const c = calcularCaducidadSpd({ caducidadesLotes: ['2027-12-31'], fechaPreparacion: INICIO, diasValidez: 14, validezExtendidaPermitida: false });
  assert.equal(c.caducidadSpd, '2026-11-18');
  assert.equal(periodoCabe('2026-11-18', c.caducidadSpd!), true);
  // 15 días de administración con «14 días de validez»: hay que decidir si el día de preparación cuenta
});

// ════════════════════════════ ENTRADA ↔ REPARTO ════════════════════════════

test('dos cajas del MISMO lote (habitual): entran por la entrada y el reparto las acepta (series distintas)', () => {
  const libro: Libro = { existentes: [], cn: new Set([CN_METFORMINA]) };
  const e1 = entrarCaja(libro, 1, 1, { cn: CN_METFORMINA, lote: 'L-REPE', caducidad: '2028-01-31', unidades: 10, hoy: HOY });
  const e2 = entrarCaja(libro, 2, 1, { cn: CN_METFORMINA, lote: 'L-REPE', caducidad: '2028-01-31', unidades: 10, hoy: HOY });   // sin serie: pasa
  const e3 = entrarCaja(libro, 3, 1, { cn: '', unidades: 10, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'L-REPE', '280131', 'S-OTRA') });
  assert.ok(e1.lote === e2.lote && e1.lote === e3.lote);
  const med: Med = { nombre: 'Mismo lote', tratamientoId: 1, versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] }], envases: [e1, e2, e3] };
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [med] });
  assert.equal(p.repartos[0].ok, true, p.repartos[0].errores.join(' | '));
  assert.equal(sumaUnidades(p.repartos[0].lineas), 14);
  // dos cajas distintas con el mismo lote → la etiqueta lo lista (por línea), sin fusionar ni perder unidades
  const filas = filasTablaTomas(p.tomasEtiqueta);
  assert.equal(sumaUnidades(filas), 14);
  assert.ok(filas.every(f => f.lote === 'L-REPE'));
});

test('CN: DataMatrix, CN con dígito de control y CN a secas dan el mismo CN de 6 dígitos que usa el Envase', () => {
  const libro: Libro = { existentes: [], cn: new Set([CN_METFORMINA]) };
  for (const cn of [CN_METFORMINA, CN_METFORMINA + '0']) {
    const r = validarEntradaEnvase({ cn, lote: 'A', caducidad: '2028-01-31', unidades: 1, hoy: HOY }, contexto(libro));
    assert.equal(r.envaseNormalizado?.cn, CN_METFORMINA, `cn=${cn}: ${JSON.stringify(r.bloqueos)}`);
  }
  const d = validarEntradaEnvase({ cn: '', unidades: 1, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'A', '280131') }, contexto(libro));
  assert.equal(d.envaseNormalizado?.cn, CN_METFORMINA);
  // un CN que no es de 6 dígitos nunca llega al reparto
  const mal = validarEntradaEnvase({ cn: '12345', lote: 'A', caducidad: '2028-01-31', unidades: 1, hoy: HOY }, contexto(libro));
  assert.equal(mal.ok, false);
});

test('cantidades en cuartos: unidades 0,25 viajan intactas de pauta → reparto → etiqueta → auditoría', () => {
  const med: Med = {
    nombre: 'Fraccionable', tratamientoId: 1,
    versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 0.25 }, { momentoId: 3, unidades: 0.75 }] }],
    envases: [
      { id: 1, tratamientoId: 1, cn: CN_METFORMINA, lote: 'Q1', caducidad: '2027-06-30', unidadesRestantes: 3.25, estado: 'en_uso' },
      { id: 2, tratamientoId: 1, cn: CN_METFORMINA, lote: 'Q2', caducidad: '2027-09-30', unidadesRestantes: 20, estado: 'en_uso' },
    ],
  };
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds: [med] });
  assert.equal(sumaUnidades(p.tomas[0]), 14);
  assert.equal(sumaUnidades(p.repartos[0].lineas), 14);
  assert.equal(sumaUnidades(filasTablaTomas(p.tomasEtiqueta)), 14);
  assert.ok(validarPauta(med.versiones[0]).length === 0);
  assert.ok(avisosPauta(med.versiones[0]).some(a => a.includes('fracciones')));
  const r = renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, '2026-11-17'));
  // BRECHA menor: la etiqueta imprime el decimal con punto («×0.25») en un documento en español
  assert.ok(r.html.includes('×0.25'));
  const crear = () => crearEntrada({ momento: '2026-11-03T09:00:00.000Z', usuarioId: 1, accion: 'x', entidad: 'e', entidadId: null, antes: null, despues: p.repartos[0], motivo: null }, HASH_GENESIS);
  assert.doesNotThrow(crear);
});

// ════════════════════════════ AUDITORÍA ↔ RESULTADOS ════════════════════════════

test('auditar el resultado de un SPD no válido debería funcionar (un rechazo también se audita)', () => {
  const fallo = calcularCaducidadSpd({ caducidadesLotes: ['2026-10-01'], fechaPreparacion: PREPARACION, diasValidez: 14, validezExtendidaPermitida: false });
  assert.doesNotThrow(() =>
    crearEntrada({ momento: '2026-11-03T09:00:00.000Z', usuarioId: 1, accion: 'preparacion.caducidad', entidad: 'preparacion', entidadId: 'x', antes: null, despues: fallo, motivo: null }, HASH_GENESIS));
});

test('auditoría: resultados de entrada (ok y bloqueo), reparto y etiqueta son serializables', () => {
  const libro: Libro = { existentes: [], cn: new Set([CN_METFORMINA]) };
  const ok = validarEntradaEnvase({ cn: '', unidades: 10, hoy: HOY, lecturaDatamatrix: dm(CN_METFORMINA, 'M-A', '280131', 'S1') }, contexto(libro));
  const bloq = validarEntradaEnvase({ cn: CN_METFORMINA, caducidad: '2028-01-31', unidades: 10, hoy: HOY }, contexto(libro));
  const { meds } = escenarioA();
  const p = preparar({ desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, meds });
  const etq = renderizarEtiqueta(PLANTILLA_A4, datosEtiqueta(p, '2026-11-17'));
  const cadena: EntradaAuditoria[] = [];
  let i = 0;
  for (const despues of [ok, bloq, p.repartos[0], p.caducidad, { problemas: etq.problemas, faltan: etq.faltan, imprimible: etq.imprimible }]) {
    const previo = cadena.length ? cadena[cadena.length - 1].hash : HASH_GENESIS;
    cadena.push(crearEntrada({ momento: `2026-11-03T09:00:0${i++}.000Z`, usuarioId: 1, accion: 'a', entidad: 'e', entidadId: String(i), antes: null, despues, motivo: null }, previo));
  }
  assert.deepEqual(verificarCadena(cadena), { ok: true });
});

test('auditoría: los datos clínicos del reparto no se enmascaran por error y los secretos sí', () => {
  const e = crearEntrada({
    momento: '2026-11-03T09:00:00.000Z', usuarioId: 1, accion: 'usuario.cambio_clave', entidad: 'usuario', entidadId: '1',
    antes: { hash_clave: 'abc' }, despues: { hash_clave: 'def', lote: 'M-A' }, motivo: null, camposOcultos: ['hash_clave'],
  }, HASH_GENESIS);
  assert.deepEqual(e.antes, { hash_clave: '***' });
  assert.deepEqual(e.despues, { hash_clave: '***', lote: 'M-A' });
});
