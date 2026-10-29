/**
 * Envases (cajas custodiadas), entrada con controles y alertas de calidad.
 *
 * Toda la medicación que entra en un SPD la ha dispensado la farmacia (decisión
 * de Antonio, 28-oct-2026): no existe campo de procedencia ni camino para
 * registrar cajas que traiga el paciente.
 */
import type { Contexto } from '../contexto.ts';
import { ErrorSpd, proteger } from '../contexto.ts';
import type { Resultado, EnvaseDto, EntradaEnvaseParams, ResultadoEntradaEnvase } from '../api.ts';
import type { Db } from '../db.ts';
import { normalizarCN, parsearGS1 } from '../../dominio/gs1.ts';
import { DIAS_AVISO_CADUCIDAD_POR_DEFECTO, validarEntradaEnvase } from '../../dominio/entrada-envase.ts';
import type { Aviso, ContextoEntrada, EnvaseExistente } from '../../dominio/entrada-envase.ts';
import { trazabilidadInversa } from '../../dominio/alertas-calidad.ts';
import type { AlertaCalidad, TrazabilidadAlerta } from '../../dominio/alertas-calidad.ts';
import type { Envase } from '../../dominio/tipos.ts';
import { normalizar } from '../../dominio/aptitud-spd.ts';
import { ahoraISO, bd, diasEntre, esFechaIso, exigirSesion, hoyISO, invalido, noEncontrado, texto, textoObligatorio, urlHttp } from './comun.ts';
import type { R } from './comun.ts';
import { leerMedicamento, nombresPrincipios } from './medicamentos.ts';

export function envaseDto(r: R, hoy: string): EnvaseDto {
  const dias = diasEntre(hoy, r.caducidad);
  return {
    caducada: r.caducidad < hoy, caducaPronto: r.caducidad >= hoy && dias <= DIAS_AVISO_CADUCIDAD_POR_DEFECTO,
    id: r.id, pacienteId: r.paciente_id, tratamientoId: r.tratamiento_id ?? null, cn: r.cn, medicamentoNombre: r.medicamento_nombre ?? '',
    lote: r.lote, caducidad: r.caducidad, numeroSerie: r.numero_serie ?? null, origenLectura: r.origen_lectura,
    unidadesInicio: r.unidades_inicio, unidadesRestantes: r.unidades_restantes, estado: r.estado, recibidoEn: r.recibido_en,
  };
}

const SQL_ENVASE = 'SELECT e.*, m.nombre AS medicamento_nombre FROM envase e LEFT JOIN medicamento m ON m.cn = e.cn';

function leerEnvase(db: Db, id: number, hoy: string): EnvaseDto | null {
  const r = db.get<R>(`${SQL_ENVASE} WHERE e.id = ?`, [id]);
  return r ? envaseDto(r, hoy) : null;
}

export function listarEnvases(ctx: Contexto, pacienteId: number, incluirCerrados = false): Promise<Resultado<EnvaseDto[]>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    if (typeof pacienteId !== 'number' || !db.get('SELECT 1 FROM paciente WHERE id = ?', [pacienteId])) throw noEncontrado('Paciente no encontrado.');
    return db.all<R>(`${SQL_ENVASE} WHERE e.paciente_id = ? ${incluirCerrados ? '' : "AND e.estado = 'en_uso'"} ORDER BY e.caducidad, e.id`, [pacienteId]).map((r) => envaseDto(r, hoyISO(ctx)));
  });
}

// ───────────────────── Asociación a la línea de tratamiento ─────────────────────

/** Quita la dosis y deja el principio activo en minúsculas sin tildes: «Metformina 850 mg» → «metformina». */
function clavePrincipio(s: string): string {
  return normalizar(s).replace(/\d[\d.,]*\s*(mg|g|mcg|µg|ug|ui|ml|%).*$/, '').trim();
}

function coincidePrincipio(tratamientoPA: string, nombresMed: string[], nombreMed: string): boolean {
  const t = clavePrincipio(tratamientoPA);
  if (!t) return false;
  if (nombresMed.length === 1) {
    const n = clavePrincipio(nombresMed[0]);
    return n === t || n.startsWith(t + ' ') || t.startsWith(n + ' ');
  }
  if (nombresMed.length === 0) {
    // Sin principio activo en el catálogo: sólo si el nombre empieza por él (genéricos: «Metformina Cinfa 850 mg»).
    const n = normalizar(nombreMed);
    return t.length >= 5 && (n === t || n.startsWith(t + ' '));
  }
  return false;   // combinación: sólo por CN preferente; nunca por un componente
}

