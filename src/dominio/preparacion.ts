/**
 * Evaluación de una PREPARACIÓN de SPD (docs/04 §4.3-4.4): ¿se puede validar?
 *
 * Compone los módulos del dominio, de la pauta a la validación:
 *   pautas (versiones) → tomas → disposición del blíster → reparto a cajas
 *   (FEFO) → caducidad del SPD → periodo cabe → rol del que valida →
 *   consentimiento del servicio.
 *
 * REGLAS (seguridad del paciente primero, regla 1 de CLAUDE.md):
 *   - `validable` es true SÓLO si no hay ningún bloqueo. Ante la duda, bloquea
 *     y lo explica; nunca adivina un lote, una dosis ni un medicamento.
 *   - NUNCA lanza por datos del usuario: cualquier dato malo (fecha, pauta,
 *     unidades, momento…) sale como bloqueo con código estable.
 *   - Las unidades asignadas a cajas tienen que ser EXACTAMENTE las que pide la
 *     pauta (en cuartos enteros, sin error de coma flotante).
 *   - Los tratamientos con `emblistable: false` no entran en el blíster ni en
 *     el reparto: se listan en `aparte` («administrar aparte» en la etiqueta).
 *
 * FUNCIÓN PURA: sin disco, red ni reloj (la fecha de preparación y el rol los
 * pone quien llama). Fechas ISO AAAA-MM-DD.
 */
import type { Envase, MomentoToma, Pauta, TomaDia } from './tipos.ts';
import type { EstadoConsentimientos } from './documentos.ts';
import { avisosPauta, MAX_DIAS_PERIODO, pautaVigenteEn, tomasDelPeriodoVersiones, validarPauta } from './calendario-pauta.ts';
import { construirMapas, ubicarToma } from './disposicion-blister.ts';
import type { MapaBlister, OpcionesDisposicion } from './disposicion-blister.ts';
import { repartirTomas } from './consumo-envases.ts';
import { envasesAfectados } from './alertas-calidad.ts';
import type { AlertaCalidad } from './alertas-calidad.ts';
import { calcularCaducidadSpd, DIAS_VALIDEZ_ESTANDAR, periodoCabe, puedeValidar } from './caducidad-spd.ts';
import { cruzarAlergias, textoPosibleAlergia } from './alergias-medicacion.ts';
import type { ResultadoCaducidad, Rol } from './caducidad-spd.ts';

// ───────────────────────── entrada ─────────────────────────

/** Un tratamiento (línea de medicación) del paciente en esta preparación. */
export interface TratamientoPreparacion {
  tratamientoId: number;
  /** Nombre que se enseña en bloqueos y avisos. */
  nombre: string;
  /** Principio activo (sin dosis), para cruzar con las alergias del paciente. Si falta se usa `nombre`. */
  principioActivo?: string;
  /** false = «aparte» (no emblistable): no entra en el blíster. Por defecto true. */
  emblistable?: boolean;
  /** TODAS las versiones de la pauta (la vigente cada día la decide el calendario). */
  versiones: Pauta[];
  /** Cajas custodiadas de ESTE tratamiento (las de otro tratamiento bloquean). */
  envases: Envase[];
}

