/**
 * Servicios clínicos de PREPARACIÓN y DOCUMENTOS (docs/04 §4.3-4.5, docs/07, docs/09).
 *
 * Ciclo de una preparación:  borrador → preparado → validado → entregado  (o anulado).
 *   - crearPreparacion  guarda un BORRADOR (reserva lo evaluado; NO descuenta unidades).
 *   - marcarPreparada   congela el reparto con la fecha real de preparación.
 *   - validarPreparacion  sólo farmacéutico/titular: vuelve a evaluar con los datos ACTUALES y,
 *     en UNA transacción, pasa a «validado» y DESCUENTA las unidades de las cajas.
 *   - registrarEntrega  sólo si está validada.
 *   - anularPreparacion  con motivo; si estaba validada y sin entregar, devuelve las unidades.
 *
 * Las reglas clínicas (reparto, caducidad, bloqueos) las decide src/dominio; aquí sólo se
 * lee/escribe la base, se comprueban permisos y se deja rastro en la auditoría.
 */
import { randomUUID } from 'node:crypto';
import type { Contexto } from './contexto.ts';
import { ErrorSpd, proteger } from './contexto.ts';
import type { Db } from './db.ts';
import type {
  ApiClinica, EstadoPreparacion, EvaluacionPreparacion, EvaluarPreparacionParams, PreparacionDto, UsuarioPublico, VistaImprimible,
} from './api.ts';
import { aplicarConsumo } from '../dominio/consumo-envases.ts';
import { puedeValidar } from '../dominio/caducidad-spd.ts';
import type { Envase } from '../dominio/tipos.ts';
import { alertasSobreCajas, cargarEvaluacion, cargarInstantanea, envaseDeFila, SQL_ENVASE_CON_MED, versionDeLinea } from './preparacion/carga.ts';
import type { Cargado } from './preparacion/carga.ts';
import { etiquetaHtml, hojaHtml } from './preparacion/vistas.ts';
import type { Quien } from './preparacion/vistas.ts';
import * as docs from './preparacion/documentos.ts';
import {
  aCuartos, ahoraISO, bd, diasEntre, esFechaIso, exigirSesion, fechaLocal, formatoFecha, hoyISO, invalido, marcadores, noEncontrado, textoONull,
} from './preparacion/util.ts';
import type { R } from './preparacion/util.ts';

export type MetodosPreparacion = Pick<ApiClinica,
  'evaluarPreparacion' | 'crearPreparacion' | 'marcarPreparada' | 'validarPreparacion' | 'registrarEntrega' | 'anularPreparacion'
  | 'listarPreparaciones' | 'obtenerPreparacion' | 'vistaEtiqueta' | 'vistaHojaPaciente' | 'listarPlantillasDocumento'
  | 'vistaDocumento' | 'registrarDocumentoFirmado' | 'revocarDocumento' | 'estadoConsentimientos'>;

/** Estos dos bloqueos se exigen al VALIDAR, no al guardar el borrador. */
const BLOQUEOS_DE_VALIDACION = new Set(['ROL_NO_PUEDE_VALIDAR', 'CONSENTIMIENTO_NO_VIGENTE']);
const ESTADOS: readonly string[] = ['borrador', 'preparado', 'validado', 'entregado', 'anulado'];

const SQL_PREP =
  `SELECT p.*, pa.nombre || ' ' || pa.apellido1 || COALESCE(' ' || NULLIF(TRIM(pa.apellido2), ''), '') AS pac_nombre,
          up.nombre AS prep_nombre, uv.nombre AS val_nombre
     FROM preparacion p
     JOIN paciente pa ON pa.id = p.paciente_id
     LEFT JOIN usuario up ON up.id = p.preparado_por
     LEFT JOIN usuario uv ON uv.id = p.validado_por`;

