/**
 * Panel «Hoy»: lo que hay que hacer, ordenado por gravedad (bloqueo > atención > info).
 */
import type { Contexto } from '../contexto.ts';
import { proteger } from '../contexto.ts';
import type { Resultado, PanelHoy, TareaHoy, EstadoCopias } from '../api.ts';
import type { Db } from '../db.ts';
import { DIAS_AVISO_CADUCIDAD_POR_DEFECTO } from '../../dominio/entrada-envase.ts';
import { envasesAfectados } from '../../dominio/alertas-calidad.ts';
import type { Envase } from '../../dominio/tipos.ts';
import { bd, diasEntre, exigirSesion, formatoFecha, hoyISO } from './comun.ts';
import type { R } from './comun.ts';
import { coberturaPorPaciente } from './cobertura.ts';

const UMBRAL_COBERTURA_DIAS = 7;
const DIAS_COPIA_ATRASADA = 7;
const RANGO = { bloqueo: 0, atencion: 1, info: 2 } as const;
const ORDEN_TIPO = ['sin_consentimiento', 'alerta_calidad', 'caja_caducada', 'cobertura_baja', 'caja_caduca', 'preparacion_validada', 'preparacion_preparada', 'preparacion_borrador', 'ficha_incompleta', 'revision_vencida', 'copia_atrasada'];

function ajuste(db: Db, clave: string): string | null {
  return db.get<R>('SELECT valor FROM ajuste WHERE clave = ?', [clave])?.valor ?? null;
}