export interface EntradaPreparacion {
  /** Primer día de administración. */
  desde: string;
  /** Días del periodo (1…MAX_DIAS_PERIODO). */
  dias: number;
  /** Día en que se desemblista/prepara (no puede ser posterior a `desde`). */
  fechaPreparacion: string;
  /** Momentos de toma definidos por el farmacéutico (columnas del blíster). */
  momentos: MomentoToma[];
  tratamientos: TratamientoPreparacion[];
  /** Validez pretendida del SPD en días. Por defecto 14. */
  diasValidez?: number;
  /** Ajuste del titular: ¿se admite validez de más de 14 días? Por defecto false. */
  validezExtendidaPermitida?: boolean;
  /** Justificación escrita, obligatoria si diasValidez > 14. */
  justificacion?: string;
  /** Rol del usuario que valida: sólo farmacéutico/titular. */
  rolValida: Rol;
  /**
   * ¿Consentimiento del servicio (`consentimiento_spd`) vigente y sin revocar?
   * Un booleano, o el resultado de `estadoConsentimientos()` (entonces `completo`
   * debe ser true: cualquier consentimiento requerido que falte bloquea).
   * Cualquier otra cosa (undefined…) cuenta como NO vigente.
   */
  consentimiento: boolean | EstadoConsentimientos;
  /** Disposición del blíster (inicio de día, rotación…). */
  disposicion?: Partial<OpcionesDisposicion>;
  /** Alertas de calidad vigentes: las cajas afectadas NO se reparten (y se avisa con la referencia). */
  alertas?: AlertaCalidad[];
  /**
   * Descripción física de cada medicamento (por CN) que puede salir en el reparto. Regla 2 de CLAUDE.md: lo que llega al
   * blíster lo identifica una descripción CONFIRMADA por un farmacéutico. Si se informa, TODO CN usado tiene que figurar
   * aquí con `descripcionConfirmada: true`; si falta o es false, bloquea. Ausente = no se comprueba (uso sólo en pruebas).
   */
  medicamentos?: { cn: string; nombre: string; descripcionConfirmada: boolean }[];
  /** Alergias vigentes del paciente (texto libre). Se cruzan SÓLO por nombre del principio activo. */
  alergias?: string[];
  /** Un farmacéutico confirma que ha revisado las posibles alergias detectadas (no quita el aviso). */
  alergiasConfirmadas?: boolean;
}

// ───────────────────────── salida ─────────────────────────

/**
 * Códigos de bloqueo ESTABLES (se pueden guardar, traducir y probar).
 * Añadir códigos está permitido; renombrar uno es un cambio de contrato.
 */
export type CodigoBloqueo =
  | 'ENTRADA_INVALIDA' | 'PERIODO_INVALIDO' | 'FECHA_PREPARACION_INVALIDA' | 'PREPARACION_POSTERIOR_AL_INICIO'
  | 'MOMENTOS_INVALIDOS' | 'DISPOSICION_INVALIDA' | 'TRATAMIENTO_REPETIDO' | 'PAUTA_INVALIDA'
  | 'MOMENTO_INEXISTENTE' | 'TOMA_SIN_CELDA' | 'ENVASE_DE_OTRO_TRATAMIENTO' | 'REPARTO_ERROR'
  | 'APARTE_CAJA_CADUCADA' | 'APARTE_ALERTA_CALIDAD' | 'PAUTA_CON_HUECOS'
  | 'UNIDADES_INSUFICIENTES' | 'UNIDADES_NO_CUADRAN' | 'CAJA_CADUCA_EN_PERIODO' | 'NADA_QUE_PREPARAR'
  | 'SIN_LOTES_USADOS' | 'VALIDEZ_EXTENDIDA_NO_ACTIVADA' | 'JUSTIFICACION_FALTA' | 'CADUCIDAD_INVALIDA'
  | 'PERIODO_NO_CABE' | 'ROL_NO_PUEDE_VALIDAR' | 'CONSENTIMIENTO_NO_VIGENTE' | 'ERROR_INTERNO'
  | 'DESCRIPCION_FISICA_SIN_CONFIRMAR' | 'ALERGIA_SIN_CONFIRMAR' | 'PERIODO_SOLAPADO' | 'FECHA_PREPARACION_FUTURA';

export type CodigoAviso =
  | 'APARTE_NO_EMBLISTABLE' | 'A_DEMANDA' | 'PAUTA_SIN_COBERTURA' | 'SIN_TOMAS_EN_PERIODO' | 'CAJA_EXCLUIDA_POR_CADUCIDAD' | 'CAJA_SIN_UNIDADES'
  | 'TOMA_DOS_LOTES' | 'REPARTO_AVISO' | 'PAUTA_AVISO' | 'VALIDEZ_FUERA_DE_ESTANDAR' | 'CADUCIDAD_AVISO'
  | 'POSIBLE_ALERGIA' | 'BORRADOR_SOLAPADO';

