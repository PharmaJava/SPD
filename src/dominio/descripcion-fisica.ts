/**
 * Propuesta de descripción física (color, forma, ranura, marcas) de un
 * comprimido o cápsula a partir del texto de la sección 3 de la ficha técnica
 * («Forma farmacéutica», CIMA). Ver docs/05-aemps-cima.md §5.2.
 *
 * FUNCIONES PURAS: sin disco, red ni interfaz.
 *
 * Reglas de seguridad:
 *  - Es una PROPUESTA: un farmacéutico la confirma o la corrige.
 *  - `ranuraDivisible` es SIEMPRE 'desconocido': la ranura de la ficha puede
 *    ser sólo para facilitar la deglución. Si hay ranura, se avisa.
 *  - Ante la ambigüedad no se simplifica: «blanco o casi blanco», «rosa
 *    pálido», «amarillo anaranjado» o una cápsula bicolor conservan el detalle
 *    y/o generan un aviso.
 *  - Nada se inventa: sin información, todo vacío y aviso «sin descripción
 *    física».
 *
 * Rendimiento: sin expresiones regulares con retroceso; el texto se recorre
 * una vez para las comillas y una vez para las palabras.
 */

export type Ranura = 'ninguna' | 'una_cara' | 'ambas_caras' | 'sin_dato';
export type TipoForma = 'comprimido' | 'capsula' | 'gragea' | 'otro';

export interface PropuestaDescripcion {
  colores: string[];
  forma: string | null;
  ranura: Ranura;
  /** Siempre 'desconocido': sólo lo decide el farmacéutico. */
  ranuraDivisible: 'desconocido';
  marcas: string[];
  tipo: TipoForma | null;
  recubierto: boolean | null;
  avisos: string[];
  textoOriginal: string;
}

export const AVISO_RANURA =
  'la ranura puede no servir para dividir la dosis: comprobar en la ficha técnica';
export const AVISO_SIN_DESCRIPCION = 'sin descripción física';

// ───────────────────────── Listas cerradas ─────────────────────────

const gen = (raiz: string): string[] => [raiz + 'o', raiz + 'a', raiz + 'os', raiz + 'as'];

/** [forma canónica con tildes, formas sin tildes ni mayúsculas que la identifican] */
const COLORES_BASE: [string, string[]][] = [
  ['blanco', gen('blanc')],
  ['amarillo', gen('amarill')],
  ['naranja', ['naranja', 'naranjas']],
  ['rojo', gen('roj')],
  ['rosa', ['rosa', 'rosas']],
  ['azul', ['azul', 'azules']],
  ['verde', ['verde', 'verdes']],
  ['marrón', ['marron', 'marrones']],
  ['gris', ['gris', 'grises']],
  ['negro', gen('negr')],
  ['violeta', ['violeta', 'violetas']],
  ['morado', gen('morad')],
  ['púrpura', ['purpura', 'purpuras']],
  ['beige', ['beige', 'beiges']],
  ['crema', ['crema', 'cremas']],
  ['lila', ['lila', 'lilas']],
  ['turquesa', ['turquesa', 'turquesas']],
  ['celeste', ['celeste', 'celestes']],
  ['salmón', ['salmon', 'salmones']],
  ['marfil', ['marfil', 'marfiles']],
  ['ocre', ['ocre', 'ocres']],
  ['transparente', ['transparente', 'transparentes']],
  ['incoloro', gen('incolor')],
];

/** Colores adjetivales: [canónica como 2.º elemento, formas, canónica si va sola]. */
const COLORES_ADJ: [string, string[], string][] = [
  ['anaranjado', gen('anaranjad'), 'naranja'],
  ['rosado', gen('rosad'), 'rosa'],
  ['amarillento', gen('amarillent'), 'amarillento'],
  ['rojizo', gen('rojiz'), 'rojizo'],
  ['verdoso', gen('verdos'), 'verdoso'],
  ['azulado', gen('azulad'), 'azulado'],
  ['blanquecino', gen('blanquecin'), 'blanquecino'],
  ['grisáceo', gen('grisace'), 'grisáceo'],
  ['amarronado', gen('amarronad'), 'amarronado'],
  ['violáceo', gen('violace'), 'violáceo'],
  ['parduzco', gen('parduzc'), 'parduzco'],
];