interface Asociacion { tratamientoId: number | null; info: Aviso[]; bloqueos?: Aviso[] }

function resolverTratamiento(db: Db, pacienteId: number, cn: string | null, tratamientoIdPedido: number | null | undefined): Asociacion {
  if (tratamientoIdPedido !== undefined && tratamientoIdPedido !== null) {
    const t = db.get<R>('SELECT id, paciente_id, finalizado_en, principio_activo FROM tratamiento WHERE id = ?', [tratamientoIdPedido]);
    if (!t) throw invalido('El tratamiento indicado no existe.');
    if (t.paciente_id !== pacienteId) throw invalido('El tratamiento indicado pertenece a otro paciente.');
    if (t.finalizado_en) throw invalido('El tratamiento indicado está finalizado.');
    if (cn) {
      const m = db.get<R>('SELECT nombre, principios_activos FROM medicamento WHERE cn = ?', [cn]);
      const t2 = db.get<R>('SELECT cn_preferente FROM tratamiento WHERE id = ?', [t.id])!;
      if (m && t2.cn_preferente !== cn && !coincidePrincipio(t.principio_activo, nombresPrincipios(m.principios_activos), m.nombre)) {
        return { tratamientoId: null, info: [], bloqueos: [{ codigo: 'TRATAMIENTO_NO_COINCIDE', texto: `${m.nombre} (CN ${cn}) no corresponde al tratamiento de ${t.principio_activo}: no se asigna esta caja a esa línea.` }] };
      }
    }
    return { tratamientoId: t.id, info: [{ codigo: 'TRATAMIENTO_ASOCIADO', texto: `Asociada al tratamiento de ${t.principio_activo}.` }] };
  }
  if (!cn) return { tratamientoId: null, info: [] };
  const med = db.get<R>('SELECT nombre, principios_activos FROM medicamento WHERE cn = ?', [cn]);
  const candidatos = db.all<R>("SELECT id, principio_activo, cn_preferente FROM tratamiento WHERE paciente_id = ? AND finalizado_en IS NULL AND emblistable = 1 ORDER BY id", [pacienteId])
    .filter((t) => t.cn_preferente === cn || (med && coincidePrincipio(t.principio_activo, nombresPrincipios(med.principios_activos), med.nombre)));
  if (candidatos.length === 1) {
    return { tratamientoId: candidatos[0].id, info: [{ codigo: 'TRATAMIENTO_ASOCIADO', texto: `Asociada al tratamiento de ${candidatos[0].principio_activo}.` }] };
  }
  if (candidatos.length === 0) {
    return { tratamientoId: null, info: [{ codigo: 'TRATAMIENTO_NO_ASOCIADO', texto: 'No hay un tratamiento emblistable de este paciente que coincida con el principio activo: la caja se guarda sin asociar. Asígnala a su línea antes de preparar.' }] };
  }
  return { tratamientoId: null, info: [{ codigo: 'TRATAMIENTO_AMBIGUO', texto: `Hay ${candidatos.length} tratamientos del paciente que podrían corresponder (${candidatos.map((c) => c.principio_activo).join(', ')}): la caja se guarda sin asociar y no se adivina. Asígnala a mano.` }] };
}

// ───────────────────────────── Entrada ─────────────────────────────

interface Evaluacion {
  resultado: ResultadoEntradaEnvase;
  asociacion: Asociacion;
  gtin: string | null;
  crudo: string | null;
}