export interface Bloqueo { codigo: CodigoBloqueo; texto: string }
export interface Aviso { codigo: CodigoAviso; texto: string }

/** Una línea del reparto: de qué caja (y lote) sale cada toma. */
export interface LineaReparto {
  tratamientoId: number;
  nombre: string;
  fecha: string;
  momentoId: number;
  envaseId: number;
  unidades: number;
  lote: string;
  caducidad: string;
}

export interface TomaPreparacion extends TomaDia { tratamientoId: number }

export interface ResultadoPreparacion {
  /** true sólo si `bloqueos` está vacío. */
  validable: boolean;
  bloqueos: Bloqueo[];
  avisos: Aviso[];
  /** Resultado de calcularCaducidadSpd; ausente si no se pudo ni calcular (sin lotes, fechas inválidas). */
  caducidadSpd?: ResultadoCaducidad;
  /** Último día de administración (desde + dias − 1); ausente si el periodo no es válido. */
  finPeriodo?: string;
  lineasReparto: LineaReparto[];
  /** Unidades que pide la pauta en el periodo (sólo emblistables). */
  unidadesEsperadas: number;
  /** Unidades repartidas a cajas. Tiene que ser igual a las esperadas. */
  unidadesAsignadas: number;
  /** Cuánto falta por tratamiento (sólo los que faltan). */
  faltantes: { tratamientoId: number; nombre: string; faltan: number }[];
  /** Tomas calculadas de los tratamientos emblistables (vacío si la pauta no es válida). */
  tomas: TomaPreparacion[];
  /**
   * Medicación «aparte»: no entra en el blíster pero sale en la etiqueta. `ademanda`: pauta «si precisa»
   * (PRN) de un tratamiento marcado emblistable: se lista siempre, nunca se omite.
   */
  aparte: { tratamientoId: number; nombre: string; ademanda?: boolean }[];
  mapas: MapaBlister[];
}

// ───────────────────────── utilidades internas ─────────────────────────

const MS_DIA = 86_400_000;

/** Fecha ISO REAL de calendario (V8 desborda «2026-02-30» a marzo: se comprueba la ida y vuelta). */
const esFecha = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

function sumarDias(fecha: string, dias: number): string {
  return new Date(Date.parse(fecha + 'T00:00:00Z') + dias * MS_DIA).toISOString().slice(0, 10);
}

/** Unidades → cuartos enteros (las cantidades son múltiplos de 0,25). */
const cuartos = (u: number): number => Math.round(u * 4);

/** Rangos legibles «2026-11-09 a 2026-11-15» de una lista de días ISO ordenados. */
function rangos(dias: string[]): string {
  const out: string[] = [];
  let ini = 0;
  for (let i = 1; i <= dias.length; i++) {
    if (i === dias.length || sumarDias(dias[i - 1], 1) !== dias[i]) {
      out.push(ini === i - 1 ? dias[ini] : `${dias[ini]} a ${dias[i - 1]}`);
      ini = i;
    }
  }
  return out.join(', ');
}

const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ───────────────────────── evaluación ─────────────────────────

export function evaluarPreparacion(entrada: EntradaPreparacion): ResultadoPreparacion {
  const res: ResultadoPreparacion = {
    validable: false, bloqueos: [], avisos: [], lineasReparto: [],
    unidadesEsperadas: 0, unidadesAsignadas: 0, faltantes: [], tomas: [], aparte: [], mapas: [],
  };
  try {
    evaluar(entrada, res);
  } catch (e) {
    // Red de seguridad: un fallo imprevisto NUNCA puede dejar pasar la validación.
    res.bloqueos.push({ codigo: 'ERROR_INTERNO', texto: `No se ha podido evaluar la preparación: ${mensaje(e)}` });
  }
  res.validable = res.bloqueos.length === 0;
  return res;
}

