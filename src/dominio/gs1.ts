/**
 * Lectura del DataMatrix GS1 de los medicamentos (identificador único,
 * Reglamento Delegado (UE) 2016/161) y normalización del código nacional.
 *
 * FUNCIONES PURAS: sin disco, red ni interfaz. La fecha de referencia para
 * resolver el siglo de la caducidad entra por parámetro.
 *
 * Ante la duda, NO adivina: si la lectura admite dos interpretaciones
 * (pasa cuando el lector se come el separador GS entre lote y serie) devuelve
 * `ambiguo: true` con las candidatas, y la interfaz pide confirmarlo.
 */

export const GS = '\u001d';

/** Identificadores de aplicación que se esperan en un envase de medicamento. */
const AI_FIJOS: Record<string, number> = { '01': 14, '11': 6, '17': 6 };
const AI_VARIABLES: Record<string, number> = {
  '10': 20,   // lote
  '21': 20,   // número de serie
  '712': 20,  // NHRN España (código nacional), si el fabricante lo incluye
  '714': 20,  // NHRN Portugal (por si llega un envase de allí)
};

export interface LecturaGS1 {
  gtin?: string;
  cn?: string;              // 6 dígitos, sin dígito de control
  caducidad?: string;       // AAAA-MM-DD
  fabricacion?: string;     // AAAA-MM-DD, AI (11)
  lote?: string;
  serie?: string;
  nhrn?: string;            // AI (712) tal cual
  ambiguo: boolean;
  candidatas: Record<string, string>[];   // si ambiguo, todas las lecturas válidas
  avisos: string[];
  errores: string[];
}

export interface OpcionesGS1 {
  /** Carácter que el lector manda en lugar de GS (algunos en modo teclado). */
  separadores?: string[];
  /** Fecha de hoy, para el siglo de AAMMDD. */
  hoy?: Date;
}

/** Quita el identificador de simbología (]d2 DataMatrix, ]C1 GS1-128, ]Q3 QR). */
function quitarPrefijo(t: string): string {
  return t.replace(/^\](d2|C1|Q3|e0)/, '');
}

/** Dígito de control GS1 (módulo 10) de una cadena numérica SIN el dígito. */
export function digitoControlGS1(sinDigito: string): number {
  let suma = 0;
  for (let i = 0; i < sinDigito.length; i++) {
    const d = sinDigito.charCodeAt(sinDigito.length - 1 - i) - 48;
    suma += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (suma % 10)) % 10;
}

export function gtinValido(gtin: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(gtin)) return false;
  return digitoControlGS1(gtin.slice(0, -1)) === Number(gtin.slice(-1));
}

/**
 * CN de 6 dígitos a partir de un GTIN español: 847000 + CN + control.
 * Admite GTIN-13 y GTIN-14 con cero delante. Devuelve null si no es español.
 */
export function cnDesdeGtin(gtin: string): string | null {
  const g13 = gtin.length === 14 && gtin[0] === '0' ? gtin.slice(1) : gtin;
  if (!/^847000\d{7}$/.test(g13)) return null;
  return g13.slice(6, 12);
}

/**
 * Normaliza lo que se teclea o escanea como «código nacional»:
 *   «712729.3», «712729-3», «7127293», «C.N. 712729.3», EAN-13 8470007127293.
 * ⚠️ El dígito de control del CN NO se valida: una fórmula sin contrastar
 * rechazaría CN buenos (lección de conveniodefarmacia.com, entrada #92).
 */
export function normalizarCN(entrada: string): string | null {
  const limpio = entrada.replace(/c\.?\s*n\.?/i, '').trim();
  const digitos = limpio.replace(/\D/g, '');
  if (digitos.length === 13 || digitos.length === 14) return cnDesdeGtin(digitos);
  if (digitos.length === 6 || digitos.length === 7) return digitos.slice(0, 6);
  return null;
}