function evaluarEntrada(ctx: Contexto, db: Db, e: EntradaEnvaseParams): Evaluacion {
  if (!e || typeof e !== 'object') throw invalido('Faltan los datos del envase.');
  const pac = typeof e.pacienteId === 'number' ? db.get<R>('SELECT id, estado FROM paciente WHERE id = ?', [e.pacienteId]) : undefined;
  if (!pac) throw noEncontrado('Paciente no encontrado.');
  if (pac.estado === 'baja' || pac.estado === 'fallecido') throw invalido(`El paciente está en estado «${pac.estado}»: no se pueden registrar cajas.`);
  const hoy = hoyISO(ctx);

  const lectura = typeof e.lecturaDatamatrix === 'string' && e.lecturaDatamatrix.trim() !== '' ? e.lecturaDatamatrix : null;
  const parsed = lectura ? parsearGS1(lectura, { hoy: new Date(hoy + 'T00:00:00Z') }) : null;
  const cnCodigo = parsed && parsed.gtin !== undefined && !parsed.ambiguo ? parsed.cn ?? null : null;
  const cnTeclado = typeof e.cn === 'string' && e.cn.trim() !== '' ? normalizarCN(e.cn) : null;
  const cnCandidato = cnCodigo ?? cnTeclado;

  const asociacion = resolverTratamiento(db, e.pacienteId, cnCandidato, e.tratamientoId);
  let cnUltimo: string | undefined;
  if (asociacion.tratamientoId !== null) {
    cnUltimo = db.get<R>('SELECT cn FROM envase WHERE tratamiento_id = ? ORDER BY id DESC LIMIT 1', [asociacion.tratamientoId])?.cn ?? undefined;
  }
  const cns = [...new Set([cnCodigo, cnTeclado].filter((x): x is string => !!x))];
  const existentes: EnvaseExistente[] = cns.length === 0 ? [] : db.all<R>(
    `SELECT cn, numero_serie, lote, estado FROM envase WHERE cn IN (${cns.map(() => '?').join(',')})`, cns)
    .map((r) => ({ cn: r.cn, ...(r.numero_serie ? { numeroSerie: r.numero_serie } : {}), lote: r.lote, estado: r.estado }));
  const conocidos = new Set<string>(cns.length === 0 ? [] : db.all<R>(`SELECT cn FROM medicamento WHERE cn IN (${cns.map(() => '?').join(',')})`, cns).map((r) => r.cn as string));
  const alertas = db.all<R>('SELECT referencia, cn, lote FROM alerta_calidad').map((r) => ({
    referencia: r.referencia, ...(r.cn ? { cn: r.cn } : {}), ...(r.lote ? { lote: r.lote } : {}),
  }));
  const contexto: ContextoEntrada = {
    envasesExistentes: existentes, cnConocidos: conocidos, alertasCalidad: alertas,
    ...(cnUltimo ? { cnUltimoDeLaLinea: cnUltimo } : {}),
  };
  const fin = (e as { finPrevistoPeriodo?: unknown }).finPrevistoPeriodo;
  if (typeof fin === 'string' && esFechaIso(fin)) contexto.finPrevistoPeriodo = fin;

  // Unidades: si faltan, las del medicamento (nunca se inventan: sin dato, bloquea).
  const info: Aviso[] = [...asociacion.info];
  let unidades = e.unidades;
  const medCandidato = cnCandidato ? leerMedicamento(db, cnCandidato) : null;
  if ((unidades === undefined || unidades === null) && medCandidato?.unidadesEnvase) {
    unidades = medCandidato.unidadesEnvase;
    info.push({ codigo: 'UNIDADES_POR_DEFECTO', texto: `Se han puesto las unidades del envase según el catálogo (${unidades}). Compruébalas con la caja.` });
  }

  const r = validarEntradaEnvase({
    cn: e.cn ?? '', ...(e.lote !== undefined ? { lote: e.lote } : {}), ...(e.caducidad !== undefined ? { caducidad: e.caducidad } : {}),
    ...(e.numeroSerie !== undefined ? { numeroSerie: e.numeroSerie } : {}), ...(lectura ? { lecturaDatamatrix: lectura } : {}),
    unidades: unidades as number, hoy,
  }, contexto);

  const bloqueos = [...r.bloqueos, ...(asociacion.bloqueos ?? [])];
  let atencion = [...r.atencion];
  const cnFinal = r.envaseNormalizado?.cn ?? cnCandidato;
  const med = cnFinal ? leerMedicamento(db, cnFinal) : null;
  if (cnFinal && !med) {
    // El envase referencia al catálogo: sin ficha local no se puede guardar.
    atencion = atencion.filter((a) => a.codigo !== 'CN_DESCONOCIDO');
    bloqueos.push({ codigo: 'CN_NO_EN_CATALOGO', texto: `El CN ${cnFinal} no está en el catálogo local: consúltalo en CIMA o dalo de alta antes de registrar la caja.` });
  }
  if (med) {
    if (med.descripcionEstado !== 'confirmada') {
      atencion.push({ codigo: 'DESCRIPCION_SIN_CONFIRMAR', texto: `Falta confirmar la descripción física de ${med.nombre}: un farmacéutico debe hacerlo antes de preparar con esta caja.` });
    }
    if (med.spdAptitud === 'no_apto') atencion.push({ codigo: 'MEDICAMENTO_NO_APTO_SPD', texto: `${med.nombre} figura como NO APTO para SPD: ${med.spdMotivo ?? 'sin motivo'}.` });
    else if (med.spdAptitud === 'precaucion') info.push({ codigo: 'MEDICAMENTO_PRECAUCION_SPD', texto: `${med.nombre}: precaución para SPD. ${med.spdMotivo ?? ''}`.trim() });
  }
  const ok = bloqueos.length === 0;
  const resultado: ResultadoEntradaEnvase = {
    ok, bloqueos, atencion, info: [...r.info, ...info],
    ...(ok && r.envaseNormalizado ? { normalizado: r.envaseNormalizado } : {}),
    ...(med ? { medicamentoNombre: med.nombre } : {}),
  };
  return { resultado, asociacion, gtin: parsed && parsed.gtin !== undefined && !parsed.ambiguo ? parsed.gtin : null, crudo: lectura };
}