function aDto(r: R): PreparacionDto {
  return {
    id: Number(r.id), idPublico: String(r.id_publico), pacienteId: Number(r.paciente_id), pacienteNombre: String(r.pac_nombre ?? ''),
    fechaInicio: String(r.fecha_inicio), fechaFin: String(r.fecha_fin), caducidadSpd: String(r.caducidad_spd),
    validezDias: Number(r.validez_dias), fueraDeEstandar: Number(r.fuera_de_estandar) === 1, justificacionValidez: r.justificacion_validez ?? null,
    estado: r.estado as EstadoPreparacion, preparadoPor: r.prep_nombre ?? null, preparadoEn: r.preparado_en ?? null,
    validadoPor: r.val_nombre ?? null, validadoEn: r.validado_en ?? null,
    temperatura: r.temperatura ?? null, humedad: r.humedad ?? null, observaciones: r.observaciones ?? null,
  };
}

function leerPrep(db: Db, id: unknown): R {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw invalido('La preparación indicada no es válida.');
  const r = db.get<R>(`${SQL_PREP} WHERE p.id = ?`, [id]);
  if (!r) throw noEncontrado('La preparación no existe.');
  return r;
}

const dtoDe = (db: Db, id: number): PreparacionDto => aDto(leerPrep(db, id));

function exigirPreparador(u: UsuarioPublico): void {
  if (u.rol === 'administrativo') throw new ErrorSpd('Un usuario administrativo no puede preparar un SPD.', 'PERMISO');
}

function textos(bs: { texto: string }[]): string { return bs.map((b) => b.texto).join(' · '); }

function diasDe(prep: R): number { return diasEntre(String(prep.fecha_inicio), String(prep.fecha_fin)) + 1; }

/** Otra preparación del mismo paciente ya preparada/validada/entregada que cubre alguno de esos días. */
function exigirSinSolape(db: Db, pacienteId: number, idPropio: number, desde: string, hasta: string): void {
  const o = db.get<R>(
    `SELECT id, fecha_inicio, fecha_fin, estado FROM preparacion
      WHERE paciente_id = ? AND id <> ? AND estado IN ('preparado','validado','entregado') AND fecha_inicio <= ? AND fecha_fin >= ? LIMIT 1`,
    [pacienteId, idPropio, hasta, desde]);
  if (o) {
    throw new ErrorSpd(`El paciente ya tiene una preparación ${o.estado} (nº ${o.id}) del ${formatoFecha(o.fecha_inicio)} al ${formatoFecha(o.fecha_fin)} que se solapa con este periodo.`, 'PERIODO_SOLAPADO');
  }
}

function validarCondiciones(p: { temperatura?: unknown; humedad?: unknown; observaciones?: unknown }): { temperatura: number | null; humedad: number | null; observaciones: string | null } {
  const num = (v: unknown, campo: string, min: number, max: number): number | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw invalido(`«${campo}» no es válida.`);
    return v;
  };
  const temperatura = num(p.temperatura, 'temperatura', -20, 60);
  const humedad = num(p.humedad, 'humedad', 0, 100);
  let observaciones = p.observaciones === undefined || p.observaciones === null ? null : textoONull(p.observaciones);
  if (p.observaciones !== undefined && p.observaciones !== null && typeof p.observaciones !== 'string') throw invalido('«observaciones» debe ser texto.');
  const notas: string[] = [];
  if (temperatura !== null && (temperatura < 15 || temperatura > 25)) notas.push(`temperatura de la sala fuera de 15-25 ºC (${temperatura})`);
  if (humedad !== null && (humedad < 40 || humedad > 60)) notas.push(`humedad de la sala fuera de 40-60 % (${humedad})`);
  if (notas.length > 0) observaciones = [observaciones, `⚠ ${notas.join('; ')}.`].filter(Boolean).join('\n');
  return { temperatura, humedad, observaciones };
}

function comprobarParams(p: unknown): EvaluarPreparacionParams {
  const x = p as Partial<EvaluarPreparacionParams> | null;
  if (!x || typeof x !== 'object' || !Number.isInteger(x.pacienteId) || (x.pacienteId as number) <= 0) throw invalido('Falta el paciente.');
  return x as EvaluarPreparacionParams;
}

