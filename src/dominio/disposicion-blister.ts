/**
 * Disposición del blíster: en qué fila y columna cae cada día y cada toma.
 *
 * Es lo que decide qué se ve en la pantalla de preparación, en la hoja de
 * trabajo y en la etiqueta. Los blísteres reales difieren en cómo se
 * orientan y de qué día arrancan, así que todo es configurable:
 *
 *   - inicioDia 'convencional': las filas son los días de la semana fijos
 *     (lunes … domingo); un periodo que empieza en miércoles rellena la fila
 *     del miércoles con su fecha, la del jueves…, y la del lunes con la
 *     fecha del lunes SIGUIENTE.
 *   - inicioDia 'cronologico': la primera fila es el primer día del periodo y
 *     cada fila siguiente es el día siguiente.
 *   - sentidoTomas: orden de las columnas (algunos blísteres leen de
 *     derecha a izquierda: noche … desayuno).
 *   - rotar180: el blíster se coloca girado (invierte filas y columnas).
 *   - posicionInicial: por qué lado se empieza a llenar (sólo afecta a
 *     `ordenLlenado`, no al mapa).
 *
 * Un periodo de más de 7 días se parte en varios blísteres de 7 días.
 * FUNCIONES PURAS. Fechas ISO AAAA-MM-DD, aritmética UTC.
 */
import type { MomentoToma } from './tipos.ts';

export interface OpcionesDisposicion {
  inicioDia: 'convencional' | 'cronologico';
  rotar180: boolean;
  sentidoTomas: 'izquierda_derecha' | 'derecha_izquierda';
  posicionInicial: 'izquierda' | 'derecha';
}

export const DISPOSICION_POR_DEFECTO: OpcionesDisposicion = {
  inicioDia: 'convencional', rotar180: false,
  sentidoTomas: 'izquierda_derecha', posicionInicial: 'izquierda',
};

export interface FilaBlister { fecha: string | null; diaSemana: number | null }   // 1 = lunes … 7 = domingo
export interface CeldaBlister { fila: number; columna: number; fecha: string | null; momentoId: number; usada: boolean }
export interface MapaBlister {
  indice: number;               // 0, 1, 2… dentro del periodo
  desde: string;
  hasta: string;
  filas: FilaBlister[];
  columnas: MomentoToma[];
  celdas: CeldaBlister[];       // fila a fila
}

const DIA_MS = 86_400_000;
const esFecha = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const aDia = (s: string) => Math.round(Date.parse(s + 'T00:00:00Z') / DIA_MS);
const deDia = (n: number) => new Date(n * DIA_MS).toISOString().slice(0, 10);
function diaSemana(f: string): number { const d = new Date(f + 'T00:00:00Z').getUTCDay(); return d === 0 ? 7 : d; }

export const MAX_DIAS_PERIODO = 366;

export function construirMapas(
  desde: string, dias: number, momentos: MomentoToma[],
  opciones: Partial<OpcionesDisposicion> = {},
): MapaBlister[] {
  const op: OpcionesDisposicion = { ...DISPOSICION_POR_DEFECTO, ...opciones };
  if (!esFecha(desde)) throw new RangeError('Fecha de inicio no válida.');
  if (!Number.isInteger(dias) || dias < 1 || dias > MAX_DIAS_PERIODO) throw new RangeError(`Los días deben ser un entero entre 1 y ${MAX_DIAS_PERIODO}.`);
  if (momentos.length === 0) throw new RangeError('Hay que definir al menos un momento de toma.');
  if (new Set(momentos.map(m => m.id)).size !== momentos.length) throw new RangeError('Momentos de toma repetidos.');

  let columnas = [...momentos].sort((a, b) => a.orden - b.orden || a.id - b.id);
  if (op.sentidoTomas === 'derecha_izquierda') columnas.reverse();
  if (op.rotar180) columnas = [...columnas].reverse();

  const inicio = aDia(desde);
  const mapas: MapaBlister[] = [];
  for (let k = 0; k * 7 < dias; k++) {
    const fechas: string[] = [];
    for (let i = k * 7; i < Math.min(dias, k * 7 + 7); i++) fechas.push(deDia(inicio + i));

    let filas: FilaBlister[];
    if (op.inicioDia === 'cronologico') {
      filas = fechas.map(f => ({ fecha: f, diaSemana: diaSemana(f) }));
      while (filas.length < 7) filas.push({ fecha: null, diaSemana: null });
    } else {
      filas = Array.from({ length: 7 }, (_, r) => {
        const f = fechas.find(x => diaSemana(x) === r + 1) ?? null;
        return { fecha: f, diaSemana: r + 1 };
      });
    }
    if (op.rotar180) filas = [...filas].reverse();

    const celdas: CeldaBlister[] = [];
    filas.forEach((fila, r) => columnas.forEach((m, c) =>
      celdas.push({ fila: r, columna: c, fecha: fila.fecha, momentoId: m.id, usada: fila.fecha !== null })));
    mapas.push({ indice: k, desde: fechas[0], hasta: fechas[fechas.length - 1], filas, columnas, celdas });
  }
  return mapas;
}

export function buscarCelda(mapa: MapaBlister, fecha: string, momentoId: number): CeldaBlister | null {
  return mapa.celdas.find(c => c.usada && c.fecha === fecha && c.momentoId === momentoId) ?? null;
}

/** Celdas usadas en el orden en que conviene llenarlas, empezando por el lado indicado. */
export function ordenLlenado(mapa: MapaBlister, posicionInicial: 'izquierda' | 'derecha'): CeldaBlister[] {
  const usadas = mapa.celdas.filter(c => c.usada);
  return usadas.sort((a, b) => a.fila - b.fila || (posicionInicial === 'izquierda' ? a.columna - b.columna : b.columna - a.columna));
}

/** Encuentra en qué blíster del periodo está una toma. */
export function ubicarToma(mapas: MapaBlister[], fecha: string, momentoId: number): { mapa: MapaBlister; celda: CeldaBlister } | null {
  for (const mapa of mapas) { const celda = buscarCelda(mapa, fecha, momentoId); if (celda) return { mapa, celda }; }
  return null;
}
