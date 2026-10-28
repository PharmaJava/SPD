/**
 * Clave de recuperación de la base de datos.
 *
 * Diseño (doc 10): la base se cifra con una CLAVE DE DATOS aleatoria de 256 bits.
 * Esa clave se guarda «envuelta» con la contraseña de la farmacia (así cambiar
 * la contraseña no obliga a recifrar la base) y, además, se exporta UNA vez
 * como clave de recuperación para guardarla fuera del ordenador.
 *
 * Formatos de exportación:
 *   - texto en grupos (Base32 + control) para imprimir o copiar a mano;
 *   - URI otpauth:// para guardarla en una app de autenticación (Google
 *     Authenticator, Aegis, 2FAS…). ⚠️ Esas apps guardan secretos TOTP: el
 *     «código de 6 cifras» que enseñan NO sirve para nada; lo que vale es el
 *     secreto, que se puede volver a exportar desde la app.
 *
 * FUNCIONES PURAS (sólo codificación); el azar lo pone quien llama.
 */

/** Separadores que se ignoran: espacios, guion y sus variantes tipográficas, y caracteres invisibles. */
const SEPARADORES = /[\s\-\u2010-\u2015\u2212\u200b-\u200d\u2060\ufeff]/g;

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function aBase32(bytes: Uint8Array): string {
  let bits = 0, valor = 0, out = '';
  for (const b of bytes) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { out += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31];
  return out;
}

export function deBase32(s: string): Uint8Array {
  const limpio = s.toUpperCase().replace(SEPARADORES, '');
  let bits = 0, valor = 0; const out: number[] = [];
  for (const c of limpio) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) throw new Error('Carácter no válido en la clave de recuperación.');
    valor = (valor << 5) | i; bits += 5;
    if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}

/** Dos caracteres de control (suma ponderada módulo 1024) para detectar erratas al teclear. */
function control(base32: string): string {
  let s = 0;
  for (let i = 0; i < base32.length; i++) s += (ALFABETO.indexOf(base32[i]) + 1) * (i + 1);
  s %= 1024;
  return ALFABETO[s >> 5] + ALFABETO[s & 31];
}

/** Clave de datos de 32 bytes → texto «XXXX-XXXX-…» con control al final. */
export function textoRecuperacion(clave: Uint8Array): string {
  if (clave.length !== 32) throw new Error('La clave de datos debe tener 32 bytes.');
  const b = aBase32(clave);
  return (b + control(b)).match(/.{1,4}/g)!.join('-');
}

/** Texto de recuperación → clave de datos. Falla si hay una errata. */
export function claveDesdeTexto(texto: string): Uint8Array {
  const plano = texto.toUpperCase().replace(SEPARADORES, '');
  if (plano.length !== 54) throw new Error('La clave de recuperación no tiene la longitud esperada.');
  const b = plano.slice(0, 52);
  if (control(b) !== plano.slice(52)) throw new Error('La clave de recuperación tiene una errata.');
  return deBase32(b).slice(0, 32);
}

/** URI para importarla en una app de autenticación. */
export function uriAutenticador(clave: Uint8Array, farmacia: string): string {
  const etiqueta = encodeURIComponent(`SPD ${farmacia}`.trim());
  return `otpauth://totp/${etiqueta}?secret=${aBase32(clave)}&issuer=SPD&digits=6&period=30&algorithm=SHA1`;
}
