<script lang="ts">
  /**
   * Vista previa de un documento imprimible a tamaño real, en un iframe sin JavaScript.
   * `sandbox="allow-same-origin"` SIN `allow-scripts`: el contenido no puede ejecutar nada,
   * pero esta pantalla sí puede medirlo para ajustar el marco.
   */
  import { spd } from '../../api.ts';
  import type { VistaImprimible } from '../../../servicios/api.ts';
  import '../../estilos/u2.css';
  import Nota from './Nota.svelte';

  let { titulo, vista, nombreArchivo, impresora = null, anchoMm, altoMm, motivoNoImprimir = '' }: {
    titulo: string; vista: VistaImprimible; nombreArchivo: string; impresora?: string | null; anchoMm?: number; altoMm?: number;
    /** Explicación amable cuando no se puede imprimir la versión definitiva. */
    motivoNoImprimir?: string;
  } = $props();

  let marco: HTMLIFrameElement | undefined = $state();
  let ancho = $state(794); let alto = $state(500); let escala = $state(1);
  let envoltorio: HTMLDivElement | undefined = $state();
  let mensajeEstado = $state(''); let tipoEstado = $state<'ok' | 'atencion'>('ok'); let ocupado = $state(false);

  function medir() {
    const doc = marco?.contentDocument; if (!doc) return;
    const raiz = doc.body?.firstElementChild as HTMLElement | null;
    const w = Math.max(raiz?.offsetWidth || 0, 0); const h = Math.max(raiz?.offsetHeight || 0, doc.documentElement.scrollHeight);
    ancho = w > 120 ? Math.ceil(w + 2 * (raiz?.offsetLeft ?? 0)) : 794;
    alto = Math.max(h, 120);
    const disp = (envoltorio?.clientWidth ?? ancho) - 34;
    escala = ancho > disp && disp > 200 ? disp / ancho : 1;
  }
  async function imprimir() {
    ocupado = true; mensajeEstado = '';
    const r = await spd.imprimirHtml(vista.html, { impresora: impresora ?? undefined, anchoMm, altoMm, silenciosa: false });
    ocupado = false;
    tipoEstado = r.ok ? 'ok' : 'atencion';
    mensajeEstado = r.ok ? 'Enviado a la impresora.' : `No se pudo imprimir: ${r.error}`;
  }
  async function pdf() {
    ocupado = true; mensajeEstado = '';
    const r = await spd.exportarPdf(vista.html, nombreArchivo, { anchoMm, altoMm });
    ocupado = false;
    if (!r.ok) { tipoEstado = 'atencion'; mensajeEstado = `No se pudo guardar el PDF: ${r.error}`; }
    else if (r.datos) { tipoEstado = 'ok'; mensajeEstado = `PDF guardado en ${r.datos.ruta}`; }
  }
  const puedeImprimir = $derived(vista.imprimible);
</script>

<div class="apilado" bind:this={envoltorio}>
  <div class="fila">
    <h3 class="sin-margen">{titulo}</h3><span class="espacio"></span>
    <button class="btn" type="button" onclick={pdf} disabled={ocupado || !puedeImprimir}>Guardar PDF</button>
    <button class="btn principal" type="button" onclick={imprimir} disabled={ocupado || !puedeImprimir} data-prueba="imprimir">Imprimir</button>
  </div>
  {#if !vista.imprimible}
    <Nota gravedad="atencion">
      <strong>{motivoNoImprimir || 'Todavía no se puede imprimir esta versión.'}</strong>
      {#if vista.problemas.length}<ul class="sin-margen">{#each vista.problemas as p (p)}<li>{p}</li>{/each}</ul>{/if}
      {#if vista.faltan.length}<div>Falta: {vista.faltan.join(', ')}.</div>{/if}
    </Nota>
  {/if}
  {#if mensajeEstado}<Nota gravedad={tipoEstado}>{mensajeEstado}</Nota>{/if}
  <div class="vista-marco">
    <div style="width:{ancho * escala}px;height:{alto * escala}px;flex:none">
      <iframe bind:this={marco} title={titulo} sandbox="allow-same-origin" srcdoc={vista.html} onload={medir}
        style="width:{ancho}px;height:{alto}px;transform:scale({escala});transform-origin:0 0"></iframe>
    </div>
  </div>
</div>