export function comprobarEntradaEnvase(ctx: Contexto, e: EntradaEnvaseParams): Promise<Resultado<ResultadoEntradaEnvase>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    return evaluarEntrada(ctx, db, e).resultado;
  });
}

export function registrarEnvase(ctx: Contexto, e: EntradaEnvaseParams): Promise<Resultado<ResultadoEntradaEnvase>> {
  return proteger(() => {
    const u = exigirSesion(ctx);
    const db = bd(ctx);
    const res = db.transaccion(() => {
      const ev = evaluarEntrada(ctx, db, e);
      const n = ev.resultado.normalizado;
      if (!ev.resultado.ok || !n) return ev.resultado;
      let id: number;
      try {
        id = db.run(
          `INSERT INTO envase(paciente_id,tratamiento_id,cn,gtin,lote,caducidad,numero_serie,datamatrix_crudo,origen_lectura,unidades_inicio,unidades_restantes,recibido_en,recibido_por,estado)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'en_uso')`,
          [e.pacienteId, ev.asociacion.tratamientoId, n.cn, ev.gtin, n.lote, n.caducidad, n.numeroSerie ?? null,
            n.origenLectura === 'datamatrix' ? ev.crudo : null, n.origenLectura, n.unidades, n.unidades, ahoraISO(ctx), u.id]).ultimoId;
      } catch (err) {
        if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new ErrorSpd('Ese nº de serie ya está registrado para este CN: caja duplicada.', 'DUPLICADO');
        throw err;
      }
      const dto = leerEnvase(db, id, hoyISO(ctx))!;
      ctx.auditar({ accion: 'crear', entidad: 'envase', entidadId: id, despues: dto });
      return { ...ev.resultado, envaseId: id };
    });
    if (res.envaseId !== undefined) ctx.persistir();
    return res;
  });
}

export function cerrarEnvase(ctx: Contexto, id: number, estado: 'devuelto' | 'retirado' | 'desechado', motivo: string): Promise<Resultado<EnvaseDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      const antes = typeof id === 'number' ? leerEnvase(db, id, hoyISO(ctx)) : null;
      if (!antes) throw noEncontrado('Envase no encontrado.');
      if (!['devuelto', 'retirado', 'desechado'].includes(estado)) throw invalido('Estado no válido: devuelto, retirado o desechado.');
      const m = textoObligatorio(motivo, 'el motivo', 500);
      if (antes.estado !== 'en_uso') throw invalido(`El envase ya está cerrado (${antes.estado}).`);
      db.run('UPDATE envase SET estado = ?, cerrado_en = ?, motivo_cierre = ? WHERE id = ?', [estado, ahoraISO(ctx), m, id]);
      const despues = leerEnvase(db, id, hoyISO(ctx))!;
      ctx.auditar({ accion: 'cerrar', entidad: 'envase', entidadId: id, antes, despues, motivo: m });
      return despues;
    });
    ctx.persistir();
    return dto;
  });
}

// ───────────────────────────── Alertas de calidad ─────────────────────────────

