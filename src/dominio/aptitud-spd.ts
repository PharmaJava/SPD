/**
 * Aptitud de un medicamento para el Sistema Personalizado de Dosificación
 * (SPD) y idoneidad de un paciente para el servicio.
 *
 * Porte a TypeScript del motor `calculos/spd.js` de conveniodefarmacia.com
 * (proyecto hermano: se portó, NO se comparte código). Sólo español.
 *
 * FUNCIONES PURAS: sin disco, red ni interfaz.
 *
 * ⚠️ El resultado es una PROPUESTA del motor (`decidePor: 'motor'`). El
 * farmacéutico puede corregirla y su decisión manda siempre sobre la del
 * motor (`spd_decidido_por`). Si el motor no puede decidir devuelve `null`:
 * NUNCA adivina; ante la duda se pregunta al farmacéutico.
 */

export type EstadoAptitud = 'apto' | 'precaucion' | 'no_apto';

export interface Clasificacion {
  estado: EstadoAptitud;
  /** Clasifica el motivo (forma, dosis_variable, citotoxico, margen_estrecho…). */
  categoria: string;
  motivo: string;
  fuente: string;
  /** Siempre 'motor': es una propuesta que el farmacéutico puede corregir. */
  decidePor: 'motor';
}

export interface EntradaMedicamento {
  nombre?: string;
  /** Forma farmacéutica tal cual viene de CIMA (p. ej. «COMPRIMIDO RECUBIERTO»). */
  formaFarmaceutica?: string;
  principioActivo?: string;
}

const FUENTE_FORMA = 'Regla de forma farmacéutica (criterios SEFAC)';
const FUENTE_DATASET = 'Dataset revisado (criterios SEFAC + ficha técnica AEMPS)';

