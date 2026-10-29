/**
 * Carga de la base y evaluación de una preparación.
 *
 * Lee del paciente todo lo que necesita el dominio (momentos, tratamientos con sus
 * versiones de pauta, cajas en uso, alertas de calidad, ajustes, consentimientos y el
 * rol de la sesión), llama a `evaluarPreparacion` del dominio y completa el resultado con
 * lo que la interfaz necesita para pintar (leyenda y alvéolos ya resueltos).
 *
 * Aquí NO se escribe nada. Las reglas clínicas siguen en src/dominio.
 */
import type { Contexto } from '../contexto.ts';
import type { EvaluacionPreparacion } from '../api.ts';
import type { Db } from '../db.ts';
import { evaluarPreparacion as evaluarDominio } from '../../dominio/preparacion.ts';
import type { Aviso, Bloqueo, EntradaPreparacion, LineaReparto, ResultadoPreparacion, TomaPreparacion, TratamientoPreparacion } from '../../dominio/preparacion.ts';
import type { Envase, MomentoToma, Pauta } from '../../dominio/tipos.ts';
import type { Rol } from '../../dominio/caducidad-spd.ts';
import { estadoConsentimientos as estadoConsDominio, REQUERIDOS_PARA_VALIDAR_SPD } from '../../dominio/documentos.ts';
import type { EstadoConsentimientos } from '../../dominio/documentos.ts';
import { pautaVigenteEn } from '../../dominio/calendario-pauta.ts';
import { construirMapas } from '../../dominio/disposicion-blister.ts';
import type { MapaBlister } from '../../dominio/disposicion-blister.ts';
import { envasesAfectados } from '../../dominio/alertas-calidad.ts';
import type { AlertaCalidad } from '../../dominio/alertas-calidad.ts';
import { analizarDescripcion, resumenDescripcion } from '../../dominio/descripcion-fisica.ts';
import { formatearUnidades } from '../../dominio/etiquetas.ts';
import { aCuartos, bd, leerAjustesPrep, marcadores, nombreCompleto, noEncontrado } from './util.ts';
import type { AjustesPrep, R } from './util.ts';

// ───────────────────────── tipos internos ─────────────────────────

export interface InfoTrat {
  id: number;
  /** «Metformina 850 mg»: principio activo + dosis (se identifica por PA + dosis, no por marca). */
  nombre: string;
  principioActivo: string;
  emblistable: boolean;
  nota: string | null;
  motivoNoEmblistable: string | null;
  cnPreferente: string | null;
  versiones: Pauta[];
  versionIds: Map<Pauta, number>;
}

export interface InfoEnvase {
  id: number;
  cn: string;
  medicamento: string;
  lote: string;
  caducidad: string;
  /** Descripción física CONFIRMADA (resumida); undefined si no hay una confirmada. */
  descripcion?: string;
}

export interface Aux {
  paciente: R;
  farmacia: R | undefined;
  momentos: MomentoToma[];
  trats: Map<number, InfoTrat>;
  envases: Map<number, InfoEnvase>;
  /** Texto «aparte» de cada tratamiento no emblistable (para la etiqueta). */
  aparteTextos: Map<number, string>;
  ajustes: AjustesPrep;
  entrada?: EntradaPreparacion;
}

export interface Cargado { evaluacion: EvaluacionPreparacion; aux: Aux }

export interface OpcionesCarga {
  pacienteId: number;
  desde: string;
  dias: number;
  fechaPreparacion: string;
  diasValidez?: number;
  justificacion?: string;
  rol: Rol;
  /** Si se indica, SOLO se consideran estas cajas (validación: las que se usaron al preparar). */
  soloEnvases?: Set<number>;
}

// ───────────────────────── descripción y leyenda ─────────────────────────

/** Descripción física CONFIRMADA resumida para la etiqueta; undefined si no hay una confirmada. */
export function descripcionConfirmada(m: R | undefined): string | undefined {
  if (!m || m.descripcion_estado !== 'confirmada') return undefined;
  const bruto = typeof m.descripcion_fisica === 'string' ? m.descripcion_fisica.trim() : '';
  if (bruto === '') return undefined;
  let base = '';
  try { base = resumenDescripcion(analizarDescripcion(bruto)); } catch { base = ''; }
  if (base === '') base = bruto;
  const marcas = typeof m.marcas_grabado === 'string' ? m.marcas_grabado.trim() : '';
  if (marcas !== '' && !base.includes(marcas)) base += ` (grabado: ${marcas})`;
  return base;
}

const quitarTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** 3-4 letras del principio activo, distinta de las ya usadas. */
export function abreviar(principioActivo: string, usadas: Set<string>): string {
  const primera = quitarTildes(principioActivo).toUpperCase().replace(/[^A-Z ]/g, ' ').trim().split(/\s+/)[0] ?? '';
  const letras = primera === '' ? 'MED' : primera;
  for (const n of [4, 3]) {
    const c = letras.slice(0, n);
    if (c.length >= Math.min(3, letras.length) && !usadas.has(c)) { usadas.add(c); return c; }
  }
  const raiz = letras.slice(0, 3);
  for (let k = 2; ; k++) {
    const c = `${raiz}${k}`;
    if (!usadas.has(c)) { usadas.add(c); return c; }
  }
}

export interface ItemLeyenda { tratamientoId: number; cn?: string | null; nombre: string; principioActivo: string; descripcion?: string }

/** Leyenda en orden estable (por id de tratamiento): letra A, B, C… y color --med-1…--med-8. */
export function construirLeyenda(items: ItemLeyenda[]): EvaluacionPreparacion['leyenda'] {
  const ordenados = [...items].sort((a, b) => a.tratamientoId - b.tratamientoId);
  const usadas = new Set<string>();
  return ordenados.map((it, i) => ({
    tratamientoId: it.tratamientoId,
    cn: it.cn ?? null,
    nombre: it.nombre,
    abreviatura: abreviar(it.principioActivo, usadas),
    color: `var(--med-${(i % 8) + 1})`,
    letra: letraDe(i),
    ...(it.descripcion ? { descripcion: it.descripcion } : {}),
  }));
}