const MODIFICADORES: [string, string[]][] = [
  ['claro', gen('clar')],
  ['oscuro', gen('oscur')],
  ['pálido', gen('palid')],
  ['intenso', gen('intens')],
  ['brillante', ['brillante', 'brillantes']],
  ['opaco', gen('opac')],
  ['translúcido', gen('translucid')],
  ['pastel', ['pastel', 'pasteles']],
  ['vivo', gen('viv')],
  ['apagado', gen('apagad')],
  ['fuerte', ['fuerte', 'fuertes']],
  ['suave', ['suave', 'suaves']],
];

const FORMAS_CONTORNO: [string, string[]][] = [
  ['redondo', gen('redond')],
  ['oblongo', gen('oblong')],
  ['ovalado', [...gen('ovalad'), 'oval', 'ovales']],
  ['elíptico', gen('eliptic')],
  ['alargado', gen('alargad')],
  ['cilíndrico', gen('cilindric')],
  ['lenticular', ['lenticular', 'lenticulares']],
  ['triangular', ['triangular', 'triangulares']],
  ['capsulado', gen('capsulad')],
  ['cuadrado', gen('cuadrad')],
  ['rectangular', ['rectangular', 'rectangulares']],
  ['romboidal', ['romboidal', 'romboidales']],
  ['hexagonal', ['hexagonal', 'hexagonales']],
  ['octogonal', ['octogonal', 'octogonales']],
];

const FORMAS_PERFIL: [string, string[]][] = [
  ['biconvexo', gen('biconvex')],
  ['bicóncavo', gen('biconcav')],
  ['convexo', gen('convex')],
  ['plano', gen('plan')],
];

function mapa(lista: [string, string[]][]): Map<string, string> {
  const m = new Map<string, string>();
  for (const [canon, formas] of lista) for (const f of formas) m.set(f, canon);
  return m;
}

const M_COLOR = mapa(COLORES_BASE);
const M_MOD = mapa(MODIFICADORES);
const M_CONTORNO = mapa(FORMAS_CONTORNO);
const M_PERFIL = mapa(FORMAS_PERFIL);
/** forma adjetival → [canónica como 2.º elemento, canónica si va sola]. */
const M_ADJ = new Map<string, [string, string]>();
for (const [canon, formas, sola] of COLORES_ADJ) for (const f of formas) M_ADJ.set(f, [canon, sola]);

const TIPOS = new Map<string, TipoForma>([
  ['comprimido', 'comprimido'], ['comprimidos', 'comprimido'],
  ['capsula', 'capsula'], ['capsulas', 'capsula'],
  ['gragea', 'gragea'], ['grageas', 'gragea'],
]);
const OTROS_TIPOS = new Set([
  'sobre', 'sobres', 'solucion', 'suspension', 'polvo', 'granulado', 'granulados', 'parche', 'parches',
  'supositorio', 'supositorios', 'liquido', 'jarabe', 'gotas', 'oblea', 'obleas', 'pastilla', 'pastillas',
  'liofilizado', 'inyectable', 'emulsion',
]);

/** Palabras que anulan lo que viene detrás («sin ranura», «no ranurado»). */
const NEGADORES = new Set(['sin', 'no', 'ni', 'carece', 'carecen', 'ausencia', 'ninguna', 'ninguno', 'ningun']);
/** Palabras que pueden mediar entre el negador y lo negado («no presenta ranura»). */
const RELLENO = new Set([
  'un', 'una', 'unos', 'unas', 'la', 'las', 'el', 'los', 'alguna', 'algun', 'de', 'del', 'se', 'presenta',
  'presentan', 'tiene', 'tienen', 'lleva', 'llevan', 'muestra', 'muestran', 'posee', 'poseen', 'hay',
  'existe', 'aprecia', 'aprecian', 'observa', 'observan', 'distingue', 'visible', 'visibles', 'marca', 'marcas',
]);