/** AAMMDD → AAAA-MM-DD. Día 00 = último día del mes (regla GS1). */
export function fechaGS1(aammdd: string, hoy: Date = new Date()): string | null {
  if (!/^\d{6}$/.test(aammdd)) return null;
  const aa = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  let dd = Number(aammdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  // Ventana de siglo GS1: de −49 a +50 años respecto al año en curso.
  const actual = hoy.getUTCFullYear();
  const siglo = Math.floor(actual / 100) * 100;
  let anio = siglo + aa;
  const dif = anio - actual;
  if (dif > 50) anio -= 100;
  else if (dif < -49) anio += 100;
  const ultimo = new Date(Date.UTC(anio, mm, 0)).getUTCDate();
  if (dd === 0) dd = ultimo;
  if (dd > ultimo) return null;
  return `${anio}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * Recorre la cadena y devuelve TODAS las formas de partirla en AI conocidos.
 * Con GS presentes sale una; sin ellos puede salir más de una.
 */
function particiones(t: string): Record<string, string>[] {
  const res: Record<string, string>[] = [];
  const recorrer = (pos: number, acc: Record<string, string>) => {
    if (res.length > 20) return;                    // tope defensivo
    if (pos === t.length) { res.push({ ...acc }); return; }
    if (t[pos] === GS) { recorrer(pos + 1, acc); return; }
    for (const ai of [...Object.keys(AI_FIJOS), ...Object.keys(AI_VARIABLES)]) {
      if (!t.startsWith(ai, pos) || ai in acc) continue;
      const ini = pos + ai.length;
      if (ai in AI_FIJOS) {
        const fin = ini + AI_FIJOS[ai];
        const v = t.slice(ini, fin);
        if (v.length !== AI_FIJOS[ai] || !/^\d+$/.test(v)) continue;
        recorrer(fin, { ...acc, [ai]: v });
      } else {
        const max = AI_VARIABLES[ai];
        const gs = t.indexOf(GS, ini);
        if (gs !== -1 && gs - ini <= max) {
          // Hay separador: el campo termina ahí, sin discusión.
          if (gs > ini) recorrer(gs + 1, { ...acc, [ai]: t.slice(ini, gs) });
          continue;
        }
        // Sin separador: probar todas las longitudes posibles.
        for (let fin = Math.min(t.length, ini + max); fin > ini; fin--) {
          recorrer(fin, { ...acc, [ai]: t.slice(ini, fin) });
        }
      }
    }
  };
  recorrer(0, {});
  // Quitar duplicados exactos
  const vistos = new Set<string>();
  return res.filter(r => { const k = JSON.stringify(Object.entries(r).sort()); return vistos.has(k) ? false : (vistos.add(k), true); });
}

export function parsearGS1(entrada: string, op: OpcionesGS1 = {}): LecturaGS1 {
  const hoy = op.hoy ?? new Date();
  const out: LecturaGS1 = { ambiguo: false, candidatas: [], avisos: [], errores: [] };
  let t = quitarPrefijo(entrada.replace(/[\r\n]+$/, ''));
  for (const s of op.separadores ?? []) if (s) t = t.split(s).join(GS);
  if (t.startsWith(GS)) t = t.slice(1);          // FNC1 inicial

  // Las lecturas que exigen a la vez (01) y (17) son las únicas útiles
  const todas = particiones(t).filter(p => '01' in p);
  const validas = todas.filter(p => gtinValido(p['01']) && (!('17' in p) || fechaGS1(p['17'], hoy)));
  if (validas.length === 0) {
    out.errores.push('No se reconoce un DataMatrix de medicamento (falta un GTIN válido).');
    return out;
  }
  if (validas.length > 1) {
    out.ambiguo = true;
    out.candidatas = validas;
    out.avisos.push('El lector no ha enviado el separador entre campos: lote y serie no se pueden distinguir con seguridad. Confirma el lote mirando la caja.');
  }
  const p = validas[0];
  out.gtin = p['01'];
  out.cn = cnDesdeGtin(p['01']) ?? undefined;
  if (p['712']) {
    out.nhrn = p['712'];
    if (!out.cn && /^\d{6,7}$/.test(p['712'])) {
      out.cn = p['712'].slice(0, 6);
      out.avisos.push('CN tomado del campo (712): compruébalo con la caja.');
    }
  }
  if (!out.cn) out.avisos.push('El GTIN no es español (847000…): el CN no se puede deducir. Introdúcelo a mano.');
  if (p['17']) out.caducidad = fechaGS1(p['17'], hoy) ?? undefined;
  else out.errores.push('El código no trae caducidad (17).');
  if (p['11']) out.fabricacion = fechaGS1(p['11'], hoy) ?? undefined;
  if (p['10']) out.lote = p['10']; else out.errores.push('El código no trae lote (10).');
  if (p['21']) out.serie = p['21'];
  return out;
}