export function estadoCopiasDesdeAjustes(db: Db, hoy: string): EstadoCopias {
  const ultima = ajuste(db, 'ultima_copia');
  const dia = ultima && /^\d{4}-\d{2}-\d{2}/.test(ultima) ? ultima.slice(0, 10) : null;
  return {
    ultima: ultima ?? null,
    atrasada: dia !== null && diasEntre(dia, hoy) > DIAS_COPIA_ATRASADA,
    carpeta: ajuste(db, 'carpeta_copias'),
    total: Number(ajuste(db, 'total_copias') ?? 0) || 0,
  };
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

export function panelHoy(ctx: Contexto): Promise<Resultado<PanelHoy>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const hoy = hoyISO(ctx);
    const tareas: TareaHoy[] = [];
    const nombres = new Map<number, string>();
    const pacientes = db.all<R>('SELECT id, nombre, apellido1, apellido2, estado, proxima_revision FROM paciente');
    for (const p of pacientes) nombres.set(p.id, [p.nombre, p.apellido1, p.apellido2].filter(Boolean).join(' '));
    const enServicio = pacientes.filter((p) => p.estado === 'activo');

    // 1. Pacientes sin consentimiento del servicio vigente.
    const consentidos = new Set(db.all<R>(
      `SELECT DISTINCT d.paciente_id FROM documento_firmado d JOIN plantilla_documento pl ON pl.id = d.plantilla_id
        WHERE pl.codigo = 'consentimiento_spd' AND d.revocado_en IS NULL`).map((r) => r.paciente_id as number));
    for (const p of enServicio) {
      if (!consentidos.has(p.id)) {
        tareas.push({ tipo: 'sin_consentimiento', gravedad: 'bloqueo', pacienteId: p.id, accion: 'abrirPaciente',
          texto: `${nombres.get(p.id)} no tiene el consentimiento del servicio SPD firmado: no se puede validar ninguna preparación.` });
      }
    }

    // 2. Cajas en custodia: caducadas, que caducan pronto y afectadas por alertas de calidad.
    const cajas = db.all<R>(
      `SELECT e.*, m.nombre AS med FROM envase e LEFT JOIN medicamento m ON m.cn = e.cn WHERE e.estado = 'en_uso' ORDER BY e.caducidad, e.id`);
    const caducadas = new Map<number, R[]>();
    const proximas = new Map<number, R[]>();
    let cajasQueCaducan = 0;
    for (const c of cajas) {
      const dias = diasEntre(hoy, c.caducidad);
      if (dias < 0) { (caducadas.get(c.paciente_id) ?? caducadas.set(c.paciente_id, []).get(c.paciente_id)!).push(c); cajasQueCaducan++; }
      else if (dias <= DIAS_AVISO_CADUCIDAD_POR_DEFECTO) { (proximas.get(c.paciente_id) ?? proximas.set(c.paciente_id, []).get(c.paciente_id)!).push(c); cajasQueCaducan++; }
    }
    const descCaja = (c: R) => `${c.med ?? c.cn} (lote ${c.lote}, ${formatoFecha(c.caducidad)})`;
    for (const [pid, l] of caducadas) {
      tareas.push({ tipo: 'caja_caducada', gravedad: 'bloqueo', pacienteId: pid, accion: 'abrirPaciente',
        texto: `${nombres.get(pid)}: ${plural(l.length, 'caja caducada', 'cajas caducadas')} en custodia — ${l.map(descCaja).join('; ')}. Apártala${l.length === 1 ? '' : 's'}.` });
    }
    for (const [pid, l] of proximas) {
      tareas.push({ tipo: 'caja_caduca', gravedad: 'atencion', pacienteId: pid, accion: 'abrirPaciente',
        texto: `${nombres.get(pid)}: ${plural(l.length, 'caja caduca', 'cajas caducan')} en ${DIAS_AVISO_CADUCIDAD_POR_DEFECTO} días o menos — ${l.map(descCaja).join('; ')}.` });
    }
    const alertas = db.all<R>('SELECT referencia, cn, lote, fecha, descripcion FROM alerta_calidad ORDER BY id').map((r) => ({
      referencia: r.referencia, ...(r.cn ? { cn: r.cn } : {}), ...(r.lote ? { lote: r.lote } : {}), ...(r.fecha ? { fecha: r.fecha } : {}),
    }));
    if (alertas.length > 0 && cajas.length > 0) {
      const dominio: Envase[] = cajas.map((c) => ({
        id: c.id, tratamientoId: c.tratamiento_id ?? 0, cn: c.cn, lote: c.lote, caducidad: c.caducidad,
        unidadesRestantes: c.unidades_restantes, estado: c.estado,
      }));
      const porPaciente = new Map<number, { c: R; refs: string[] }[]>();
      const idsCaja = new Map(cajas.map((c) => [c.id as number, c]));
      for (const af of envasesAfectados(dominio, alertas).afectados) {
        const c = idsCaja.get(af.envase.id)!;
        (porPaciente.get(c.paciente_id) ?? porPaciente.set(c.paciente_id, []).get(c.paciente_id)!).push({ c, refs: af.alertas.map((x) => x.referencia) });
      }
      for (const [pid, l] of porPaciente) {
        tareas.push({ tipo: 'alerta_calidad', gravedad: 'bloqueo', pacienteId: pid, accion: 'abrirPaciente',
          texto: `${nombres.get(pid)}: alerta de calidad que afecta a ${plural(l.length, 'caja', 'cajas')} en custodia — ${l.map((x) => `${descCaja(x.c)} [${[...new Set(x.refs)].join(', ')}]`).join('; ')}. Apártalas y revisa los blísteres.` });
      }
    }

    // 3. Cobertura baja.
    const cobertura = coberturaPorPaciente(db, hoy);
    let pacientesSinCobertura = 0;
    for (const p of enServicio) {
      const dias = cobertura.get(p.id);
      if (dias !== undefined && dias !== null && dias < UMBRAL_COBERTURA_DIAS) {
        pacientesSinCobertura++;
        tareas.push({ tipo: 'cobertura_baja', gravedad: 'atencion', pacienteId: p.id, accion: 'registrarEnvase',
          texto: `${nombres.get(p.id)}: las cajas en custodia sólo cubren ${plural(dias, 'día', 'días')} (menos de ${UMBRAL_COBERTURA_DIAS}).` });
      }
    }

    // 4. Preparaciones pendientes.
    const preps = db.all<R>(
      `SELECT id, id_publico, paciente_id, estado, fecha_inicio, fecha_fin FROM preparacion WHERE estado IN ('borrador','preparado','validado') ORDER BY fecha_inicio, id`);
    const textoPrep: Record<string, [string, string, TareaHoy['gravedad']]> = {
      borrador: ['preparacion_borrador', 'está en borrador sin terminar', 'atencion'],
      preparado: ['preparacion_preparada', 'está preparada y pendiente de validar', 'atencion'],
      validado: ['preparacion_validada', 'está validada y sin entregar', 'atencion'],
    };
    for (const pr of preps) {
      const [tipo, frase, gravedad] = textoPrep[pr.estado];
      tareas.push({ tipo, gravedad, pacienteId: pr.paciente_id, accion: 'verPreparacion',
        texto: `${nombres.get(pr.paciente_id) ?? 'Paciente'}: la preparación ${String(pr.id_publico).slice(0, 8)} (${formatoFecha(pr.fecha_inicio)} – ${formatoFecha(pr.fecha_fin)}) ${frase}.` });
    }

    // 5. Fichas de medicamento sin confirmar que están en uso.
    const fichas = db.all<R>(
      `SELECT m.cn, m.nombre FROM medicamento m WHERE m.descripcion_estado <> 'confirmada' AND (
         EXISTS (SELECT 1 FROM envase e JOIN paciente p ON p.id = e.paciente_id WHERE e.cn = m.cn AND e.estado = 'en_uso' AND p.estado IN ('activo','pausado'))
         OR EXISTS (SELECT 1 FROM tratamiento t JOIN paciente p ON p.id = t.paciente_id WHERE t.cn_preferente = m.cn AND t.finalizado_en IS NULL AND p.estado IN ('activo','pausado')))
       ORDER BY m.nombre COLLATE NOCASE`);
    for (const f of fichas) {
      tareas.push({ tipo: 'ficha_incompleta', gravedad: 'atencion', accion: 'completarFicha',
        texto: `Falta confirmar el aspecto (descripción física) de ${f.nombre} (CN ${f.cn}), que está en uso.` });
    }

    // 6. Revisiones vencidas.
    for (const p of enServicio) {
      if (p.proxima_revision && p.proxima_revision <= hoy) {
        tareas.push({ tipo: 'revision_vencida', gravedad: 'info', pacienteId: p.id, accion: 'abrirPaciente',
          texto: p.proxima_revision === hoy
            ? `${nombres.get(p.id)}: la revisión del tratamiento toca hoy.`
            : `${nombres.get(p.id)}: la revisión del tratamiento venció el ${formatoFecha(p.proxima_revision)}.` });
      }
    }

    // 7. Copia de seguridad.
    const copias = estadoCopiasDesdeAjustes(db, hoy);
    if (copias.atrasada) {
      tareas.push({ tipo: 'copia_atrasada', gravedad: 'atencion', accion: 'crearCopia',
        texto: `La última copia de seguridad es del ${formatoFecha(copias.ultima!)}: hace más de ${DIAS_COPIA_ATRASADA} días.` });
    }

    tareas.sort((a, b) => RANGO[a.gravedad] - RANGO[b.gravedad] || ORDEN_TIPO.indexOf(a.tipo) - ORDEN_TIPO.indexOf(b.tipo) || a.texto.localeCompare(b.texto, 'es'));
    return {
      fecha: hoy, tareas,
      cifras: { pacientesActivos: enServicio.length, preparacionesPendientes: preps.length, cajasQueCaducan, pacientesSinCobertura, fichasIncompletas: fichas.length },
      copias,
    };
  });
}