/** Guarda líneas y «aparte» de una evaluación válida. */
function guardarReparto(db: Db, preparacionId: number, c: Cargado): void {
  for (const l of c.evaluacion.lineasReparto) {
    const versionId = versionDeLinea(c.aux, l.tratamientoId, l.fecha);
    if (versionId === undefined) throw new ErrorSpd(`No se encuentra la versión de pauta de «${l.nombre}» el ${l.fecha}.`, 'ERROR_INTERNO');
    db.run(
      `INSERT INTO preparacion_linea(preparacion_id, tratamiento_id, pauta_version_id, envase_id, fecha, momento_id, unidades, verificado_lector)
       VALUES (?,?,?,?,?,?,?,0)`, [preparacionId, l.tratamientoId, versionId, l.envaseId, l.fecha, l.momentoId, l.unidades]);
  }
  for (const a of c.evaluacion.aparte) {
    db.run('INSERT INTO preparacion_aparte(preparacion_id, tratamiento_id, texto) VALUES (?,?,?)',
      [preparacionId, a.tratamientoId, c.aux.aparteTextos.get(a.tratamientoId) ?? a.nombre]);
  }
}

/** Evaluación para mostrar/imprimir una preparación guardada (en vivo si aún no está validada). */
function cargadoDe(ctx: Contexto, db: Db, prep: R, u: UsuarioPublico): Cargado {
  const estado = String(prep.estado);
  if (estado === 'borrador' || estado === 'preparado') {
    const lineas = estado === 'preparado' ? db.all<R>('SELECT DISTINCT envase_id FROM preparacion_linea WHERE preparacion_id = ?', [prep.id]) : [];
    return cargarEvaluacion(ctx, {
      pacienteId: Number(prep.paciente_id), desde: String(prep.fecha_inicio), dias: diasDe(prep),
      fechaPreparacion: estado === 'preparado' && prep.preparado_en ? fechaLocal(String(prep.preparado_en)) : hoyISO(ctx),
      diasValidez: Number(prep.validez_dias), justificacion: textoONull(prep.justificacion_validez) ?? undefined, rol: u.rol,
      ...(estado === 'preparado' ? { soloEnvases: new Set(lineas.map((l) => Number(l.envase_id))) } : {}),
    });
  }
  return cargarInstantanea(ctx, prep);
}

function quienDe(db: Db, prep: R): Quien {
  const u = (id: unknown) => (id == null ? null : db.get<R>('SELECT nombre, iniciales FROM usuario WHERE id = ?', [Number(id)]) ?? null);
  return { prep: u(prep.preparado_por), val: u(prep.validado_por) };
}

function idsCajas(c: Cargado): number[] {
  return [...new Set(c.evaluacion.lineasReparto.map((l) => l.envaseId))];
}

const claveLinea = (l: { tratamientoId: number; fecha: string; momentoId: number; envaseId: number; unidades: number }) =>
  `${l.tratamientoId}|${l.fecha}|${l.momentoId}|${l.envaseId}|${aCuartos(l.unidades)}`;

// ───────────────────────── fábrica ─────────────────────────

