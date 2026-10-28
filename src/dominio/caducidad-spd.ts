/**
 * Caducidad y validación de un SPD.
 *
 * Regla general (documentos de referencia CTI-SPD / SEFAC): el SPD vale como
 * máximo 14 días desde el desemblistado hasta el último día de administración,
 * y nunca más que el lote que antes caduque.
 *
 * DECISIÓN DE ANTONIO (28-oct-2026): el programa permite, de forma OPCIONAL y
 * explícita, validez de hasta 30 días. Se hace en la práctica aunque no sea lo
 * que recomiendan los documentos de referencia, así que:
 *   - viene APAGADO; el titular lo activa en Ajustes leyendo un aviso;
 *   - cada preparación por encima de 14 días exige una justificación escrita;
 *   - queda marcada en la preparación, en la etiqueta interna y en la auditoría.
 * El programa informa de la desviación; no la oculta ni la bloquea.
 *
 * FUNCIONES PURAS. Fechas ISO AAAA-MM-DD, aritmética en UTC.
 */

export const DIAS_VALIDEZ_ESTANDAR = 14;
export const DIAS_VALIDEZ_MAXIMA_EXTENDIDA = 30;

export type Rol = 'titular' | 'farmaceutico' | 'tecnico' | 'administrativo';

/** Sólo un farmacéutico (o el titular, que lo es) puede validar un SPD. */
export function puedeValidar(rol: Rol): boolean {
  return rol === 'farmaceutico' || rol === 'titular';
}

export interface EntradaCaducidad {
  /** Caducidades (AAAA-MM-DD) de cada lote incluido en el blíster. */
  caducidadesLotes: string[];
  /** Día en que se desemblista/prepara. */
  fechaPreparacion: string;
  /** Validez que se pretende, en días. */
  diasValidez: number;
  /** Ajuste del titular: ¿se admiten validez de más de 14 días? */
  validezExtendidaPermitida: boolean;
  /** Justificación escrita, obligatoria si diasValidez > 14. */
  justificacion?: string;
}

export interface ResultadoCaducidad {
  ok: boolean;
  /** Último día de administración permitido (= caducidad del SPD). */
  caducidadSpd?: string;
  limitadaPor?: 'validez' | 'lote';
  /** Validez superior a la estándar: hay que marcarla en la preparación. */
  fueraDeEstandar: boolean;
  avisos: string[];
  errores: string[];
}

const esFecha = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function calcularCaducidadSpd(e: EntradaCaducidad): ResultadoCaducidad {
  const r: ResultadoCaducidad = { ok: false, fueraDeEstandar: false, avisos: [], errores: [] };
  if (!esFecha(e.fechaPreparacion)) r.errores.push('Fecha de preparación no válida.');
  if (e.caducidadesLotes.length === 0 || !e.caducidadesLotes.every(esFecha)) r.errores.push('Falta la caducidad de algún lote.');
  if (!Number.isInteger(e.diasValidez) || e.diasValidez < 1) r.errores.push('La validez debe ser un número entero de días.');
  if (r.errores.length) return r;

  if (e.diasValidez > DIAS_VALIDEZ_MAXIMA_EXTENDIDA) {
    r.errores.push(`El máximo que admite el programa es ${DIAS_VALIDEZ_MAXIMA_EXTENDIDA} días.`);
    return r;
  }
  if (e.diasValidez > DIAS_VALIDEZ_ESTANDAR) {
    if (!e.validezExtendidaPermitida) {
      r.errores.push(`Validez de más de ${DIAS_VALIDEZ_ESTANDAR} días no activada en Ajustes.`);
      return r;
    }
    if (!e.justificacion || e.justificacion.trim().length < 10) {
      r.errores.push('Una validez superior a 14 días exige una justificación escrita.');
      return r;
    }
    r.fueraDeEstandar = true;
    r.avisos.push(`Validez de ${e.diasValidez} días: supera los ${DIAS_VALIDEZ_ESTANDAR} de los documentos de referencia. Queda registrada como desviación.`);
  }

  const porValidez = sumarDias(e.fechaPreparacion, e.diasValidez);
  const menorLote = [...e.caducidadesLotes].sort()[0];
  if (menorLote < porValidez) { r.caducidadSpd = menorLote; r.limitadaPor = 'lote'; }
  else { r.caducidadSpd = porValidez; r.limitadaPor = 'validez'; }
  if (r.caducidadSpd < e.fechaPreparacion) {
    r.errores.push('Hay un lote ya caducado: no se puede preparar.');
    r.caducidadSpd = undefined; r.limitadaPor = undefined;
    return r;
  }
  r.ok = true;
  return r;
}

/** ¿El último día de administración cabe dentro de la caducidad del SPD? */
export function periodoCabe(fechaFinAdministracion: string, caducidadSpd: string): boolean {
  return fechaFinAdministracion <= caducidadSpd;
}