function evaluar(entrada: EntradaPreparacion, res: ResultadoPreparacion): void {
  const bloquear = (codigo: CodigoBloqueo, texto: string) => { res.bloqueos.push({ codigo, texto }); };
  const avisar = (codigo: CodigoAviso, texto: string) => { res.avisos.push({ codigo, texto }); };

  if (entrada === null || typeof entrada !== 'object') {
    bloquear('ENTRADA_INVALIDA', 'La entrada de la preparación no es válida.');
    return;
  }

  // ── 1. Periodo y fechas ──
  const { desde, dias, fechaPreparacion } = entrada;
  let fin: string | undefined;
  if (esFecha(desde) && Number.isInteger(dias) && dias >= 1 && dias <= MAX_DIAS_PERIODO) {
    const f = sumarDias(desde, dias - 1);
    if (esFecha(f)) fin = f;
  }
  if (fin === undefined) {
    bloquear('PERIODO_INVALIDO', `El periodo no es válido: inicio «${String(desde)}», ${String(dias)} días (se admiten de 1 a ${MAX_DIAS_PERIODO}).`);
  } else {
    res.finPeriodo = fin;
  }
  const preparacionOk = esFecha(fechaPreparacion);
  if (!preparacionOk) {
    bloquear('FECHA_PREPARACION_INVALIDA', `La fecha de preparación no es válida: «${String(fechaPreparacion)}».`);
  } else if (esFecha(desde) && fechaPreparacion > desde) {
    bloquear('PREPARACION_POSTERIOR_AL_INICIO', `La preparación (${fechaPreparacion}) es posterior al primer día de administración (${desde}).`);
  }

  // ── 2. Momentos y disposición del blíster ──
  const momentos = Array.isArray(entrada.momentos) ? entrada.momentos : [];
  const idsMomento = new Set<number>();
  let momentosOk = momentos.length > 0;
  for (const m of momentos) {
    if (m === null || typeof m !== 'object' || !Number.isFinite(m.id) || idsMomento.has(m.id)) momentosOk = false;
    else idsMomento.add(m.id);
  }
  if (!momentosOk) bloquear('MOMENTOS_INVALIDOS', 'Los momentos de toma no son válidos: hay que definir al menos uno y sin repetir.');
  const disp = entrada.disposicion ?? {};
  const dispOk = disp !== null && typeof disp === 'object'
    && (disp.inicioDia === undefined || disp.inicioDia === 'convencional' || disp.inicioDia === 'cronologico')
    && (disp.sentidoTomas === undefined || disp.sentidoTomas === 'izquierda_derecha' || disp.sentidoTomas === 'derecha_izquierda')
    && (disp.posicionInicial === undefined || disp.posicionInicial === 'izquierda' || disp.posicionInicial === 'derecha')
    && (disp.rotar180 === undefined || typeof disp.rotar180 === 'boolean');
  if (!dispOk) bloquear('DISPOSICION_INVALIDA', 'La disposición del blíster no es válida (inicio de día, sentido o rotación desconocidos).');
  if (fin !== undefined && momentosOk && dispOk) {
    try {
      res.mapas = construirMapas(desde, dias, momentos, disp);
    } catch (e) {
      bloquear('DISPOSICION_INVALIDA', `No se puede construir la disposición del blíster: ${mensaje(e)}`);
    }
  }
  const hayMapas = res.mapas.length > 0;

  // ── 3. Tratamientos: tomas, celdas y reparto a cajas ──
  const tratamientos = Array.isArray(entrada.tratamientos) ? entrada.tratamientos : null;
  if (tratamientos === null) {
    bloquear('ENTRADA_INVALIDA', 'La lista de tratamientos no es válida.');
  }
  const vistos = new Set<number>();
  let esperadasC = 0;
  let asignadasC = 0;
  const lotesUsados: Envase[] = [];
  const cajasAparte: Envase[] = [];

  /** Cajas de medicación que va aparte / a demanda: caducidad y alertas se comprueban igual que las del blíster. */
  const revisarCajasAparte = (nombre: string, envases: unknown, tratamientoId: number): void => {
    for (const e of Array.isArray(envases) ? (envases as Envase[]) : []) {
      if (e === null || typeof e !== 'object' || e.estado !== 'en_uso' || !(e.unidadesRestantes > 0)) continue;
      if (e.tratamientoId !== tratamientoId) {
        bloquear('ENVASE_DE_OTRO_TRATAMIENTO', `${nombre}: la caja ${e.id} (lote ${e.lote}) pertenece al tratamiento ${e.tratamientoId}; no se usa.`);
        continue;
      }
      cajasAparte.push(e);
      if (!esFecha(e.caducidad)) {
        bloquear('CADUCIDAD_INVALIDA', `${nombre} (aparte): la caja ${e.id} (lote ${e.lote}) no tiene una caducidad válida.`);
      } else if (fin !== undefined && e.caducidad < fin) {
        bloquear('APARTE_CAJA_CADUCADA', `${nombre} (aparte): la caja ${e.id} (lote ${e.lote}) caduca el ${e.caducidad}, antes del fin del periodo (${fin}): no se entrega.`);
      }
    }
    const afectadas = envasesAfectados((Array.isArray(envases) ? (envases as Envase[]) : []).filter((e) => e?.estado === 'en_uso'), Array.isArray(entrada.alertas) ? entrada.alertas : []).afectados;
    for (const a of afectadas) {
      bloquear('APARTE_ALERTA_CALIDAD', `${nombre} (aparte): la caja ${a.envase.id} (lote ${a.envase.lote}) tiene una alerta de calidad (${a.alertas.map((x) => x.referencia).join(', ')}): apártala y no la entregues.`);
    }
  };

  for (const t of tratamientos ?? []) {
    const nombre = typeof t?.nombre === 'string' && t.nombre.trim() ? t.nombre : `tratamiento ${String(t?.tratamientoId)}`;
    if (t === null || typeof t !== 'object') { bloquear('ENTRADA_INVALIDA', 'Un tratamiento de la lista no es válido.'); continue; }
    if (vistos.has(t.tratamientoId)) {
      bloquear('TRATAMIENTO_REPETIDO', `El tratamiento ${t.tratamientoId} (${nombre}) aparece más de una vez.`);
      continue;
    }
    vistos.add(t.tratamientoId);

    if (t.emblistable === false) {
      res.aparte.push({ tratamientoId: t.tratamientoId, nombre });
      avisar('APARTE_NO_EMBLISTABLE', `${nombre}: no es emblistable; se administra aparte y sale en la etiqueta.`);
      revisarCajasAparte(nombre, t.envases, t.tratamientoId);
      continue;
    }
    if (fin === undefined) continue; // sin periodo válido no hay tomas que calcular

    // 3.1 tomas de la pauta vigente cada día
    let tomas: TomaDia[];
    try {
      tomas = tomasDelPeriodoVersiones(t.versiones, desde, fin);
    } catch (e) {
      bloquear('PAUTA_INVALIDA', `${nombre}: ${mensaje(e)}`);
      continue;
    }
    avisosDePauta(t.versiones, desde, fin).forEach((x) => avisar('PAUTA_AVISO', `${nombre}: ${x}`));

    // 3.1.b huecos: días del periodo sin NINGUNA pauta vigente (p. ej. una pauta temporal cerró la crónica)
    const sinPauta: string[] = [];
    const conPauta: string[] = [];
    for (let i = 0; i < dias; i++) {
      const d = sumarDias(desde, i);
      (pautaVigenteEn(t.versiones, d) ? conPauta : sinPauta).push(d);
    }
    if (sinPauta.length > 0 && conPauta.length > 0) {
      const ultimoCubierto = conPauta[conPauta.length - 1];
      const interior = sinPauta.filter((d) => d < ultimoCubierto);
      const finales = sinPauta.filter((d) => d > ultimoCubierto);
      if (interior.length > 0) {
        bloquear('PAUTA_CON_HUECOS', `${nombre}: no hay ninguna pauta vigente los días ${rangos(interior)}, entre días con pauta. El medicamento no se prepararía esos días: corrige las fechas de las pautas o finaliza el tratamiento.`);
      }
      if (finales.length > 0) {
        avisar('PAUTA_SIN_COBERTURA', `${nombre}: la última pauta termina el ${ultimoCubierto} y los días ${rangos(finales)} del periodo quedan SIN pauta (no se prepara nada). Si el tratamiento debe continuar (p. ej. una pauta temporal sustituyó a la crónica), añade la pauta que continúa.`);
      }
    }

    // 3.1.c «si precisa» marcado emblistable: se lista SIEMPRE como «a demanda», nunca se omite
    if (t.versiones.some((v) => v?.patron === 'si_precisa' && v.vigenteDesde <= fin && (v.vigenteHasta == null || v.vigenteHasta >= desde))) {
      res.aparte.push({ tratamientoId: t.tratamientoId, nombre, ademanda: true });
      avisar('A_DEMANDA', `${nombre}: pauta «si precisa»; no va en el blíster, sale en la etiqueta como «a demanda».`);
      revisarCajasAparte(nombre, t.envases, t.tratamientoId);
    }
    if (tomas.length === 0) avisar('SIN_TOMAS_EN_PERIODO', `${nombre}: la pauta no tiene ninguna toma en el periodo.`);
    for (const x of tomas) res.tomas.push({ ...x, tratamientoId: t.tratamientoId });
    const esperadasT = tomas.reduce((s, x) => s + cuartos(x.unidades), 0);
    esperadasC += esperadasT;

    // 3.2 cada toma tiene que caer en una celda del blíster
    const sinMomento = [...new Set(tomas.map((x) => x.momentoId))].filter((id) => !idsMomento.has(id));
    for (const id of sinMomento) {
      if (momentosOk) bloquear('MOMENTO_INEXISTENTE', `${nombre}: la pauta usa el momento ${id}, que no existe entre los momentos de toma.`);
    }
    if (hayMapas) {
      const sinCelda = tomas.filter((x) => idsMomento.has(x.momentoId) && !ubicarToma(res.mapas, x.fecha, x.momentoId));
      if (sinCelda.length > 0) {
        bloquear('TOMA_SIN_CELDA', `${nombre}: ${sinCelda.length} toma(s) no tienen celda en el blíster (p. ej. ${sinCelda[0].fecha}, momento ${sinCelda[0].momentoId}).`);
      }
    }

    // 3.3 cajas: una caja de otro tratamiento NUNCA se usa
    const envases = Array.isArray(t.envases) ? t.envases : [];
    const propios: Envase[] = [];
    for (const e of envases) {
      if (e.estado === 'en_uso' && e.tratamientoId !== t.tratamientoId) {
        bloquear('ENVASE_DE_OTRO_TRATAMIENTO', `${nombre}: la caja ${e.id} (lote ${e.lote}) pertenece al tratamiento ${e.tratamientoId}; no se usa.`);
      } else propios.push(e);
    }

    // 3.4 reparto FEFO
    if (!preparacionOk) continue; // sin fecha de preparación no se puede repartir (ya bloqueado)
    const r = repartirTomas(propios, tomas, { fechaPreparacion, fechaFinPeriodo: fin, alertas: entrada.alertas });
    r.errores.forEach((x) => bloquear('REPARTO_ERROR', `${nombre}: ${x}`));
    const porId = new Map(propios.map((e) => [e.id, e]));
    for (const e of propios) {
      if (e.estado === 'en_uso' && esFecha(e.caducidad) && e.caducidad < fin && e.unidadesRestantes > 0) {
        avisar('CAJA_EXCLUIDA_POR_CADUCIDAD', `${nombre}: la caja ${e.id} (lote ${e.lote}) caduca el ${e.caducidad}, antes del fin del periodo (${fin}): no se usa.`);
      }
    }
    for (const a of r.avisos) {
      if (/no se usa\.$/.test(a) || a.startsWith('No alcanzan')) continue; // ya dichos con su código propio
      if (a.startsWith('Toma con dos lotes')) avisar('TOMA_DOS_LOTES', `${nombre}: ${a}`);
      else if (/sin unidades: se ignora/.test(a)) avisar('CAJA_SIN_UNIDADES', `${nombre}: ${a}`);
      else avisar('REPARTO_AVISO', `${nombre}: ${a}`);
    }
    let asignadasT = 0;
    for (const l of r.lineas) {
      const caja = porId.get(l.envaseId);
      if (!caja) { bloquear('REPARTO_ERROR', `${nombre}: el reparto usa una caja desconocida (${l.envaseId}).`); continue; }
      if (caja.caducidad < fin) {
        bloquear('CAJA_CADUCA_EN_PERIODO', `${nombre}: la caja ${caja.id} (lote ${caja.lote}) caduca el ${caja.caducidad}, antes del fin del periodo (${fin}).`);
      }
      asignadasT += cuartos(l.unidades);
      res.lineasReparto.push({
        tratamientoId: t.tratamientoId, nombre, fecha: l.fecha, momentoId: l.momentoId,
        envaseId: l.envaseId, unidades: l.unidades, lote: caja.lote, caducidad: caja.caducidad,
      });
      if (!lotesUsados.includes(caja)) lotesUsados.push(caja);
    }
    asignadasC += asignadasT;
    if (r.faltan > 0) {
      res.faltantes.push({ tratamientoId: t.tratamientoId, nombre, faltan: r.faltan });
      bloquear('UNIDADES_INSUFICIENTES', `${nombre}: faltan ${r.faltan} unidades (se asignan ${asignadasT / 4} de ${esperadasT / 4}).`);
    }
  }

  res.unidadesEsperadas = esperadasC / 4;
  res.unidadesAsignadas = asignadasC / 4;
  if (fin !== undefined && esperadasC === 0 && tratamientos !== null) {
    bloquear('NADA_QUE_PREPARAR', 'No hay ninguna toma que emblistar en el periodo.');
  }
  if (asignadasC !== esperadasC) {
    bloquear('UNIDADES_NO_CUADRAN', `Las unidades asignadas a cajas (${res.unidadesAsignadas}) no coinciden con las que pide la pauta (${res.unidadesEsperadas}).`);
  }

  // ── 3.bis Descripción física confirmada de lo que se usa (regla 2: nada clínico se inventa) ──
  if (Array.isArray(entrada.medicamentos)) {
    const porCn = new Map(entrada.medicamentos.map((m) => [m?.cn, m]));
    const avisadas = new Set<string>();
    for (const caja of lotesUsados) {
      const m = porCn.get(caja.cn);
      if (m?.descripcionConfirmada === true || avisadas.has(caja.cn)) continue;
      avisadas.add(caja.cn);
      bloquear('DESCRIPCION_FISICA_SIN_CONFIRMAR',
        `${m?.nombre ?? `CN ${caja.cn}`} (CN ${caja.cn}): su descripción física no está confirmada por un farmacéutico, así que no se puede identificar en el blíster. Confírmala en la ficha del medicamento antes de preparar.`);
    }
  }

  // ── 3.ter Alergias registradas frente al tratamiento (sólo por nombre; aviso fuerte + confirmación) ──
  if (Array.isArray(entrada.alergias) && entrada.alergias.length > 0 && tratamientos !== null) {
    const coinc = cruzarAlergias(entrada.alergias, tratamientos.filter((t) => t !== null && typeof t === 'object')
      .map((t) => ({ tratamientoId: t.tratamientoId, nombre: typeof t.nombre === 'string' ? t.nombre : `tratamiento ${t.tratamientoId}`, principioActivo: typeof t.principioActivo === 'string' ? t.principioActivo : String(t.nombre ?? '') })));
    for (const c of coinc) avisar('POSIBLE_ALERGIA', textoPosibleAlergia(c));
    if (coinc.length > 0 && entrada.alergiasConfirmadas !== true) {
      bloquear('ALERGIA_SIN_CONFIRMAR', `Hay ${coinc.length === 1 ? 'una posible alergia' : `${coinc.length} posibles alergias`} sin confirmar (${[...new Set(coinc.map((c) => `${c.nombre}: «${c.alergia}»`))].join('; ')}). Un farmacéutico tiene que revisarlo y confirmarlo para validar.`);
    }
  }

  // ── 4. Caducidad del SPD y encaje del periodo ──
  const caducidadesAparte = cajasAparte.filter((c) => esFecha(c.caducidad)).map((c) => c.caducidad);
  if (lotesUsados.length === 0) {
    if (esperadasC > 0) bloquear('SIN_LOTES_USADOS', 'No se ha usado ningún lote: no se puede calcular la caducidad del SPD.');
  } else if (preparacionOk) {
    const cad = calcularCaducidadSpd({
      caducidadesLotes: [...lotesUsados.map((c) => c.caducidad), ...caducidadesAparte], // la medicación aparte también acota la caducidad
      fechaPreparacion,
      diasValidez: entrada.diasValidez ?? DIAS_VALIDEZ_ESTANDAR,
      validezExtendidaPermitida: entrada.validezExtendidaPermitida ?? false,
      justificacion: entrada.justificacion,
    });
    res.caducidadSpd = cad;
    if (!cad.ok) {
      for (const e of cad.errores) {
        const codigo: CodigoBloqueo = /no activada/.test(e) ? 'VALIDEZ_EXTENDIDA_NO_ACTIVADA'
          : /justificación/.test(e) ? 'JUSTIFICACION_FALTA' : 'CADUCIDAD_INVALIDA';
        bloquear(codigo, e);
      }
    } else if (fin !== undefined && cad.caducidadSpd !== undefined && !periodoCabe(fin, cad.caducidadSpd)) {
      bloquear('PERIODO_NO_CABE', `El último día de administración (${fin}) es posterior a la caducidad del SPD (${cad.caducidadSpd}). El SPD cubre como máximo ${entrada.diasValidez ?? DIAS_VALIDEZ_ESTANDAR} días naturales contando el de la preparación (${fechaPreparacion}), o menos si un lote caduca antes.`);
    }
    if (cad.fueraDeEstandar) avisar('VALIDEZ_FUERA_DE_ESTANDAR', `Validez superior a ${DIAS_VALIDEZ_ESTANDAR} días: queda marcada como desviación y exige su justificación.`);
    cad.avisos.forEach((x) => avisar('CADUCIDAD_AVISO', x));
  }

  // ── 5. Quién valida y consentimiento del servicio ──
  if (!puedeValidar(entrada.rolValida)) {
    bloquear('ROL_NO_PUEDE_VALIDAR', 'Sólo un farmacéutico o el titular puede validar un SPD.');
  }
  const c = entrada.consentimiento;
  if (c === true) { /* vigente */ }
  else if (c !== null && typeof c === 'object' && typeof c.completo === 'boolean') {
    if (!c.completo) {
      const partes = [
        c.faltan?.length ? `sin firmar: ${c.faltan.join(', ')}` : '',
        c.desactualizados?.length ? `desactualizados: ${c.desactualizados.join(', ')}` : '',
        c.revocados?.length ? `revocados: ${c.revocados.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      bloquear('CONSENTIMIENTO_NO_VIGENTE', `Los consentimientos del paciente no están vigentes${partes ? ` (${partes})` : ''}.`);
    }
  } else {
    bloquear('CONSENTIMIENTO_NO_VIGENTE', 'No consta un consentimiento del servicio vigente: no se puede validar.');
  }
}

/** Avisos de las versiones de pauta que tocan el periodo (sin repetir texto). */
function avisosDePauta(versiones: Pauta[], desde: string, fin: string): string[] {
  const out: string[] = [];
  for (const v of versiones) {
    if (validarPauta(v).length > 0) continue;
    if (v.vigenteDesde > fin || (v.vigenteHasta != null && v.vigenteHasta < desde)) continue;
    for (const a of avisosPauta(v)) if (!out.includes(a)) out.push(a);
  }
  return out;
}