const SUPERFICIES = new Set(['cara', 'caras', 'lado', 'lados', 'superficie', 'superficies']);
const ROTURA = new Set(['rotura', 'fractura', 'division', 'ruptura', 'corte']);
const PARTES_CAPSULA = new Map<string, 'cuerpo' | 'cabeza'>([
  ['cuerpo', 'cuerpo'], ['cabeza', 'cabeza'], ['tapa', 'cabeza'], ['tapon', 'cabeza'], ['casquete', 'cabeza'],
]);
const SABOR = new Set(['sabor', 'sabores', 'aroma', 'olor', 'aromatizado', 'aromatizados']);
const PARTES_OTRO_COLOR = new Set([
  'motas', 'moteado', 'moteados', 'moteada', 'moteadas', 'jaspeado', 'jaspeados', 'jaspeada', 'jaspeadas',
  'veteado', 'veteados', 'veteada', 'veteadas', 'puntos', 'manchas', 'bandas', 'capas', 'bicapa', 'tricapa',
  'nucleo', 'nucleos',
]);

function esMarcaje(t: string): boolean {
  return (
    t.startsWith('grabad') || t.startsWith('marcad') || t.startsWith('inscri') || t.startsWith('impres') ||
    t.startsWith('codific') || t.startsWith('rotulad') || t.startsWith('serigraf') || t === 'logotipo' ||
    t === 'xmarcax' || t === 'tinta' || t === 'tintas'
  );
}

// ───────────────────────── Limpieza y comillas ─────────────────────────

const ENTIDADES: Record<string, string> = {
  nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', apos: "'",
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
};

function decodificarEntidades(t: string): string {
  return t.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, c: string) => {
    if (c[0] === '#') {
      const n = c[1] === 'x' || c[1] === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    const r = ENTIDADES[c.toLowerCase()];
    return r === undefined ? m : r;
  });
}