/** Trazabilidad inversa con datos reales de una alerta (sin guardar nada). */
export function trazabilidadDe(db: Db, alerta: AlertaCalidad): TrazabilidadAlerta {
  const cn = alerta.cn ? normalizarCN(alerta.cn) : null;
  const lote = alerta.lote ? alerta.lote.trim().toUpperCase() : '';
  let filas: R[];
  if (cn) filas = db.all<R>('SELECT * FROM envase WHERE cn = ?', [cn]);
  else if (lote) filas = db.all<R>('SELECT * FROM envase WHERE upper(trim(lote)) = ?', [lote]);
  else filas = [];
  const envases: Envase[] = filas.map((f) => ({
    id: f.id, tratamientoId: f.tratamiento_id ?? 0, cn: f.cn, lote: f.lote, caducidad: f.caducidad,
    ...(f.numero_serie ? { numeroSerie: f.numero_serie } : {}), unidadesRestantes: f.unidades_restantes, estado: f.estado,
  }));
  const idsEnvase = envases.map((e) => e.id);
  const lineas: { preparacionId: number; envaseId: number }[] = [];
  for (let i = 0; i < idsEnvase.length; i += 400) {
    const t = idsEnvase.slice(i, i + 400);
    for (const l of db.all<R>(`SELECT preparacion_id, envase_id FROM preparacion_linea WHERE envase_id IN (${t.map(() => '?').join(',')})`, t)) {
      lineas.push({ preparacionId: l.preparacion_id, envaseId: l.envase_id });
    }
  }
  const idsPrep = [...new Set(lineas.map((l) => l.preparacionId))];
  const preparaciones: { id: number; pacienteId: number; estado: string; fechaInicio: string; fechaFin: string }[] = [];
  const entregas: { preparacionId: number; entregadoEn: string }[] = [];
  for (let i = 0; i < idsPrep.length; i += 400) {
    const t = idsPrep.slice(i, i + 400);
    const ph = t.map(() => '?').join(',');
    for (const p of db.all<R>(`SELECT id, paciente_id, estado, fecha_inicio, fecha_fin FROM preparacion WHERE id IN (${ph})`, t)) {
      preparaciones.push({ id: p.id, pacienteId: p.paciente_id, estado: p.estado, fechaInicio: p.fecha_inicio, fechaFin: p.fecha_fin });
    }
    for (const en of db.all<R>(`SELECT preparacion_id, entregado_en FROM entrega WHERE preparacion_id IN (${ph})`, t)) {
      entregas.push({ preparacionId: en.preparacion_id, entregadoEn: en.entregado_en });
    }
  }
  return trazabilidadInversa([alerta], { envases, lineasPreparacion: lineas, preparaciones, entregas })[0];
}

export function importarAlertaCalidad(ctx: Contexto, a: { referencia: string; cn?: string; lote?: string; fecha?: string; descripcion?: string; url?: string }): Promise<Resultado<TrazabilidadAlerta>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const res = db.transaccion(() => {
      if (!a || typeof a !== 'object') throw invalido('Faltan los datos de la alerta.');
      const referencia = textoObligatorio(a.referencia, 'la referencia de la alerta', 100);
      const cnTxt = texto(a.cn, 'CN', 40);
      const cn = cnTxt === null ? null : normalizarCN(cnTxt);
      if (cnTxt !== null && !cn) throw invalido(`El CN de la alerta («${cnTxt}») no es válido: una alerta con un CN que no se entiende no se podría cruzar con las cajas.`);
      const lote = texto(a.lote, 'lote', 60);
      if (!cn && !lote) throw invalido('La alerta necesita un CN o un lote: sin ellos no identifica ninguna caja.');
      const fecha = texto(a.fecha, 'fecha', 10);
      if (fecha !== null && !esFechaIso(fecha)) throw invalido('La fecha de la alerta no es válida (AAAA-MM-DD).');
      const descripcion = texto(a.descripcion, 'descripción', 2000);
      const url = urlHttp(a.url, 'dirección de la alerta');
      const existente = db.get<R>('SELECT id FROM alerta_calidad WHERE referencia = ? AND cn IS ? AND lote IS ?', [referencia, cn, lote]);
      if (!existente) {
        const id = db.run('INSERT INTO alerta_calidad(referencia,cn,lote,fecha,descripcion,url,importado_en) VALUES (?,?,?,?,?,?,?)',
          [referencia, cn, lote, fecha, descripcion, url, ahoraISO(ctx)]).ultimoId;
        ctx.auditar({ accion: 'importar', entidad: 'alerta_calidad', entidadId: id, despues: { referencia, cn, lote, fecha, descripcion, url } });
      }
      // Sólo informa: nada se marca como «retirado» automáticamente.
      return trazabilidadDe(db, { referencia, ...(cn ? { cn } : {}), ...(lote ? { lote } : {}), ...(fecha ? { fecha } : {}), ...(descripcion ? { descripcion } : {}) });
    });
    ctx.persistir();
    return res;
  });
}
