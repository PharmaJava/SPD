/**
 * Tratamientos (qué toma el paciente) y sus pautas versionadas (cómo lo toma).
 * El historial de pautas NO se edita: cada cambio es una versión nueva.
 */
import type { Contexto } from '../contexto.ts';
import { proteger } from '../contexto.ts';
import type { Resultado, TratamientoDto, PautaDto } from '../api.ts';
import type { Db } from '../db.ts';
import { avisosPauta, pautaVigenteEn, validarPauta } from '../../dominio/calendario-pauta.ts';
import { normalizarCN } from '../../dominio/gs1.ts';
import { ahoraISO, bd, boolDb, esFechaIso, exigirSesion, formatoFecha, hoyISO, invalido, noEncontrado, sumarDias, texto, textoObligatorio } from './comun.ts';
import type { R } from './comun.ts';
import { cargarMomentos, cargarPautas, pautaADominio, textoPauta } from './pautas.ts';
import { coberturaDeTratamientos } from './cobertura.ts';
import { leerMedicamento } from './medicamentos.ts';

/** TratamientoDto + los avisos de seguridad de la pauta vigente (el contrato aún no los declara). */
export type TratamientoConAvisos = TratamientoDto & { avisos: string[] };

const ORIGENES = ['receta', 'informe_medico', 'comunicacion_medico', 'paciente', 'revision_farmaceutica', 'correccion'];
const PATRONES = ['diario', 'dias_semana', 'cada_n_dias', 'ciclo', 'si_precisa'];

function construir(db: Db, hoy: string, filas: R[]): TratamientoConAvisos[] {
  if (filas.length === 0) return [];
  const ids = filas.map((f) => f.id as number);
  const pautas = cargarPautas(db, ids);
  const momentos = cargarMomentos(db);
  const cobertura = coberturaDeTratamientos(db, hoy, filas.filter((f) => f.emblistable && !f.finalizado_en).map((f) => f.id as number));
  return filas.map((f): TratamientoConAvisos => {
    const dtos: PautaDto[] = pautas.get(f.id) ?? [];
    const dominio = dtos.map(pautaADominio);
    const vigente = dominio.length > 0 ? pautaVigenteEn(dominio, hoy) : null;
    let texto: string;
    let avisos: string[] = [];
    if (f.finalizado_en) texto = 'Finalizado';
    else if (dtos.length === 0) texto = 'Sin pauta';
    else if (!vigente) {
      const futura = dominio.filter((p) => p.vigenteDesde > hoy).map((p) => p.vigenteDesde).sort()[0];
      texto = futura ? `Sin pauta vigente (la siguiente empieza el ${formatoFecha(futura)})` : 'Sin pauta vigente';
    } else {
      texto = textoPauta(dtos[dominio.indexOf(vigente)], momentos);
      avisos = avisosPauta(vigente, f.principio_activo);
    }
    const c = cobertura.get(f.id);
    return {
      id: f.id, pacienteId: f.paciente_id, principioActivo: f.principio_activo, dosisTexto: f.dosis_texto ?? null,
      cnPreferente: f.cn_preferente ?? null, indicacion: f.indicacion ?? null, emblistable: !!f.emblistable,
      motivoNoEmblistable: f.motivo_no_emblistable ?? null, notaFarmaceutico: f.nota_farmaceutico ?? null,
      creadoEn: f.creado_en, finalizadoEn: f.finalizado_en ?? null, motivoFin: f.motivo_fin ?? null,
      pautas: dtos, pautaVigenteTexto: texto,
      coberturaDias: f.emblistable && !f.finalizado_en && c ? (c.cajas === 0 && vigente ? 0 : c.dias) : null,
      medicamento: f.cn_preferente ? leerMedicamento(db, f.cn_preferente) : null,
      avisos,
    };
  });
}

