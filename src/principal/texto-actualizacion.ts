/** Notas de la versión para un diálogo del sistema: texto plano, recortado. */
export function notasParaDialogo(notas: string, max = 1200): string {
  const t = String(notas ?? '').trim();
  if (!t) return 'Esta versión no trae notas.';
  return 'Novedades:\n' + (t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t);
}