/** A…Z, luego AA, AB… (nunca se repite una letra entre tratamientos). */
function letraDe(i: number): string {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// ───────────────────────── alvéolos ─────────────────────────

export function construirAlveolos(mapas: MapaBlister[], tomas: TomaPreparacion[], lineas: LineaReparto[]): EvaluacionPreparacion['alveolos'] {
  const porCelda = new Map<string, TomaPreparacion[]>();
  for (const t of tomas) {
    const k = `${t.fecha}|${t.momentoId}`;
    (porCelda.get(k) ?? porCelda.set(k, []).get(k)!).push(t);
  }
  const out: EvaluacionPreparacion['alveolos'] = [];
  for (const mapa of mapas) {
    for (const c of mapa.celdas) {
      const contenido: EvaluacionPreparacion['alveolos'][number]['contenido'] = [];
      if (c.fecha !== null) {
        for (const t of porCelda.get(`${c.fecha}|${c.momentoId}`) ?? []) {
          let asignado = 0;
          for (const l of lineas) {
            if (l.tratamientoId === t.tratamientoId && l.fecha === c.fecha && l.momentoId === c.momentoId) {
              contenido.push({ tratamientoId: t.tratamientoId, unidades: l.unidades, envaseId: l.envaseId, lote: l.lote });
              asignado += aCuartos(l.unidades);
            }
          }
          const resto = aCuartos(t.unidades) - asignado;
          // Unidades que la pauta pide y ninguna caja cubre: se enseñan SIN caja (no se inventa un lote).
          if (resto > 0) contenido.push({ tratamientoId: t.tratamientoId, unidades: resto / 4 });
        }
      }
      out.push({ mapa: mapa.indice, fila: c.fila, columna: c.columna, fecha: c.fecha, momentoId: c.momentoId, contenido });
    }
  }
  return out;
}

// ───────────────────────── consentimientos ─────────────────────────

export interface FirmadoFila { id: number; codigo: string; version: number; firmadoEn: string; firmante: string; revocadoEn: string | null }

export function consentimientosDe(db: Db, pacienteId: number): { estado: EstadoConsentimientos; firmados: FirmadoFila[] } {
  const filas = db.all<R>(
    `SELECT d.id, p.codigo, p.version, d.firmado_en, d.firmante, d.revocado_en
       FROM documento_firmado d JOIN plantilla_documento p ON p.id = d.plantilla_id
      WHERE d.paciente_id = ? ORDER BY d.id`, [pacienteId]);
  const firmados: FirmadoFila[] = filas.map((f) => ({
    id: Number(f.id), codigo: String(f.codigo), version: Number(f.version), firmadoEn: String(f.firmado_en),
    firmante: String(f.firmante), revocadoEn: f.revocado_en ?? null,
  }));
  const vigentes = db.all<R>('SELECT codigo, version FROM plantilla_documento WHERE vigente = 1')
    .map((v) => ({ codigo: String(v.codigo), version: Number(v.version) }));
  const estado = estadoConsDominio(
    firmados.map((f) => ({ codigo: f.codigo, version: f.version, revocadoEn: f.revocadoEn })),
    vigentes, [...REQUERIDOS_PARA_VALIDAR_SPD]);
  return { estado, firmados };
}

// ───────────────────────── texto de la pauta (para «aparte») ─────────────────────────

const DIAS_SEMANA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export function textoPauta(p: Pauta, nombreMomento: (id: number) => string): string {
  const dosis = p.dosis.map((d) => `${formatearUnidades(d.unidades)} ${nombreMomento(d.momentoId).toLowerCase()}`).join(' + ');
  let patron = '';
  switch (p.patron) {
    case 'diario': patron = 'a diario'; break;
    case 'dias_semana': patron = `los ${(p.diasSemana ?? []).map((d) => DIAS_SEMANA[d - 1] ?? String(d)).join(', ')}`; break;
    case 'cada_n_dias': patron = `cada ${p.cadaNDias} días`; break;
    case 'ciclo': patron = `ciclo: ${p.cicloOn} días con toma y ${p.cicloOff} de descanso`; break;
    case 'si_precisa': patron = 'si precisa'; break;
  }
  return dosis === '' ? patron : `${dosis}, ${patron}`;
}

// ───────────────────────── carga + evaluación ─────────────────────────

const nombreDe = (t: R): string => [t.principio_activo, t.dosis_texto].filter((x) => typeof x === 'string' && x.trim() !== '').join(' ');

function pautaDeFila(db: Db, v: R): Pauta {
  const dosis = db.all<R>('SELECT momento_id, unidades FROM pauta_dosis WHERE pauta_version_id = ? ORDER BY momento_id', [v.id]);
  const p: Pauta = {
    vigenteDesde: v.vigente_desde,
    vigenteHasta: v.vigente_hasta ?? null,
    patron: v.patron,
    dosis: dosis.map((d) => ({ momentoId: Number(d.momento_id), unidades: Number(d.unidades) })),
  };
  if (v.patron === 'dias_semana') p.diasSemana = String(v.dias_semana ?? '').split(',').map((s) => Number(s.trim()));
  if (v.cada_n_dias != null) p.cadaNDias = Number(v.cada_n_dias);
  if (v.ciclo_on != null) p.cicloOn = Number(v.ciclo_on);
  if (v.ciclo_off != null) p.cicloOff = Number(v.ciclo_off);
  if (v.fecha_ancla != null) p.fechaAncla = v.fecha_ancla;
  return p;
}

export function leerMomentos(db: Db, soloActivos = true): MomentoToma[] {
  const filas = db.all<R>(`SELECT id, nombre, orden, hora FROM momento_toma ${soloActivos ? 'WHERE activo = 1' : ''} ORDER BY orden, id`);
  return filas.map((m) => ({ id: Number(m.id), nombre: String(m.nombre), orden: Number(m.orden), ...(m.hora ? { hora: String(m.hora) } : {}) }));
}

export function leerAlertas(db: Db): AlertaCalidad[] {
  return db.all<R>('SELECT referencia, cn, lote, fecha, descripcion FROM alerta_calidad ORDER BY id').map((a) => ({
    referencia: String(a.referencia),
    ...(a.cn ? { cn: String(a.cn) } : {}),
    ...(a.lote ? { lote: String(a.lote) } : {}),
    ...(a.fecha ? { fecha: String(a.fecha) } : {}),
    ...(a.descripcion ? { descripcion: String(a.descripcion) } : {}),
  }));
}

/** Fila de envase (con su medicamento) → Envase del dominio e InfoEnvase. */
export function envaseDeFila(e: R): { dom: Envase; info: InfoEnvase } {
  return {
    dom: {
      id: Number(e.id), tratamientoId: Number(e.tratamiento_id), cn: String(e.cn), lote: String(e.lote), caducidad: String(e.caducidad),
      ...(e.numero_serie ? { numeroSerie: String(e.numero_serie) } : {}),
      unidadesRestantes: Number(e.unidades_restantes), estado: e.estado,
    },
    info: {
      id: Number(e.id), cn: String(e.cn), medicamento: String(e.med_nombre ?? ''), lote: String(e.lote ?? ''), caducidad: String(e.caducidad ?? ''),
      descripcion: descripcionConfirmada(e),
    },
  };
}

export const SQL_ENVASE_CON_MED =
  `SELECT e.*, m.nombre AS med_nombre, m.descripcion_estado, m.descripcion_fisica, m.marcas_grabado
     FROM envase e JOIN medicamento m ON m.cn = e.cn`;

function anadirBloqueo(res: ResultadoPreparacion, b: Bloqueo): void {
  res.bloqueos.push(b);
  res.validable = false;
}

/** Evalúa con los datos ACTUALES de la base. No escribe nada. */
export function cargarEvaluacion(ctx: Contexto, o: OpcionesCarga): Cargado {
  const db = bd(ctx);
  const paciente = db.get<R>('SELECT * FROM paciente WHERE id = ?', [o.pacienteId]);
  if (!paciente) throw noEncontrado('El paciente no existe.');
  const farmacia = db.get<R>('SELECT * FROM farmacia WHERE id = 1');
  const ajustes = leerAjustesPrep(db);
  const momentos = leerMomentos(db);
  const nombreMomento = (id: number) => momentos.find((m) => m.id === id)?.nombre ?? `momento ${id}`;

  // Tratamientos activos con TODAS las versiones de su pauta.
  const trats = new Map<number, InfoTrat>();
  for (const t of db.all<R>('SELECT * FROM tratamiento WHERE paciente_id = ? AND finalizado_en IS NULL ORDER BY id', [o.pacienteId])) {
    const versiones: Pauta[] = [];
    const versionIds = new Map<Pauta, number>();
    for (const v of db.all<R>('SELECT * FROM pauta_version WHERE tratamiento_id = ? ORDER BY version', [t.id])) {
      const p = pautaDeFila(db, v);
      versiones.push(p);
      versionIds.set(p, Number(v.id));
    }
    trats.set(Number(t.id), {
      id: Number(t.id), nombre: nombreDe(t), principioActivo: String(t.principio_activo ?? ''), emblistable: Number(t.emblistable) !== 0,
      nota: typeof t.nota_farmaceutico === 'string' && t.nota_farmaceutico.trim() ? t.nota_farmaceutico.trim() : null,
      motivoNoEmblistable: typeof t.motivo_no_emblistable === 'string' && t.motivo_no_emblistable.trim() ? t.motivo_no_emblistable.trim() : null,
      cnPreferente: t.cn_preferente ?? null, versiones, versionIds,
    });
  }

  // Cajas en uso del paciente, agrupadas por la línea que abastecen. Una caja sin línea no se usa.
  const envasesPorTrat = new Map<number, Envase[]>();
  const envases = new Map<number, InfoEnvase>();
  const avisosExtra: Aviso[] = [];
  for (const e of db.all<R>(`${SQL_ENVASE_CON_MED} WHERE e.paciente_id = ? AND e.estado = 'en_uso' ORDER BY e.id`, [o.pacienteId])) {
    const id = Number(e.id);
    if (o.soloEnvases && !o.soloEnvases.has(id)) continue;
    if (e.tratamiento_id == null) {
      avisosExtra.push({ codigo: 'REPARTO_AVISO', texto: `La caja ${id} (${e.med_nombre}, lote ${e.lote}) no está asignada a ningún tratamiento: no se usa.` });
      continue;
    }
    const tid = Number(e.tratamiento_id);
    if (!trats.has(tid)) continue; // línea finalizada: no se usa
    const { dom, info } = envaseDeFila(e);
    (envasesPorTrat.get(tid) ?? envasesPorTrat.set(tid, []).get(tid)!).push(dom);
    envases.set(id, info);
  }

  const tratamientos: TratamientoPreparacion[] = [...trats.values()].map((t) => ({
    tratamientoId: t.id, nombre: t.nombre === '' ? `tratamiento ${t.id}` : t.nombre, emblistable: t.emblistable,
    versiones: t.versiones, envases: envasesPorTrat.get(t.id) ?? [],
  }));

  const { estado: consentimiento } = consentimientosDe(db, o.pacienteId);
  const entrada: EntradaPreparacion = {
    desde: o.desde, dias: o.dias, fechaPreparacion: o.fechaPreparacion, momentos, tratamientos,
    diasValidez: o.diasValidez ?? ajustes.diasValidezSpd,
    validezExtendidaPermitida: ajustes.validezExtendidaPermitida,
    justificacion: o.justificacion,
    rolValida: o.rol,
    consentimiento,
    disposicion: ajustes.disposicion,
    alertas: leerAlertas(db),
  };
  const res = evaluarDominio(entrada);
  res.avisos.push(...avisosExtra);

  // Bloqueos que el dominio no conoce (datos de la base): ante la duda, bloquea.
  if (paciente.estado !== 'activo') {
    anadirBloqueo(res, { codigo: 'ENTRADA_INVALIDA', texto: `El paciente figura como «${paciente.estado}»: no se prepara un SPD hasta reactivarlo.` });
  }
  for (const t of trats.values()) {
    if (t.emblistable && t.versiones.length === 0) {
      anadirBloqueo(res, { codigo: 'PAUTA_INVALIDA', texto: `${t.nombre || `Tratamiento ${t.id}`}: no tiene ninguna pauta definida.` });
    }
  }

  // «Aparte»: el texto que sale en la etiqueta lo escribe el farmacéutico (nota) o sale de la pauta.
  const aparteTextos = new Map<number, string>();
  for (const a of res.aparte) {
    const t = trats.get(a.tratamientoId);
    if (!t) continue;
    const v = pautaVigenteEn(t.versiones, o.desde) ?? t.versiones[t.versiones.length - 1];
    const partes = [t.nombre];
    if (v) partes.push(textoPauta(v, nombreMomento));
    const texto = partes.join(': ');
    aparteTextos.set(t.id, [texto, t.nota, t.motivoNoEmblistable ? `no emblistable: ${t.motivoNoEmblistable}` : null].filter(Boolean).join(' — '));
  }

  // Leyenda: la descripción es la de la caja usada (si hay) o la del medicamento preferente, sólo si está CONFIRMADA.
  const items: ItemLeyenda[] = [];
  for (const t of trats.values()) {
    const linea = res.lineasReparto.find((l) => l.tratamientoId === t.id);
    let descripcion = linea ? envases.get(linea.envaseId)?.descripcion : undefined;
    if (descripcion === undefined && t.cnPreferente) {
      descripcion = descripcionConfirmada(db.get<R>('SELECT descripcion_estado, descripcion_fisica, marcas_grabado FROM medicamento WHERE cn = ?', [t.cnPreferente]));
    }
    items.push({ tratamientoId: t.id, cn: t.cnPreferente, nombre: t.nombre === '' ? `Tratamiento ${t.id}` : t.nombre, principioActivo: t.principioActivo, descripcion });
  }

  const evaluacion: EvaluacionPreparacion = {
    ...res,
    lineasReparto: res.lineasReparto.map((l) => ({ ...l, cn: envases.get(l.envaseId)?.cn })),
    paciente: { id: Number(paciente.id), nombreCompleto: nombreCompleto(paciente) },
    leyenda: construirLeyenda(items),
    alveolos: construirAlveolos(res.mapas, res.tomas, res.lineasReparto),
  };
  return { evaluacion, aux: { paciente, farmacia, momentos, trats, envases, aparteTextos, ajustes, entrada } };
}

/** Frases sobre las cajas (ids) que tienen una alerta de calidad vigente. Vacío = ninguna. */
export function alertasSobreCajas(db: Db, ids: number[]): string[] {
  if (ids.length === 0) return [];
  const cajas: Envase[] = db.all<R>(`SELECT id, cn, lote, caducidad FROM envase WHERE id IN (${marcadores(ids.length)})`, ids)
    .map((e) => ({ id: Number(e.id), tratamientoId: 0, cn: String(e.cn), lote: String(e.lote ?? ''), caducidad: String(e.caducidad ?? ''), unidadesRestantes: 0, estado: 'en_uso' as const }));
  return envasesAfectados(cajas, leerAlertas(db)).afectados.map(
    (a) => `La caja ${a.envase.id} (lote ${a.envase.lote}) tiene una alerta de calidad (${a.alertas.map((x) => x.referencia).join(', ')}).`);
}

/** versión de pauta (id) que aplicaba a una línea el día `fecha`. */
export function versionDeLinea(aux: Aux, tratamientoId: number, fecha: string): number | undefined {
  const t = aux.trats.get(tratamientoId);
  if (!t) return undefined;
  const p = pautaVigenteEn(t.versiones, fecha);
  return p ? t.versionIds.get(p) : undefined;
}

// ───────────────────────── instantánea de una preparación guardada ─────────────────────────

/**
 * Evaluación de una preparación YA guardada (validada, entregada o anulada) a partir de lo que
 * se guardó (líneas y «aparte»), sin volver a calcular el reparto: las cajas ya se descontaron.
 */
export function cargarInstantanea(ctx: Contexto, prep: R): Cargado {
  const db = bd(ctx);
  const paciente = db.get<R>('SELECT * FROM paciente WHERE id = ?', [prep.paciente_id]);
  if (!paciente) throw noEncontrado('El paciente de la preparación no existe.');
  const farmacia = db.get<R>('SELECT * FROM farmacia WHERE id = 1');
  const ajustes = leerAjustesPrep(db);

  const lineasDb = db.all<R>(
    `SELECT l.*, t.principio_activo, t.dosis_texto, e.lote AS e_lote, e.caducidad AS e_caducidad, e.cn AS e_cn,
            m.nombre AS med_nombre, m.descripcion_estado, m.descripcion_fisica, m.marcas_grabado
       FROM preparacion_linea l
       JOIN tratamiento t ON t.id = l.tratamiento_id
       JOIN envase e ON e.id = l.envase_id
       JOIN medicamento m ON m.cn = e.cn
      WHERE l.preparacion_id = ? ORDER BY l.fecha, l.momento_id, l.id`, [prep.id]);
  const apartes = db.all<R>(
    `SELECT a.tratamiento_id, a.texto, t.principio_activo, t.dosis_texto FROM preparacion_aparte a
       JOIN tratamiento t ON t.id = a.tratamiento_id WHERE a.preparacion_id = ? ORDER BY a.tratamiento_id`, [prep.id]);

  const idsMomento = new Set(lineasDb.map((l) => Number(l.momento_id)));
  const activos = leerMomentos(db);
  const momentos = [...activos];
  for (const m of leerMomentos(db, false)) if (idsMomento.has(m.id) && !momentos.some((x) => x.id === m.id)) momentos.push(m);
  momentos.sort((a, b) => a.orden - b.orden || a.id - b.id);

  const envases = new Map<number, InfoEnvase>();
  const trats = new Map<number, InfoTrat>();
  const lineasReparto: LineaReparto[] = [];
  const tomasMapa = new Map<string, TomaPreparacion>();
  for (const l of lineasDb) {
    const envId = Number(l.envase_id);
    const tid = Number(l.tratamiento_id);
    const nombre = nombreDe(l);
    if (!envases.has(envId)) {
      envases.set(envId, { id: envId, cn: String(l.e_cn), medicamento: String(l.med_nombre ?? ''), lote: String(l.e_lote ?? ''), caducidad: String(l.e_caducidad ?? ''), descripcion: descripcionConfirmada(l) });
    }
    if (!trats.has(tid)) {
      trats.set(tid, { id: tid, nombre, principioActivo: String(l.principio_activo ?? ''), emblistable: true, nota: null, motivoNoEmblistable: null, cnPreferente: null, versiones: [], versionIds: new Map() });
    }
    lineasReparto.push({
      tratamientoId: tid, nombre: nombre === '' ? `tratamiento ${tid}` : nombre, fecha: String(l.fecha), momentoId: Number(l.momento_id),
      envaseId: envId, unidades: Number(l.unidades), lote: String(l.e_lote ?? ''), caducidad: String(l.e_caducidad ?? ''),
    });
    const k = `${tid}|${l.fecha}|${l.momento_id}`;
    const previa = tomasMapa.get(k);
    if (previa) previa.unidades = (aCuartos(previa.unidades) + aCuartos(Number(l.unidades))) / 4;
    else tomasMapa.set(k, { tratamientoId: tid, fecha: String(l.fecha), momentoId: Number(l.momento_id), unidades: Number(l.unidades) });
  }
  const aparteTextos = new Map<number, string>();
  const aparte: ResultadoPreparacion['aparte'] = [];
  for (const a of apartes) {
    const tid = Number(a.tratamiento_id);
    const nombre = nombreDe(a);
    aparteTextos.set(tid, String(a.texto));
    aparte.push({ tratamientoId: tid, nombre: nombre === '' ? `tratamiento ${tid}` : nombre });
    if (!trats.has(tid)) trats.set(tid, { id: tid, nombre, principioActivo: String(a.principio_activo ?? ''), emblistable: false, nota: null, motivoNoEmblistable: null, cnPreferente: null, versiones: [], versionIds: new Map() });
  }

  const dias = Math.round((Date.parse(prep.fecha_fin + 'T00:00:00Z') - Date.parse(prep.fecha_inicio + 'T00:00:00Z')) / 86_400_000) + 1;
  let mapas: MapaBlister[] = [];
  const avisos: Aviso[] = [];
  try { mapas = construirMapas(prep.fecha_inicio, dias, momentos, ajustes.disposicion); }
  catch (e) { avisos.push({ codigo: 'REPARTO_AVISO', texto: `No se ha podido reconstruir el mapa del blíster: ${e instanceof Error ? e.message : String(e)}` }); }

  // Alertas de calidad posteriores sobre las cajas usadas: se avisa (no se oculta).
  for (const texto of alertasSobreCajas(db, [...envases.keys()])) avisos.push({ codigo: 'REPARTO_AVISO', texto });

  const total = lineasReparto.reduce((s, l) => s + aCuartos(l.unidades), 0) / 4;
  const tomas = [...tomasMapa.values()];
  const res: ResultadoPreparacion = {
    validable: true, bloqueos: [], avisos,
    caducidadSpd: { ok: true, caducidadSpd: String(prep.caducidad_spd), fueraDeEstandar: Number(prep.fuera_de_estandar) === 1, avisos: [], errores: [] },
    finPeriodo: String(prep.fecha_fin), lineasReparto, unidadesEsperadas: total, unidadesAsignadas: total, faltantes: [],
    tomas, aparte, mapas,
  };
  const items: ItemLeyenda[] = [...trats.values()].map((t) => {
    const linea = lineasReparto.find((l) => l.tratamientoId === t.id);
    return { tratamientoId: t.id, cn: linea ? envases.get(linea.envaseId)?.cn ?? null : null, nombre: t.nombre === '' ? `Tratamiento ${t.id}` : t.nombre, principioActivo: t.principioActivo, descripcion: linea ? envases.get(linea.envaseId)?.descripcion : undefined };
  });
  const evaluacion: EvaluacionPreparacion = {
    ...res,
    lineasReparto: lineasReparto.map((l) => ({ ...l, cn: envases.get(l.envaseId)?.cn })),
    paciente: { id: Number(paciente.id), nombreCompleto: nombreCompleto(paciente) },
    leyenda: construirLeyenda(items),
    alveolos: construirAlveolos(mapas, tomas, lineasReparto),
  };
  return { evaluacion, aux: { paciente, farmacia, momentos, trats, envases, aparteTextos, ajustes } };
}
