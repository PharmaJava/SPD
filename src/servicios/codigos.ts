/**
 * QR y DataMatrix en SVG, sin red, con bwip-js.
 *
 * Se usa para el QR de la etiqueta (enlace a la hoja A4 del SPD) y para códigos
 * de custodia. El texto se codifica TAL CUAL: este módulo no interpreta nada.
 * Límites: un texto vacío, demasiado largo o con caracteres de control (salvo
 * GS, 0x1D, que usa GS1) se rechaza con un fallo en español: nunca se genera un
 * código que no se sepa si se leerá.
 */
import bwipjs from 'bwip-js';
import type { Resultado } from './api.ts';
import { ok, fallo } from './contexto.ts';

export type Simbologia = 'qrcode' | 'datamatrix';

/** Máximo de caracteres: un QR/DataMatrix legible en una etiqueta pequeña no pasa de ahí. */
export const MAX_TEXTO_CODIGO = 1000;

const SIMBOLOGIAS: readonly Simbologia[] = ['qrcode', 'datamatrix'];

// eslint-disable-next-line no-control-regex
const CONTROL_NO_PERMITIDO = /[\u0000-\u001c\u001e-\u001f\u007f]/;

export function generarCodigoSvg(texto: unknown, simbologia: unknown): Resultado<string> {
  if (typeof texto !== 'string' || texto.length === 0) return fallo('No hay texto que codificar.', 'CODIGO_VACIO');
  if (texto.length > MAX_TEXTO_CODIGO) return fallo(`El texto es demasiado largo para un código (máximo ${MAX_TEXTO_CODIGO} caracteres).`, 'CODIGO_LARGO');
  if (CONTROL_NO_PERMITIDO.test(texto)) return fallo('El texto contiene caracteres de control no permitidos.', 'CODIGO_CONTROL');
  if (typeof simbologia !== 'string' || !SIMBOLOGIAS.includes(simbologia as Simbologia)) {
    return fallo('Simbología no admitida: sólo «qrcode» o «datamatrix».', 'CODIGO_SIMBOLOGIA');
  }
  try {
    const opciones = simbologia === 'qrcode'
      ? { bcid: 'qrcode', text: texto, eclevel: 'M', includetext: false }
      : { bcid: 'datamatrix', text: texto, includetext: false };
    const svg = bwipjs.toSVG(opciones as Parameters<typeof bwipjs.toSVG>[0]);
    if (typeof svg !== 'string' || !svg.startsWith('<svg')) return fallo('No se pudo generar el código.', 'CODIGO_ERROR');
    return ok(svg);
  } catch (e) {
    return fallo('No se pudo generar el código: ' + (e instanceof Error ? e.message : String(e)), 'CODIGO_ERROR');
  }
}

/** Versión asíncrona con la forma de `ApiExterna.codigoSvg`. */
export async function codigoSvg(texto: string, simbologia: Simbologia): Promise<Resultado<string>> {
  return generarCodigoSvg(texto, simbologia);
}