export function crearClinicaPreparacion(ctx: Contexto): MetodosPreparacion {
  return {
    // ── evaluar (no escribe nada) ──
    evaluarPreparacion: (params) => proteger(() => {
      const u = exigirSesion(ctx);
      const p = comprobarParams(params);
      return cargarEvaluacion(ctx, {
        pacienteId: p.pacienteId, desde: p.desde, dias: p.dias, fechaPreparacion: p.fechaPreparacion,
        diasValidez: p.diasValidez, justificacion: p.justificacion, rol: u.rol,
      }).evaluacion;
    }),

    // ── borrador ──
    crearPreparacion: (params) => proteger(() => {
      const u = exigirSesion(ctx);
      exigirPreparador(u);
      const p = comprobarParams(params);
      const cond = validarCondiciones(params);
      const db = bd(ctx);
      const c = cargarEvaluacion(ctx, {
        pacienteId: p.pacienteId, desde: p.desde, dias: p.dias, fechaPreparacion: p.fechaPreparacion,
        diasValidez: p.diasValidez, justificacion: p.justificacion, rol: u.rol,
      });
      const bloqueos = c.evaluacion.bloqueos.filter((b) => !BLOQUEOS_DE_VALIDACION.has(b.codigo));
      if (bloqueos.length > 0) throw new ErrorSpd(`No se puede guardar el borrador: ${textos(bloqueos)}`, 'BLOQUEOS');
      const cad = c.evaluacion.caducidadSpd;
      if (!cad?.ok || !cad.caducidadSpd || !c.evaluacion.finPeriodo) throw new ErrorSpd('No se puede guardar el borrador: no se ha podido calcular la caducidad del SPD.', 'BLOQUEOS');
      exigirSinSolape(db, p.pacienteId, 0, p.desde, c.evaluacion.finPeriodo);
      const diasValidez = c.aux.entrada!.diasValidez!;
      const id = db.transaccion(() => {
        const nuevo = db.run(
          `INSERT INTO preparacion(id_publico, paciente_id, fecha_inicio, fecha_fin, caducidad_spd, validez_dias, fuera_de_estandar, justificacion_validez, estado, temperatura, humedad, observaciones)
           VALUES (?,?,?,?,?,?,?,?, 'borrador', ?,?,?)`,
          [randomUUID(), p.pacienteId, p.desde, c.evaluacion.finPeriodo!, cad.caducidadSpd!, diasValidez, cad.fueraDeEstandar ? 1 : 0,
            cad.fueraDeEstandar ? (textoONull(p.justificacion) ?? null) : null, cond.temperatura, cond.humedad, cond.observaciones]).ultimoId;
        guardarReparto(db, nuevo, c);
        ctx.auditar({
          accion: 'crear', entidad: 'preparacion', entidadId: nuevo,
          despues: {
            estado: 'borrador', pacienteId: p.pacienteId, desde: p.desde, hasta: c.evaluacion.finPeriodo, fechaPreparacion: p.fechaPreparacion,
            caducidadSpd: cad.caducidadSpd, validezDias: diasValidez, fueraDeEstandar: cad.fueraDeEstandar,
            lineas: c.evaluacion.lineasReparto.length, aparte: c.evaluacion.aparte.length,
          },
          motivo: cad.fueraDeEstandar ? `Validez fuera de estándar (${diasValidez} días): ${textoONull(p.justificacion)}` : null,
        });
        return nuevo;
      });
      ctx.persistir();
      return dtoDe(db, id);
    }),

    marcarPreparada: (id) => proteger(() => {
      const u = exigirSesion(ctx);
      exigirPreparador(u);
      const db = bd(ctx);
      const prep = leerPrep(db, id);
      if (prep.estado !== 'borrador') throw new ErrorSpd(`Sólo se puede marcar como preparada una preparación en borrador (está «${prep.estado}»).`, 'ESTADO');
      // El SPD vale desde que SE PREPARA: se vuelve a calcular con la fecha de hoy y los datos actuales.
      const c = cargarEvaluacion(ctx, {
        pacienteId: Number(prep.paciente_id), desde: String(prep.fecha_inicio), dias: diasDe(prep), fechaPreparacion: hoyISO(ctx),
        diasValidez: Number(prep.validez_dias), justificacion: textoONull(prep.justificacion_validez) ?? undefined, rol: u.rol,
      });
      const bloqueos = c.evaluacion.bloqueos.filter((b) => !BLOQUEOS_DE_VALIDACION.has(b.codigo));
      if (bloqueos.length > 0) throw new ErrorSpd(`No se puede preparar: ${textos(bloqueos)}`, 'BLOQUEOS');
      const cad = c.evaluacion.caducidadSpd;
      if (!cad?.ok || !cad.caducidadSpd) throw new ErrorSpd('No se puede preparar: no se ha podido calcular la caducidad del SPD.', 'BLOQUEOS');
      exigirSinSolape(db, Number(prep.paciente_id), Number(prep.id), String(prep.fecha_inicio), String(prep.fecha_fin));
      db.transaccion(() => {
        db.run('DELETE FROM preparacion_linea WHERE preparacion_id = ?', [prep.id]);
        db.run('DELETE FROM preparacion_aparte WHERE preparacion_id = ?', [prep.id]);
        const r = db.run(
          `UPDATE preparacion SET estado = 'preparado', preparado_por = ?, preparado_en = ?, caducidad_spd = ?, fuera_de_estandar = ?
            WHERE id = ? AND estado = 'borrador'`,
          [u.id, ahoraISO(ctx), cad.caducidadSpd!, cad.fueraDeEstandar ? 1 : 0, prep.id]);
        if (r.cambios !== 1) throw new ErrorSpd('La preparación ha cambiado de estado mientras se marcaba: vuelve a abrirla.', 'ESTADO');
        guardarReparto(db, Number(prep.id), c);
        ctx.auditar({
          accion: 'preparar', entidad: 'preparacion', entidadId: Number(prep.id),
          antes: { estado: 'borrador', caducidadSpd: prep.caducidad_spd },
          despues: { estado: 'preparado', caducidadSpd: cad.caducidadSpd, lineas: c.evaluacion.lineasReparto.length, aparte: c.evaluacion.aparte.length },
        });
      });
      ctx.persistir();
      return dtoDe(db, Number(prep.id));
    }),

    // ── validar: re-evalúa, descuenta unidades, todo o nada ──
    validarPreparacion: (id) => proteger(() => {
      const u = exigirSesion(ctx);
      if (!puedeValidar(u.rol)) throw new ErrorSpd('Sólo un farmacéutico o el titular puede validar un SPD.', 'ROL_NO_PUEDE_VALIDAR');
      const db = bd(ctx);
      const prep = leerPrep(db, id);
      if (prep.estado !== 'preparado') throw new ErrorSpd(`Sólo se puede validar una preparación «preparado» (está «${prep.estado}»).`, 'ESTADO');
      const guardadas = db.all<R>('SELECT tratamiento_id, fecha, momento_id, envase_id, unidades FROM preparacion_linea WHERE preparacion_id = ?', [prep.id])
        .map((l) => ({ tratamientoId: Number(l.tratamiento_id), fecha: String(l.fecha), momentoId: Number(l.momento_id), envaseId: Number(l.envase_id), unidades: Number(l.unidades) }));

      // Datos ACTUALES, con las mismas cajas que se usaron al preparar y la fecha real de preparación.
      const c = cargarEvaluacion(ctx, {
        pacienteId: Number(prep.paciente_id), desde: String(prep.fecha_inicio), dias: diasDe(prep),
        fechaPreparacion: fechaLocal(String(prep.preparado_en)),
        diasValidez: Number(prep.validez_dias), justificacion: textoONull(prep.justificacion_validez) ?? undefined, rol: u.rol,
        soloEnvases: new Set(guardadas.map((l) => l.envaseId)),
      });
      if (c.evaluacion.bloqueos.length > 0) throw new ErrorSpd(`No se puede validar: ${textos(c.evaluacion.bloqueos)}`, 'BLOQUEOS');
      exigirSinSolape(db, Number(prep.paciente_id), Number(prep.id), String(prep.fecha_inicio), String(prep.fecha_fin));

      // Lo preparado tiene que ser exactamente lo que dicen hoy la pauta y las cajas.
      const nuevas = c.evaluacion.lineasReparto;
      const a = guardadas.map(claveLinea).sort();
      const b = nuevas.map(claveLinea).sort();
      const aparteGuardado = db.all<R>('SELECT tratamiento_id FROM preparacion_aparte WHERE preparacion_id = ? ORDER BY tratamiento_id', [prep.id]).map((x) => Number(x.tratamiento_id));
      const aparteActual = c.evaluacion.aparte.map((x) => x.tratamientoId).sort((x, y) => x - y);
      const distintas = a.length !== b.length || a.some((x, i) => x !== b[i]) || aparteGuardado.join(',') !== aparteActual.join(',')
        || c.evaluacion.caducidadSpd?.caducidadSpd !== String(prep.caducidad_spd);
      if (distintas) {
        throw new ErrorSpd('No se puede validar: la pauta, las cajas o la medicación aparte han cambiado desde que se preparó y el blíster ya no coincide con lo que toca. Anula la preparación y vuelve a prepararla.', 'PREPARACION_DESACTUALIZADA');
      }

      const mismoUsuario = prep.preparado_por != null && Number(prep.preparado_por) === u.id;
      const consumo = new Map<number, number>();
      for (const l of guardadas) consumo.set(l.envaseId, (consumo.get(l.envaseId) ?? 0) + aCuartos(l.unidades));

      db.transaccion(() => {
        const r = db.run(`UPDATE preparacion SET estado = 'validado', validado_por = ?, validado_en = ? WHERE id = ? AND estado = 'preparado'`, [u.id, ahoraISO(ctx), prep.id]);
        if (r.cambios !== 1) throw new ErrorSpd('La preparación ya no está pendiente de validar (¿la ha validado otra persona?).', 'ESTADO');
        const ids = [...consumo.keys()];
        const filas = db.all<R>(`${SQL_ENVASE_CON_MED} WHERE e.id IN (${marcadores(ids.length)})`, ids);
        const antes: Envase[] = filas.map((f) => envaseDeFila(f).dom);
        const despues = aplicarConsumo(antes, [...consumo].map(([envaseId, cuartos]) => ({ envaseId, unidades: cuartos / 4 })));
        for (const nuevo of despues) {
          const previo = antes.find((x) => x.id === nuevo.id)!;
          if (nuevo.unidadesRestantes === previo.unidadesRestantes) continue;
          const agotado = nuevo.estado === 'agotado';
          const ru = db.run(
            `UPDATE envase SET unidades_restantes = ?, estado = ?, cerrado_en = ?, motivo_cierre = ? WHERE id = ? AND unidades_restantes = ? AND estado = 'en_uso'`,
            [nuevo.unidadesRestantes, nuevo.estado, agotado ? ahoraISO(ctx) : null, agotado ? `Agotado al validar la preparación ${prep.id}` : null, nuevo.id, previo.unidadesRestantes]);
          if (ru.cambios !== 1) throw new ErrorSpd(`La caja ${nuevo.id} ha cambiado mientras se validaba: vuelve a intentarlo.`, 'ESTADO');
          ctx.auditar({
            accion: 'modificar', entidad: 'envase', entidadId: nuevo.id,
            antes: { unidadesRestantes: previo.unidadesRestantes, estado: previo.estado },
            despues: { unidadesRestantes: nuevo.unidadesRestantes, estado: nuevo.estado },
            motivo: `Consumo al validar la preparación ${prep.id}`,
          });
        }
        ctx.auditar({
          accion: 'validar', entidad: 'preparacion', entidadId: Number(prep.id),
          antes: { estado: 'preparado' },
          despues: { estado: 'validado', validadoPor: u.id, consumo: [...consumo].map(([envaseId, cuartos]) => ({ envaseId, unidades: cuartos / 4 })), caducidadSpd: prep.caducidad_spd },
          motivo: mismoUsuario ? 'validación por el mismo usuario que preparó' : null,
        });
      });
      ctx.persistir();
      return dtoDe(db, Number(prep.id));
    }),

    registrarEntrega: (id, e) => proteger(() => {
      const u = exigirSesion(ctx);
      const db = bd(ctx);
      const prep = leerPrep(db, id);
      if (prep.estado !== 'validado') throw new ErrorSpd(`Sólo se entrega una preparación validada (está «${prep.estado}»).`, 'ESTADO');
      if (!e || typeof e !== 'object') throw invalido('Faltan los datos de la entrega.');
      const entregadoA = typeof e.entregadoA === 'string' ? e.entregadoA.trim() : '';
      if (entregadoA === '') throw invalido('Indica a quién se entrega.');
      let contactoId: number | null = null;
      if (e.contactoId !== undefined && e.contactoId !== null) {
        const ct = db.get<R>('SELECT * FROM contacto WHERE id = ? AND paciente_id = ?', [e.contactoId, prep.paciente_id]);
        if (!ct) throw invalido('El contacto indicado no pertenece a este paciente.');
        if (ct.baja_en) throw invalido('El contacto indicado está dado de baja.');
        if (Number(ct.autorizado_recoger) !== 1 && ct.tipo !== 'representante_legal') {
          throw new ErrorSpd(`${ct.nombre} no figura como autorizado para recoger el SPD. Registra la autorización a terceros antes de entregar.`, 'NO_AUTORIZADO');
        }
        contactoId = Number(ct.id);
      }
      // Una alerta de calidad llegada después de validar frena también la entrega.
      const lineas = db.all<R>('SELECT DISTINCT envase_id FROM preparacion_linea WHERE preparacion_id = ?', [prep.id]);
      const alertas = alertasSobreCajas(db, lineas.map((l) => Number(l.envase_id)));
      if (alertas.length > 0) throw new ErrorSpd(`No se puede entregar: ${alertas.join(' ')} Rehaz el blíster o anula la preparación.`, 'ALERTA_CALIDAD');
      db.transaccion(() => {
        const r = db.run(`UPDATE preparacion SET estado = 'entregado' WHERE id = ? AND estado = 'validado'`, [prep.id]);
        if (r.cambios !== 1) throw new ErrorSpd('La preparación ya no está pendiente de entrega.', 'ESTADO');
        const nueva = db.run('INSERT INTO entrega(preparacion_id, entregado_a, contacto_id, entregado_por, entregado_en, observaciones) VALUES (?,?,?,?,?,?)',
          [prep.id, entregadoA, contactoId, u.id, ahoraISO(ctx), textoONull(e.observaciones)]).ultimoId;
        ctx.auditar({ accion: 'entregar', entidad: 'preparacion', entidadId: Number(prep.id), antes: { estado: 'validado' }, despues: { estado: 'entregado', entregaId: nueva, entregadoA, contactoId } });
      });
      ctx.persistir();
      return dtoDe(db, Number(prep.id));
    }),

    anularPreparacion: (id, motivo) => proteger(() => {
      const u = exigirSesion(ctx);
      exigirPreparador(u);
      const m = typeof motivo === 'string' ? motivo.trim() : '';
      if (m.length < 5) throw invalido('Indica el motivo de la anulación.');
      const db = bd(ctx);
      const prep = leerPrep(db, id);
      const estado = String(prep.estado);
      if (estado === 'anulado') throw new ErrorSpd('La preparación ya estaba anulada.', 'ESTADO');
      if ((estado === 'validado' || estado === 'entregado') && !puedeValidar(u.rol)) {
        throw new ErrorSpd('Sólo un farmacéutico o el titular puede anular una preparación ya validada.', 'PERMISO');
      }
      db.transaccion(() => {
        const nota: string[] = [];
        if (estado === 'validado') {
          const dev = new Map<number, number>();
          for (const l of db.all<R>('SELECT envase_id, unidades FROM preparacion_linea WHERE preparacion_id = ?', [prep.id])) {
            dev.set(Number(l.envase_id), (dev.get(Number(l.envase_id)) ?? 0) + aCuartos(Number(l.unidades)));
          }
          for (const [envaseId, cuartos] of dev) {
            const e = db.get<R>('SELECT id, unidades_inicio, unidades_restantes, estado, cerrado_en, motivo_cierre FROM envase WHERE id = ?', [envaseId]);
            if (!e) { nota.push(`la caja ${envaseId} ya no existe: sus unidades no se devuelven`); continue; }
            const nuevas = (aCuartos(Number(e.unidades_restantes)) + cuartos) / 4;
            if (aCuartos(nuevas) > aCuartos(Number(e.unidades_inicio))) {
              throw new ErrorSpd(`No se pueden devolver ${cuartos / 4} unidades a la caja ${envaseId}: superaría las ${e.unidades_inicio} con las que entró.`, 'INCONSISTENCIA');
            }
            const reabre = e.estado === 'agotado';
            db.run('UPDATE envase SET unidades_restantes = ?, estado = ?, cerrado_en = ?, motivo_cierre = ? WHERE id = ?',
              [nuevas, reabre ? 'en_uso' : e.estado, reabre ? null : (e.cerrado_en ?? null), reabre ? null : (e.motivo_cierre ?? null), envaseId]);
            ctx.auditar({
              accion: 'modificar', entidad: 'envase', entidadId: envaseId,
              antes: { unidadesRestantes: Number(e.unidades_restantes), estado: e.estado }, despues: { unidadesRestantes: nuevas, estado: reabre ? 'en_uso' : e.estado },
              motivo: `Devolución de unidades al anular la preparación ${prep.id}`,
            });
            if (e.estado !== 'en_uso' && !reabre) nota.push(`la caja ${envaseId} está «${e.estado}»: se le suman las unidades pero sigue cerrada`);
          }
          nota.unshift(`Anulada: unidades devueltas a las cajas (${dev.size})`);
        } else if (estado === 'entregado') {
          nota.push('Anulada tras la entrega: las unidades NO se devuelven a las cajas');
        }
        const observ = [prep.observaciones, nota.length > 0 ? `[${formatoFecha(hoyISO(ctx))}] ${nota.join('; ')}.` : null].filter(Boolean).join('\n');
        const r = db.run(`UPDATE preparacion SET estado = 'anulado', anulado_en = ?, motivo_anulacion = ?, observaciones = ? WHERE id = ? AND estado = ?`,
          [ahoraISO(ctx), m, observ === '' ? null : observ, prep.id, estado]);
        if (r.cambios !== 1) throw new ErrorSpd('La preparación ha cambiado de estado: vuelve a abrirla.', 'ESTADO');
        ctx.auditar({
          accion: 'anular', entidad: 'preparacion', entidadId: Number(prep.id), antes: { estado }, despues: { estado: 'anulado', unidadesDevueltas: estado === 'validado' },
          motivo: estado === 'entregado' ? `${m} (entregada: unidades NO devueltas)` : m,
        });
      });
      ctx.persistir();
      return dtoDe(db, Number(prep.id));
    }),

    // ── consultas ──
    listarPreparaciones: (filtro) => proteger(() => {
      exigirSesion(ctx);
      const db = bd(ctx);
      const donde: string[] = [];
      const par: (string | number)[] = [];
      if (filtro?.pacienteId !== undefined) { donde.push('p.paciente_id = ?'); par.push(filtro.pacienteId); }
      if (filtro?.estado !== undefined && filtro.estado !== 'todas') {
        if (!ESTADOS.includes(filtro.estado)) throw invalido('El estado indicado no es válido.');
        donde.push('p.estado = ?'); par.push(filtro.estado);
      }
      return db.all<R>(`${SQL_PREP} ${donde.length ? 'WHERE ' + donde.join(' AND ') : ''} ORDER BY p.fecha_inicio DESC, p.id DESC`, par).map(aDto);
    }),

    obtenerPreparacion: (id) => proteger(() => {
      const u = exigirSesion(ctx);
      const db = bd(ctx);
      const prep = leerPrep(db, id);
      const c = cargadoDe(ctx, db, prep, u);
      ctx.auditar({ accion: 'ver', entidad: 'preparacion', entidadId: Number(prep.id) });
      return { preparacion: aDto(prep), evaluacion: c.evaluacion };
    }),

    vistaEtiqueta: (id) => proteger((): VistaImprimible => {
      const u = exigirSesion(ctx);
      const db = bd(ctx);
      const prep = leerPrep(db, id);
      const c = cargadoDe(ctx, db, prep, u);
      ctx.auditar({ accion: 'ver', entidad: 'preparacion', entidadId: Number(prep.id), motivo: 'vista de la etiqueta' });
      return etiquetaHtml(prep, c, quienDe(db, prep), alertasSobreCajas(db, idsCajas(c)));
    }),

    vistaHojaPaciente: (id) => proteger((): VistaImprimible => {
      const u = exigirSesion(ctx);
      const db = bd(ctx);
      const prep = leerPrep(db, id);
      const c = cargadoDe(ctx, db, prep, u);
      ctx.auditar({ accion: 'ver', entidad: 'preparacion', entidadId: Number(prep.id), motivo: 'vista de la hoja del paciente' });
      return hojaHtml(prep, c, quienDe(db, prep), alertasSobreCajas(db, idsCajas(c)));
    }),

    // ── documentos y consentimientos ──
    listarPlantillasDocumento: () => proteger(() => docs.listarPlantillas(ctx)),
    vistaDocumento: (codigo, pacienteId, firmante) => proteger(() => docs.vistaDocumento(ctx, codigo, pacienteId, firmante)),
    registrarDocumentoFirmado: (codigo, pacienteId, firmante) => proteger(() => docs.registrarFirmado(ctx, codigo, pacienteId, firmante)),
    revocarDocumento: (id, motivo) => proteger(() => docs.revocar(ctx, id, motivo)),
    estadoConsentimientos: (pacienteId) => proteger(() => docs.estadoConsentimientosDto(ctx, pacienteId)),
  };
}