function leerTratamiento(ctx: Contexto, db: Db, id: number): TratamientoConAvisos {
  const f = db.get<R>('SELECT * FROM tratamiento WHERE id = ?', [id]);
  if (!f) throw noEncontrado('Tratamiento no encontrado.');
  return construir(db, hoyISO(ctx), [f])[0];
}

function exigirPacienteActivable(db: Db, id: unknown): R {
  if (typeof id !== 'number' || !Number.isInteger(id)) throw invalido('Paciente no válido.');
  const p = db.get<R>('SELECT id, estado FROM paciente WHERE id = ?', [id]);
  if (!p) throw noEncontrado('Paciente no encontrado.');
  return p;
}

export function listarTratamientos(ctx: Contexto, pacienteId: number, incluirFinalizados = false): Promise<Resultado<TratamientoDto[]>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    exigirPacienteActivable(db, pacienteId);
    const filas = db.all<R>(
      `SELECT * FROM tratamiento WHERE paciente_id = ? ${incluirFinalizados ? '' : 'AND finalizado_en IS NULL'}
        ORDER BY (finalizado_en IS NOT NULL), id`, [pacienteId]);
    return construir(db, hoyISO(ctx), filas);
  });
}

type EntradaTratamiento = { id?: number; pacienteId: number; principioActivo: string; dosisTexto?: string; cnPreferente?: string; indicacion?: string; emblistable: boolean; motivoNoEmblistable?: string; notaFarmaceutico?: string };

export function guardarTratamiento(ctx: Contexto, t: EntradaTratamiento): Promise<Resultado<TratamientoDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      if (!t || typeof t !== 'object') throw invalido('Faltan los datos del tratamiento.');
      const paciente = exigirPacienteActivable(db, t.pacienteId);
      const principio = textoObligatorio(t.principioActivo, 'el principio activo', 200);
      const emblistable = t.emblistable === true;
      if (typeof t.emblistable !== 'boolean') throw invalido('Indica si el tratamiento es emblistable.');
      const motivoNo = texto(t.motivoNoEmblistable, 'motivo de no emblistable', 300);
      if (!emblistable && !motivoNo) throw invalido('Si el tratamiento no es emblistable hay que indicar el motivo.');
      let cn: string | null = null;
      if (t.cnPreferente !== undefined && t.cnPreferente !== null && String(t.cnPreferente).trim() !== '') {
        cn = normalizarCN(String(t.cnPreferente));
        if (!cn) throw invalido('El CN preferente no es válido (6 dígitos).');
        const med = leerMedicamento(db, cn);
        if (!med) throw invalido(`El CN ${cn} no está en el catálogo local: consúltalo en CIMA o dalo de alta antes.`);
        if (emblistable && med.spdAptitud === 'no_apto') {
          throw invalido(`${med.nombre} figura como NO APTO para SPD (${med.spdMotivo ?? 'sin motivo'}). Márcalo como no emblistable indicando el motivo o, si un farmacéutico decide lo contrario, fija su aptitud en la ficha del medicamento.`);
        }
      }
      const vals = [principio, texto(t.dosisTexto, 'dosis', 100), cn, texto(t.indicacion, 'indicación', 300), boolDb(emblistable),
        emblistable ? null : motivoNo, texto(t.notaFarmaceutico, 'nota del farmacéutico', 1000)];
      if (t.id !== undefined && t.id !== null) {
        const antes = leerTratamiento(ctx, db, t.id);
        if (antes.pacienteId !== t.pacienteId) throw invalido('Ese tratamiento pertenece a otro paciente.');
        if (antes.finalizadoEn) throw invalido('El tratamiento está finalizado: no se puede modificar.');
        db.run('UPDATE tratamiento SET principio_activo=?, dosis_texto=?, cn_preferente=?, indicacion=?, emblistable=?, motivo_no_emblistable=?, nota_farmaceutico=? WHERE id=?', [...vals, t.id]);
        const despues = leerTratamiento(ctx, db, t.id);
        ctx.auditar({ accion: 'modificar', entidad: 'tratamiento', entidadId: t.id, antes: tratamientoParaAuditoria(antes), despues: tratamientoParaAuditoria(despues) });
        return despues;
      }
      if (paciente.estado === 'baja' || paciente.estado === 'fallecido') throw invalido(`El paciente está en estado «${paciente.estado}»: no se pueden añadir tratamientos.`);
      const id = db.run(
        'INSERT INTO tratamiento(paciente_id,principio_activo,dosis_texto,cn_preferente,indicacion,emblistable,motivo_no_emblistable,nota_farmaceutico,creado_en) VALUES (?,?,?,?,?,?,?,?,?)',
        [t.pacienteId, ...vals, ahoraISO(ctx)]).ultimoId;
      const creado = leerTratamiento(ctx, db, id);
      ctx.auditar({ accion: 'crear', entidad: 'tratamiento', entidadId: id, despues: tratamientoParaAuditoria(creado) });
      return creado;
    });
    ctx.persistir();
    return dto;
  });
}