/** Quita etiquetas HTML y marcas de markdown residuales. Sin retroceso. */
function limpiar(t: string): string {
  return decodificarEntidades(t.replace(/<\/?[a-zA-Z][^<>]{0,300}>/g, ' '))
    .replace(/\*{2,}|_{2,}|`+/g, ' ')
    .replace(/^\s*#{1,6}\s/gm, ' ');
}

const CIERRES: Record<string, string[]> = {
  '"': ['"', '”'],
  '“': ['”', '"'],
  '”': ['”', '"'],
  '„': ['“', '”'],
  '«': ['»'],
  '‘': ['’', "'"],
  "'": ["'", '’'],
};
const MAX_MARCA = 60;
const esLetraONumero = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Extrae lo que va entre comillas y devuelve el resto con un marcador. */
function extraerMarcas(texto: string, avisos: Set<string>): { marcas: string[]; resto: string } {
  const marcas: string[] = [];
  const out: string[] = [];
  let sinCerrar = false;
  const revisadoHasta: Record<string, number> = {};
  const n = texto.length;
  let i = 0;
  let inicio = 0; // desde dónde copiar texto normal
  while (i < n) {
    const ch = texto[i];
    const cierres = CIERRES[ch];
    if (cierres === undefined || (ch === "'" && esLetraONumero(texto[i - 1]))) { i++; continue; }
    let k = -1;
    const tope = Math.min(n - 1, i + MAX_MARCA + 1);
    // Lo ya mirado sin hallar cierre para este símbolo no se vuelve a mirar (evita coste cuadrático).
    for (let j = Math.max(i + 1, (revisadoHasta[ch] ?? -1) + 1); j <= tope; j++) {
      const cj = texto[j];
      if ((cj === cierres[0] || cj === cierres[1]) && !(ch === "'" && esLetraONumero(texto[j + 1]))) { k = j; break; }
    }
    if (k < 0) {
      revisadoHasta[ch] = Math.max(revisadoHasta[ch] ?? -1, tope);
      if (ch !== "'") sinCerrar = true;
      i++;
      continue;
    }
    out.push(texto.slice(inicio, i));
    const contenido = texto.slice(i + 1, k).replace(/\s+/g, ' ').trim();
    if (contenido) {
      if (!marcas.includes(contenido) && marcas.length < 30) marcas.push(contenido);
      out.push(' xmarcax ');
    } else out.push(' ');
    i = k + 1;
    inicio = i;
  }
  out.push(texto.slice(inicio));
  if (sinCerrar) avisos.add('comillas sin cerrar: puede faltar alguna marca de grabado');
  return { marcas, resto: out.join('') };
}

/** Palabras sin tildes ni mayúsculas; '|' marca un corte de frase. */
function tokenizar(texto: string): string[] {
  const plano = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const w: string[] = [];
  const re = /[a-z0-9]+|[.,;:\n\r]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plano)) !== null) {
    const t = m[0];
    if (t.length === 1 && !/[a-z0-9]/.test(t)) {
      if (w.length && w[w.length - 1] !== '|') w.push('|');
    } else w.push(t);
  }
  return w;
}

function negado(w: string[], i: number): boolean {
  let j = i - 1;
  let pasos = 0;
  while (j >= 0 && w[j] !== '|' && RELLENO.has(w[j]) && pasos < 8) { j--; pasos++; }
  return j >= 0 && w[j] !== '|' && NEGADORES.has(w[j]);
}

const esColorToken = (t: string): boolean => M_COLOR.has(t) || M_ADJ.has(t);

// ───────────────────────── Análisis ─────────────────────────

interface ColorHallado { texto: string; partes: Set<'cuerpo' | 'cabeza'> }

function analizarColores(w: string[], avisos: Set<string>): ColorHallado[] {
  const res: ColorHallado[] = [];
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    if (!esColorToken(t)) continue;
    // Sabor/aroma: «sabor naranja» no es el color del comprimido.
    let esSabor = false;
    for (let j = i - 1; j >= 0 && j >= i - 3 && w[j] !== '|'; j--) if (SABOR.has(w[j])) esSabor = true;
    if (esSabor) continue;
    // Color de la tinta o de la marca, no del comprimido.
    let esTinta = false;
    for (let j = i - 1; j >= 0 && j >= i - 4 && w[j] !== '|'; j--) if (esMarcaje(w[j])) esTinta = true;
    const partes: string[] = [];
    const base = M_COLOR.get(t);
    partes.push(base !== undefined ? base : (M_ADJ.get(t) as [string, string])[1]);
    let j = i + 1;
    let alternativa = false;
    for (let vueltas = 0; vueltas < 4; vueltas++) {
      let k = j;
      if (w[k] === 'muy' && M_MOD.has(w[k + 1])) k++;
      const adj = M_ADJ.get(w[k]);
      if (adj !== undefined) { partes.push(adj[0]); j = k + 1; continue; }
      const mod = M_MOD.get(w[k]);
      if (mod !== undefined) { partes.push(mod); j = k + 1; continue; }
      break;
    }
    // «blanco o casi blanco», «blanco o ligeramente amarillento», «blanco o rosa»
    if (w[j] === 'o') {
      let k = j + 1;
      const intens = w[k] === 'casi' || w[k] === 'ligeramente' ? w[k] : null;
      if (intens) k++;
      if (esColorToken(w[k])) {
        const c2 = M_COLOR.get(w[k]) ?? (M_ADJ.get(w[k]) as [string, string])[1];
        partes.push('o');
        if (intens) partes.push(intens);
        partes.push(c2);
        j = k + 1;
        alternativa = true;
        // modificadores del segundo color
        while (M_MOD.has(w[j])) { partes.push(M_MOD.get(w[j]) as string); j++; }
      }
    }
    const texto = partes.join(' ');
    if (esTinta) {
      avisos.add(`color de la tinta o de la marca ignorado: ${texto}`);
      i = j - 1;
      continue;
    }
    if (alternativa) avisos.add(`color ambiguo («${texto}»): comprobar con la foto o el envase`);
    const parte = new Set<'cuerpo' | 'cabeza'>();
    for (let q = i - 1; q >= 0 && q >= i - 4 && w[q] !== '|' && !esColorToken(w[q]); q--) {
      const p = PARTES_CAPSULA.get(w[q]);
      if (p) parte.add(p);
    }
    res.push({ texto, partes: parte });
    i = j - 1;
  }
  return res;
}

function carasDe(w: string[], i: number): Ranura | null {
  if (i >= 2 && SUPERFICIES.has(w[i - 1])) {
    if (['ambas', 'ambos', 'dos'].includes(w[i - 2])) return 'ambas_caras';
    if (['una', 'un', 'otra', 'otro'].includes(w[i - 2])) return 'una_cara';
  }
  for (let k = i + 1; k <= i + 8 && k < w.length; k++) {
    const t = w[k];
    if (t === '|' || esMarcaje(t) || t === 'sin') break;
    const cerca = (): boolean => w.slice(k + 1, k + 4).some((x) => SUPERFICIES.has(x));
    if (['ambas', 'ambos', 'dos', 'cada'].includes(t) && cerca()) return 'ambas_caras';
    if (t === 'otra' || t === 'otro') return 'una_cara';
    if (['una', 'un'].includes(t) && cerca()) return 'una_cara';
  }
  return null;
}

function esCabezaRanura(w: string[], i: number): boolean {
  const t = w[i];
  if (t.startsWith('ranur') || t.startsWith('birranur') || t === 'surco' || t === 'surcos' || t === 'muesca' || t === 'muescas') return true;
  return (t === 'linea' || t === 'barra') && w[i + 1] === 'de' && ROTURA.has(w[i + 2]);
}

function analizarRanura(w: string[], avisos: Set<string>): Ranura {
  let hayAfirmativa = false;
  let hayNegada = false;
  let mejor: Ranura | null = null;
  for (let i = 0; i < w.length; i++) {
    if (!esCabezaRanura(w, i)) continue;
    if (negado(w, i)) { hayNegada = true; continue; }
    hayAfirmativa = true;
    const c = carasDe(w, i);
    if (c === 'ambas_caras' || (c === 'una_cara' && mejor !== 'ambas_caras')) mejor = c;
  }
  if (hayAfirmativa) {
    avisos.add(AVISO_RANURA);
    if (mejor === null) avisos.add('se menciona ranura pero no se indica en cuántas caras');
    if (hayNegada) avisos.add('la ranura aparece con y sin negación: revisar el texto original');
    return mejor ?? 'sin_dato';
  }
  return hayNegada ? 'ninguna' : 'sin_dato';
}

function analizarForma(w: string[], avisos: Set<string>): string | null {
  const contorno: string[] = [];
  const perfil: string[] = [];
  const anadir = (l: string[], v: string): void => { if (!l.includes(v)) l.push(v); };
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    if (w[i - 1] === 'de' && w[i - 2] === 'forma' && TIPOS.get(t) === 'capsula') { anadir(contorno, 'capsulado'); continue; }
    const c = M_CONTORNO.get(t);
    const p = M_PERFIL.get(t);
    if (c === undefined && p === undefined) continue;
    if (negado(w, i)) continue;
    if (c !== undefined) anadir(contorno, c);
    else if (p !== undefined) anadir(perfil, p);
  }
  if (contorno.length > 1) avisos.add(`varias formas mencionadas: ${contorno.join(', ')}`);
  const todas = [...contorno, ...perfil];
  return todas.length ? todas.join(', ') : null;
}

function analizarTipo(w: string[], avisos: Set<string>): TipoForma | null {
  const vistos: TipoForma[] = [];
  let otro = false;
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    const tp = TIPOS.get(t);
    if (tp !== undefined) {
      if ((w[i - 1] === 'de' && w[i - 2] === 'forma') || w[i - 1] === 'tipo') continue;
      if (!vistos.includes(tp)) vistos.push(tp);
    } else if (OTROS_TIPOS.has(t)) otro = true;
  }
  if (vistos.length > 1) avisos.add(`se mencionan varios tipos (${vistos.join(', ')}): se propone el primero`);
  if (vistos.length) return vistos[0];
  return otro ? 'otro' : null;
}

function analizarRecubierto(w: string[], avisos: Set<string>): boolean | null {
  let si = false;
  let no = false;
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    const es = t.startsWith('recubiert') || t.startsWith('cubiert') || t === 'recubrimiento' || t === 'recubrir' ||
      t === 'pelicular' || t === 'peliculares' || t.startsWith('peliculad');
    if (!es) continue;
    if (negado(w, i)) no = true; else si = true;
  }
  if (si && no) { avisos.add('recubrimiento mencionado con y sin negación: revisar el texto original'); return null; }
  if (si) return true;
  return no ? false : null;
}

const vacia = (textoOriginal: string, avisos: string[]): PropuestaDescripcion => ({
  colores: [], forma: null, ranura: 'sin_dato', ranuraDivisible: 'desconocido', marcas: [],
  tipo: null, recubierto: null, avisos, textoOriginal,
});

export function analizarDescripcion(texto: string): PropuestaDescripcion {
  const original = typeof texto === 'string' ? texto : '';
  if (!original.trim()) return vacia(original, [AVISO_SIN_DESCRIPCION]);

  const avisos = new Set<string>();
  const { marcas, resto } = extraerMarcas(limpiar(original), avisos);
  const w = tokenizar(resto);

  const hallados = analizarColores(w, avisos);
  const colores: string[] = [];
  for (const h of hallados) if (!colores.includes(h.texto)) colores.push(h.texto);

  const ranura = analizarRanura(w, avisos);
  const forma = analizarForma(w, avisos);
  const tipo = analizarTipo(w, avisos);
  const recubierto = analizarRecubierto(w, avisos);

  // Colores por partes (cápsulas) y colores múltiples: se avisa, no se simplifica.
  const conParte = hallados.filter((h) => h.partes.size > 0);
  const distintosConParte = new Set(conParte.map((h) => h.texto));
  if (distintosConParte.size >= 2) {
    avisos.add('cápsula con colores por partes: ' +
      conParte.map((h) => `${[...h.partes].sort().join(' y ')} ${h.texto}`).join('; '));
  } else if (conParte.length > 0) {
    const union = new Set<string>();
    for (const h of conParte) for (const p of h.partes) union.add(p);
    if (union.size < 2 && colores.length >= 1 && distintosConParte.size === 1 && colores.length === 1) {
      avisos.add(`el color se indica solo para ${[...union][0] === 'cuerpo' ? 'el cuerpo' : 'la cabeza'}: comprobar el resto de la cápsula`);
    }
  }
  if (colores.length >= 2 && distintosConParte.size < 2) {
    avisos.add(`varios colores mencionados (${colores.join('; ')}): comprobar a qué parte corresponde cada uno`);
  }
  if (w.some((t) => PARTES_OTRO_COLOR.has(t))) {
    avisos.add('puede tener motas, capas o núcleo de otro color: leer el texto original');
  }

  const hayDatos =
    colores.length > 0 || forma !== null || ranura !== 'sin_dato' || marcas.length > 0 || tipo !== null || recubierto !== null;
  if (!hayDatos) return vacia(original, [...avisos, AVISO_SIN_DESCRIPCION]);

  if (colores.length === 0) avisos.add('color no indicado en el texto');
  if (forma === null) avisos.add('forma no indicada en el texto');

  return {
    colores, forma, ranura, ranuraDivisible: 'desconocido', marcas, tipo, recubierto,
    avisos: [...avisos], textoOriginal: original,
  };
}

// ───────────────────────── Resumen para la etiqueta ─────────────────────────

const femenino = (s: string): string =>
  s.split(' ').map((x) => (x === 'o' || x === 'casi' || x.length < 3 ? x : x.replace(/o$/, 'a'))).join(' ');

export function resumenDescripcion(p: PropuestaDescripcion): string {
  if (!p || !Array.isArray(p.colores)) return '';
  if (p.colores.length === 0 && !p.forma) return '';
  const fem = p.tipo === 'capsula' || p.tipo === 'gragea';
  const ad = (s: string): string => (fem ? femenino(s) : s);
  const nombre = p.tipo === 'capsula' ? 'Cápsula' : p.tipo === 'comprimido' ? 'Comprimido' : p.tipo === 'gragea' ? 'Gragea' : '';
  let color = '';
  if (p.colores.length === 2 && p.tipo === 'capsula') color = `bicolor ${ad(p.colores[0])} y ${ad(p.colores[1])}`;
  else color = p.colores.map(ad).join(' y ');
  const primero = [nombre, color].filter(Boolean).join(' ');
  const forma = p.forma ? p.forma.split(', ').map(ad).join(', ') : '';
  const ranurado =
    p.tipo !== 'capsula' &&
    (p.ranura === 'una_cara' || p.ranura === 'ambas_caras' || p.avisos.includes(AVISO_RANURA))
      ? 'ranurado'
      : '';
  const frase = [primero, forma, ranurado].filter(Boolean).join(', ');
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}