/** Minúsculas, sin tildes y con espacios colapsados. Vacío si no es texto. */
export function normalizar(texto: unknown): string {
  if (!texto || typeof texto !== 'string') return '';
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/* ─── Formas farmacéuticas NO aptas para SPD ────────────────────────────────
 * Sólo se emblistan formas SÓLIDAS ORALES (comprimidos y cápsulas) estables.
 * Cualquier otra forma queda fuera. Se compara contra texto YA normalizado
 * (sin tildes), por eso los patrones no llevan acentos.
 *
 * ⚠️ Gana la PRIMERA regla que case: el orden es parte de la regla. La vía
 * oftálmica/ótica va ANTES que la de líquidos: con la de líquidos delante,
 * «gotas oftálmicas» salía como «forma líquida oral». El `estado` era el
 * mismo, pero el motivo que lee el farmacéutico decía algo falso.
 *
 * ⚠️ Los sufijos de liberación modificada admitidos son `sr`, `mr`, `xl` y
 * `xr`. `la` y `cr` NO: «la» es una palabra española corriente y con `\b`
 * casaría dentro de cualquier frase. Un falso positivo aquí deja fuera del
 * blíster un fármaco que sí se podía emblistar.
 */
interface ReglaForma { pat: RegExp; estado?: EstadoAptitud; motivo: string }

export const FORMAS_NO_APTAS: ReglaForma[] = [
  { pat: /efervescente/,
    motivo: 'Comprimido efervescente: muy sensible a la humedad, debe conservarse en su tubo original.' },
  { pat: /sublingual|cafinitrina|vernies/,
    motivo: 'Vía sublingual: pierde eficacia y estabilidad fuera de su envase.' },
  { pat: /bucodispersable|buodispersable|flas\b|liotab|liofiliz|orodispersible|\bodt\b|\bmelt\b|dispersable|soluble/,
    motivo: 'Comprimido bucodispersable/liofilizado: se deshace con la humedad.' },
  { pat: /sobres?\b|granulado|polvo para|\bpolvo\b/,
    motivo: 'Sobres/granulado/polvo: no es forma sólida unitaria emblistable.' },
  { pat: /colirio|oftalmic|\botic|nasal|spray|esteril|bano ocular|banos oculares/,
    motivo: 'Vía oftálmica/ótica/nasal o estéril: no emblistable.' },
  { pat: /jarabe|solucion|suspension|gotas|elixir|emulsion/,
    motivo: 'Forma líquida oral: no emblistable.' },
  { pat: /inhalad|aerosol|turbuhaler|inhalet|respimat|accuhaler|nebuliz|evohaler/,
    motivo: 'Vía inhalada: no emblistable.' },
  { pat: /parche|transdermic/,
    motivo: 'Parche transdérmico: no emblistable.' },
  { pat: /crema|pomada|gel\b|unguento|locion|topic/,
    motivo: 'Forma tópica: no emblistable.' },
  { pat: /supositorio|ovulo|vaginal|rectal/,
    motivo: 'Vía rectal/vaginal: no emblistable.' },
  { pat: /inyectab|vial|ampolla|jeringa|pluma|subcutane|intramuscular|insulina/,
    motivo: 'Vía inyectable / conservación especial: no emblistable.' },
  { pat: /refriger|nevera|termolabil/,
    motivo: 'Termolábil: requiere conservación en nevera (2-8 ºC); no se emblista.' },
  { pat: /liberacion (modificada|prolongada|retardada|sostenida|controlada)|\bretard\b|\boros\b|\bmatrix\b|\bsr\b|\bmr\b|\bxl\b|\bxr\b/,
    estado: 'precaucion',
    motivo: 'Liberación modificada/prolongada: no se puede fraccionar y puede quedar excluida; valora la estabilidad (criterios SEFAC).' },
  { pat: /masticable/,
    estado: 'precaucion',
    motivo: 'Comprimido masticable: forma de administración especial; valorar caso a caso.' },
];

// ─── Dataset revisado por principio activo ───────────────────────────────────
interface FichaPA { estado: EstadoAptitud; categoria: string; motivo: string }

const F = (estado: EstadoAptitud, categoria: string, motivo: string): FichaPA => ({ estado, categoria, motivo });

export const DATOS_SPD: Record<string, FichaPA> = {
  // ── NO APTOS ──
  'acenocumarol': F('no_apto', 'dosis_variable', 'La dosis se ajusta según el INR y cambia con frecuencia: no debe emblistarse en pauta fija.'),
  'warfarina': F('no_apto', 'dosis_variable', 'Dosis variable según el INR: no debe emblistarse en pauta fija.'),
  'metotrexato': F('no_apto', 'citotoxico', 'Citotóxico (pauta semanal y manipulación de riesgo): no se reacondiciona.'),
  'capecitabina': F('no_apto', 'citotoxico', 'Citotóxico oral: no se reacondiciona.'),
  'hidroxiurea': F('no_apto', 'citotoxico', 'Citotóxico oral: no se reacondiciona.'),
  'nitroglicerina': F('no_apto', 'forma', 'Suele usarse sublingual y es muy inestable fuera del envase.'),
  // ── PRECAUCIÓN ──
  'levotiroxina': F('precaucion', 'margen_estrecho', 'Margen terapéutico estrecho y sensible a luz/humedad: emblistar solo con dosis estable y validación, protegido de la luz.'),
  'digoxina': F('precaucion', 'margen_estrecho', 'Margen terapéutico estrecho: emblistar solo con dosis estable.'),
  'litio': F('precaucion', 'margen_estrecho', 'Margen terapéutico estrecho (litemias): valorar antes de emblistar.'),
  'alendronato': F('precaucion', 'administracion_especial', 'Apto físicamente, pero administración especial (en ayunas, de pie 30 min, con un vaso de agua): valorar.'),
  'risedronato': F('precaucion', 'administracion_especial', 'Administración especial (ayunas, de pie): valorar antes de incluirlo.'),
  'omeprazol': F('precaucion', 'sensible_humedad', 'Cápsula/granulado gastrorresistente: no abrir ni partir y proteger de la humedad.'),
  'esomeprazol': F('precaucion', 'sensible_humedad', 'Granulado gastrorresistente: no partir; proteger de la humedad.'),
  'pantoprazol': F('precaucion', 'sensible_humedad', 'Comprimido gastrorresistente: no partir.'),
  'lansoprazol': F('precaucion', 'sensible_humedad', 'Cápsula gastrorresistente: no abrir ni partir.'),
  'acido acetilsalicilico': F('precaucion', 'cubierta_especial', 'Si es gastrorresistente (Adiro), no partir; emblistar entero.'),
  'anticonceptivo': F('precaucion', 'secuencia', 'Los anticonceptivos tienen orden/secuencia: valorar antes de reacondicionar.'),
  // ── APTOS (formas sólidas orales estables, tratamiento crónico) ──
  'metformina': F('apto', 'estable', 'Comprimido sólido oral estable: apto para SPD.'),
  'enalapril': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'ramipril': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'amlodipino': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'bisoprolol': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'atorvastatina': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'simvastatina': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'rosuvastatina': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'paracetamol': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'metamizol': F('apto', 'estable', 'Cápsula/comprimido sólido oral: apto.'),
  'amlodipino/valsartan': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'losartan': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'furosemida': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'gliclazida': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'sertralina': F('apto', 'estable', 'Comprimido sólido oral estable: apto.'),
  'lorazepam': F('apto', 'estable', 'Comprimido sólido oral: apto (estupefaciente/psicótropo: registro aparte).'),
};

/** Alias marca/variante → clave del dataset. */
export const ALIAS_SPD: Record<string, string> = {
  'sintrom': 'acenocumarol',
  'aldocumar': 'warfarina',
  'eutirox': 'levotiroxina', 'levothroid': 'levotiroxina',
  'adiro': 'acido acetilsalicilico', 'aas': 'acido acetilsalicilico',
  'cafinitrina': 'nitroglicerina', 'vernies': 'nitroglicerina', 'solinitrina': 'nitroglicerina',
  'fosamax': 'alendronato',
  'losec': 'omeprazol', 'omapren': 'omeprazol',
  'dianben': 'metformina',
  'zarator': 'atorvastatina', 'cardyl': 'atorvastatina',
  'orfidal': 'lorazepam', 'idalprem': 'lorazepam',
  'plenur': 'litio', 'carbonato de litio': 'litio',
  'metotrexato oral': 'metotrexato',
};

/** Alias más cortos que esto sólo casan EXACTOS (ver `buscarEnDataset`). */
const LONGITUD_MIN_SUBCADENA = 4;

function ficha(clave: string): Clasificacion {
  const d = DATOS_SPD[clave];
  return { estado: d.estado, categoria: d.categoria, motivo: d.motivo, fuente: FUENTE_DATASET, decidePor: 'motor' };
}

/**
 * Clasifica por palabras clave de FORMA farmacéutica (o del nombre, que a
 * veces la lleva: «Adiro efervescente»). Devuelve null si ninguna regla casa:
 * eso NO significa «apto», significa «esta regla no decide».
 */
export function clasificarPorForma(textoLibre: string): Clasificacion | null {
  const n = normalizar(textoLibre);
  if (!n) return null;
  for (const f of FORMAS_NO_APTAS) {
    if (f.pat.test(n)) {
      return { estado: f.estado ?? 'no_apto', categoria: 'forma', motivo: f.motivo, fuente: FUENTE_FORMA, decidePor: 'motor' };
    }
  }
  return null;
}

/**
 * Busca en el dataset por principio activo, alias o nombre.
 *
 * ⚠️ Coincidencia EXACTA primero y por subcadena después (las marcas llevan
 * apellidos: «Sintrom 4 mg»). Gana la primera clave del dataset que esté
 * contenida en el texto: el orden del dataset es parte de la regla.
 *
 * ⚠️ Mejora sobre el original: un alias de menos de 4 letras («aas») sólo
 * casa EXACTO. Por subcadena, «aas» estaría dentro de cualquier nombre que lo
 * contenga y propondría «ácido acetilsalicílico» para otro medicamento.
 */
function buscarEnDataset(texto: string): Clasificacion | null {
  const n = normalizar(texto);
  if (!n) return null;
  // Object.hasOwn: «constructor» o «__proto__» no son claves del dataset (devolverían una ficha vacía).
  if (Object.hasOwn(DATOS_SPD, n)) return ficha(n);
  if (Object.hasOwn(ALIAS_SPD, n) && Object.hasOwn(DATOS_SPD, ALIAS_SPD[n])) return ficha(ALIAS_SPD[n]);
  // Por subcadena gana la clave MÁS LARGA que case, y a igualdad la primera del dataset:
  // «esomeprazol» contiene «omeprazol» y no debe heredar su ficha.
  let mejor: string | null = null;
  for (const k of Object.keys(DATOS_SPD)) {
    if (n.includes(k) && (mejor === null || k.length > mejor.length)) mejor = k;
  }
  if (mejor) return ficha(mejor);
  for (const a of Object.keys(ALIAS_SPD)) {
    if (a.length >= LONGITUD_MIN_SUBCADENA && n.includes(a)) return ficha(ALIAS_SPD[a]);
  }
  return null;
}

/**
 * Clasifica un medicamento para SPD. Orden (⚠️ importa):
 *  1) forma farmacéutica de CIMA; 2) forma que aparezca en el nombre
 *  («manda la forma»); 3) dataset por principio activo; 4) dataset por nombre.
 * Si nada decide devuelve null → el farmacéutico decide. Nunca adivina.
 */
export function clasificarMedicamento(entrada: EntradaMedicamento): Clasificacion | null {
  const e = entrada ?? {};
  const porForma = clasificarPorForma(e.formaFarmaceutica ?? '') ?? clasificarPorForma(e.nombre ?? '');
  if (porForma) return porForma;
  return buscarEnDataset(e.principioActivo ?? '') ?? buscarEnDataset(e.nombre ?? '');
}

// ─── Idoneidad del paciente ──────────────────────────────────────────────────
export interface PacienteSPD {
  numFarmacos?: number | string;
  tomasDia?: number | string;
  olvidos?: 'nunca' | 'aveces' | 'frecuente';
  autonomia?: 'autonomo' | 'ayuda' | 'dependiente';
  deterioroCognitivo?: boolean;
  dificultadManipulacion?: boolean;
  pautaCompleja?: boolean;
  viveSolo?: boolean;
  variosPrescriptores?: boolean;
}

export interface Idoneidad {
  puntuacion: number;
  nivel: 'alta' | 'media' | 'baja';
  recomendacion: string;
  factores: string[];
  decidePor: 'motor';
}

function entero(v: unknown): number {
  return parseInt(String(v ?? ''), 10) || 0;
}

/**
 * Puntúa si un paciente es candidato a SPD. Es una orientación para la
 * entrevista, no una decisión: el farmacéutico la confirma o la corrige.
 */
export function evaluarIdoneidad(paciente: PacienteSPD): Idoneidad {
  const p = paciente ?? {};
  let pts = 0;
  const factores: string[] = [];
  const nf = entero(p.numFarmacos);
  const td = entero(p.tomasDia);

  if (nf >= 10) { pts += 3; factores.push('Polimedicación elevada (≥10 fármacos).'); }
  else if (nf >= 5) { pts += 2; factores.push('Polimedicación (≥5 fármacos).'); }
  else if (nf >= 3) { pts += 1; factores.push('Varios medicamentos crónicos.'); }

  if (td >= 4) { pts += 2; factores.push('Muchas tomas diarias (≥4).'); }
  else if (td >= 3) { pts += 1; factores.push('3 o más tomas al día.'); }

  if (p.olvidos === 'frecuente') { pts += 3; factores.push('Olvidos frecuentes de la medicación.'); }
  else if (p.olvidos === 'aveces') { pts += 1; factores.push('Olvidos ocasionales.'); }

  if (p.autonomia === 'dependiente') { pts += 2; factores.push('Dependiente para gestionar su medicación.'); }
  else if (p.autonomia === 'ayuda') { pts += 1; factores.push('Necesita ayuda para gestionar la medicación.'); }

  if (p.deterioroCognitivo) { pts += 2; factores.push('Deterioro cognitivo con dificultad para la toma.'); }
  if (p.dificultadManipulacion) { pts += 1; factores.push('Dificultad para manipular o ver la medicación (prensil/visual).'); }
  if (p.pautaCompleja) { pts += 1; factores.push('Pauta posológica compleja.'); }
  if (p.viveSolo) { pts += 1; factores.push('Vive solo/a, sin apoyo continuo.'); }
  if (p.variosPrescriptores) { pts += 1; factores.push('Varios médicos prescriptores (riesgo de duplicidades).'); }

  let nivel: Idoneidad['nivel'];
  let recomendacion: string;
  if (pts >= 6) {
    nivel = 'alta';
    recomendacion = 'Candidato/a claro/a al SPD. El reacondicionamiento puede mejorar mucho la adherencia y la seguridad. Ofrece el servicio y valora la revisión del tratamiento.';
  } else if (pts >= 3) {
    nivel = 'media';
    recomendacion = 'Perfil a valorar. El SPD puede aportar beneficio; conviene una entrevista para confirmar adherencia y autonomía antes de iniciarlo.';
  } else {
    nivel = 'baja';
    recomendacion = 'Prioridad baja por ahora. El paciente parece gestionar bien su medicación; reevalúa si cambian sus circunstancias o su número de fármacos.';
  }
  return { puntuacion: pts, nivel, recomendacion, factores, decidePor: 'motor' };
}