/** Lo que se guarda en la auditoría: sin el historial completo de pautas (ya tiene sus propias entradas). */
function tratamientoParaAuditoria(t: TratamientoDto): unknown {
  const { pautas: _p, medicamento: _m, ...resto } = t as TratamientoConAvisos;
  return resto;
}

export function guardarPauta(ctx: Contexto, tratamientoId: number, pauta: PautaDto): Promise<Resultado<TratamientoDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const u = ctx.sesion()!;
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      if (!pauta || typeof pauta !== 'object') throw invalido('Faltan los datos de la pauta.');
      const trat = db.get<R>('SELECT * FROM tratamiento WHERE id = ?', [tratamientoId]);
      if (!trat) throw noEncontrado('Tratamiento no encontrado.');
      if (trat.finalizado_en) throw invalido('El tratamiento está finalizado: no se pueden añadir pautas.');
      if (!PATRONES.includes(pauta.patron)) throw invalido('Patrón de pauta no válido.');
      if (!ORIGENES.includes(pauta.origen)) throw invalido('Indica el origen de la pauta (receta, informe médico, comunicación con el médico…).');
      if (!esFechaIso(pauta.vigenteDesde)) throw invalido('La fecha de inicio de la pauta no es válida (AAAA-MM-DD).');
      const dominio = pautaADominio(pauta);
      const errores = validarPauta(dominio);
      if (errores.length > 0) throw invalido(`Pauta no válida: ${errores.join('; ')}.`);
      const momentos = new Map(cargarMomentos(db).map((m) => [m.id, m]));
      const activos = new Set(db.all<R>('SELECT id FROM momento_toma WHERE activo = 1').map((r) => r.id as number));
      for (const d of pauta.dosis) {
        if (!momentos.has(d.momentoId)) throw invalido(`El momento de toma ${d.momentoId} no existe.`);
        if (!activos.has(d.momentoId)) throw invalido(`El momento «${momentos.get(d.momentoId)!.nombre}» está desactivado.`);
      }
      const previas = db.all<R>('SELECT id, version, vigente_desde, vigente_hasta FROM pauta_version WHERE tratamiento_id = ? ORDER BY version', [tratamientoId]);
      const posterior = previas.find((v) => v.vigente_desde >= pauta.vigenteDesde);
      if (posterior) {
        throw invalido(`Ya existe una versión de la pauta que empieza el ${formatoFecha(posterior.vigente_desde)}: la nueva debe empezar después de esa fecha.`);
      }
      const version = previas.length === 0 ? 1 : Math.max(...previas.map((v) => v.version as number)) + 1;
      const diaAnterior = sumarDias(pauta.vigenteDesde, -1);
      // Se cierran las versiones anteriores que se solapan: sólo cambia su «vigente_hasta»; patrón y dosis no se tocan.
      for (const v of previas) {
        if (v.vigente_hasta === null || v.vigente_hasta > diaAnterior) {
          db.run('UPDATE pauta_version SET vigente_hasta = ? WHERE id = ?', [diaAnterior, v.id]);
          ctx.auditar({ accion: 'modificar', entidad: 'pauta_version', entidadId: v.id, antes: { vigenteHasta: v.vigente_hasta }, despues: { vigenteHasta: diaAnterior }, motivo: `Sustituida por la versión ${version}` });
        }
      }
      const diasSemana = pauta.patron === 'dias_semana' && pauta.diasSemana ? [...new Set(pauta.diasSemana)].sort((a, b) => a - b).join(',') : null;
      const idVersion = db.run(
        `INSERT INTO pauta_version(tratamiento_id,version,vigente_desde,vigente_hasta,patron,dias_semana,cada_n_dias,ciclo_on,ciclo_off,fecha_ancla,instrucciones,origen,origen_detalle,creado_por,creado_en)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tratamientoId, version, pauta.vigenteDesde, pauta.vigenteHasta ?? null, pauta.patron, diasSemana,
          pauta.patron === 'cada_n_dias' ? pauta.cadaNDias ?? null : null,
          pauta.patron === 'ciclo' ? pauta.cicloOn ?? null : null, pauta.patron === 'ciclo' ? pauta.cicloOff ?? null : null,
          pauta.fechaAncla ?? null, texto(pauta.instrucciones, 'instrucciones', 500), pauta.origen, texto(pauta.origenDetalle, 'detalle del origen', 500),
          u.id, ahoraISO(ctx)]).ultimoId;
      for (const d of pauta.dosis) db.run('INSERT INTO pauta_dosis(pauta_version_id,momento_id,unidades) VALUES (?,?,?)', [idVersion, d.momentoId, d.unidades]);
      ctx.auditar({ accion: 'crear', entidad: 'pauta_version', entidadId: idVersion, despues: { tratamientoId, version, ...pauta, id: idVersion }, motivo: texto(pauta.origenDetalle, 'detalle', 500) });

      const resultado = leerTratamiento(ctx, db, tratamientoId);
      // docs/04 §4.6: los blísteres ya preparados que cubren fechas afectadas se dicen, no se tocan en silencio.
      const afectados = db.all<R>(
        `SELECT id_publico, estado, fecha_inicio, fecha_fin FROM preparacion p
          WHERE p.paciente_id = ? AND p.estado IN ('preparado','validado','entregado') AND p.fecha_fin >= ?
            AND EXISTS (SELECT 1 FROM preparacion_linea l WHERE l.preparacion_id = p.id AND l.tratamiento_id = ?)`,
        [trat.paciente_id, pauta.vigenteDesde, tratamientoId]);
      for (const a of afectados) {
        resultado.avisos.push(`El blíster ${String(a.id_publico).slice(0, 8)} (${a.estado}), del ${formatoFecha(a.fecha_inicio)} al ${formatoFecha(a.fecha_fin)}, contiene la pauta anterior en las fechas afectadas: rehazlo o da instrucciones al paciente.`);
      }
      return resultado;
    });
    ctx.persistir();
    return dto;
  });
}

export function finalizarTratamiento(ctx: Contexto, id: number, motivo: string): Promise<Resultado<TratamientoDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      const antes = leerTratamiento(ctx, db, id);
      const m = textoObligatorio(motivo, 'el motivo', 500);
      if (antes.finalizadoEn) throw invalido('El tratamiento ya está finalizado.');
      db.run('UPDATE tratamiento SET finalizado_en = ?, motivo_fin = ? WHERE id = ?', [ahoraISO(ctx), m, id]);
      const despues = leerTratamiento(ctx, db, id);
      ctx.auditar({ accion: 'finalizar', entidad: 'tratamiento', entidadId: id, antes: tratamientoParaAuditoria(antes), despues: tratamientoParaAuditoria(despues), motivo: m });
      return despues;
    });
    ctx.persistir();
    return dto;
  });
}
