<script lang="ts">
  /**
   * Impresión de la etiqueta con tres modos (rollo, folio con hoja de etiquetas, ajustable).
   * Lo que se ve en la vista previa es EXACTAMENTE la página que se imprime y la que se guarda en PDF:
   * el HTML lo compone el dominio (etiquetas-hoja.ts) y el tamaño de página viaja con él.
   */
  import { spd } from '../../api.ts';
  import type { Ajustes, VistaImprimible } from '../../../servicios/api.ts';
  import { componerImpresion, hojaDePrueba, normalizarConfigImpresion, tamanoDeEtiqueta, TAM_ETIQUETA_POR_DEFECTO, COPIAS_MAX } from '../../../dominio/etiquetas-hoja.ts';
  import type { ConfigImpresion } from '../../../dominio/etiquetas-hoja.ts';
  import ConfigImpresionEditor from '../../componentes/ConfigImpresion.svelte';
  import Campo from '../../componentes/Campo.svelte';
  import VistaPrevia from './VistaPrevia.svelte';
  import Nota from './Nota.svelte';

  let { preparacionId, nombreArchivo, ajustes, motivoNoImprimir = '' }: {
    preparacionId: number; nombreArchivo: string; ajustes: Ajustes | null; motivoNoImprimir?: string;
  } = $props();

  const guardada = (): ConfigImpresion => normalizarConfigImpresion(ajustes?.impresionEtiquetas);
  let config = $state<ConfigImpresion>(guardada());
  let copias = $state(1);
  let cargada = false;
  $effect(() => { if (ajustes && !cargada) { config = guardada(); cargada = true; } });

  // La etiqueta se pide al servicio con el tamaño que necesita el modo (rollo o celda de la hoja); se guarda por tamaño.
  let porTamano = $state<Record<string, VistaImprimible>>({});
  let pidiendo = $state(false); let errorVista = $state(''); let fallida = $state('');
  const tam = $derived(tamanoDeEtiqueta(config));
  const estandar = $derived(Math.abs(tam.anchoMm - TAM_ETIQUETA_POR_DEFECTO.anchoMm) < 0.01 && Math.abs(tam.altoMm - TAM_ETIQUETA_POR_DEFECTO.altoMm) < 0.01);
  const clave = $derived(`${tam.anchoMm}x${tam.altoMm}`);
  const tamValido = $derived(Number.isFinite(tam.anchoMm) && Number.isFinite(tam.altoMm) && tam.anchoMm >= 20 && tam.anchoMm <= 300 && tam.altoMm >= 20 && tam.altoMm <= 300);
  $effect(() => {
    const k = clave; const t = tam; const e = estandar;
    if (!tamValido || porTamano[k] || pidiendo || fallida === k) return;
    pidiendo = true; errorVista = '';
    spd.vistaEtiqueta(preparacionId, e ? undefined : t).then((r) => {
      pidiendo = false;
      if (r.ok) porTamano = { ...porTamano, [k]: r.datos }; else { errorVista = r.error; fallida = k; }
    });
  });

  const base = $derived(tamValido ? porTamano[clave] : undefined);
  const copiasOk = $derived(Number.isInteger(copias) && copias >= 1 && copias <= COPIAS_MAX);
  const compuesta = $derived(base ? componerImpresion(base.html, config, config.modo, copiasOk ? copias : 1) : null);
  const vista = $derived<VistaImprimible | null>(base && compuesta ? {
    html: compuesta.html,
    imprimible: base.imprimible && compuesta.problemas.length === 0 && copiasOk,
    problemas: [...base.problemas, ...compuesta.problemas, ...(copiasOk ? [] : [`El número de copias debe ser un entero entre 1 y ${COPIAS_MAX}.`])],
    faltan: base.faltan,
  } : null);

  let prueba = $state(false);
  const hojaPrueba = $derived(prueba ? hojaDePrueba($state.snapshot(config)) : null);
  let nota = $state('');

  async function guardarPredeterminado() {
    const r = await spd.guardarAjustes({ impresionEtiquetas: $state.snapshot(config) });
    nota = r.ok ? 'Guardado como predeterminado de la farmacia para la impresora de etiquetas.' : `No se pudo guardar: ${r.error}`;
  }
  /** Tras imprimir en hoja: la siguiente etiqueta libre pasa a ser la que toca (se recuerda si el rol puede guardar ajustes). */
  async function alImprimir() {
    if (config.modo !== 'hoja' || !compuesta?.siguiente) return;
    config.hoja.primeraLibre = { ...compuesta.siguiente };
    const r = await spd.guardarAjustes({ impresionEtiquetas: { ...guardada(), hoja: $state.snapshot(config.hoja) } });
    nota = `La siguiente etiqueta libre es la de la fila ${config.hoja.primeraLibre.fila}, columna ${config.hoja.primeraLibre.columna}.` + (r.ok ? ' Queda recordado.' : ' (No se pudo recordar: anótalo para la próxima vez.)');
  }
</script>

{#snippet controles()}
  <div class="apilado" data-prueba="impresion-etiqueta">
    <ConfigImpresionEditor bind:config rapido />
    {#if config.modo !== 'ajustable'}
      <Campo etiqueta="Copias" tipo="numero" bind:valor={copias} min={1} max={COPIAS_MAX} step="1" pequeno id="copias-etiqueta" ayuda={config.modo === 'hoja' ? 'Cada copia ocupa una etiqueta libre; si no caben, se sigue en una hoja nueva.' : 'Una página por copia.'} />
    {/if}
    <div class="fila">
      <button class="btn" type="button" onclick={() => (prueba = !prueba)} data-prueba="hoja-prueba">{prueba ? 'Ocultar la hoja de prueba' : 'Hoja de prueba'}</button>
      <button class="btn" type="button" onclick={guardarPredeterminado} data-prueba="guardar-modo">Guardar como predeterminado</button>
    </div>
    {#if compuesta && compuesta.paginas > 0}
      <p class="suave sin-margen" data-prueba="resumen-impresion">{compuesta.etiquetas} etiqueta{compuesta.etiquetas === 1 ? '' : 's'} · {compuesta.paginas} página{compuesta.paginas === 1 ? '' : 's'} · papel {compuesta.anchoMm.toString().replace('.', ',')}×{compuesta.altoMm.toString().replace('.', ',')} mm{config.modo === 'hoja' && compuesta.siguiente ? ` · después, primera libre: fila ${compuesta.siguiente.fila}, columna ${compuesta.siguiente.columna}` : ''}</p>
    {/if}
    {#if nota}<Nota gravedad="info">{nota}</Nota>{/if}
  </div>
{/snippet}

{#if errorVista}<Nota gravedad="bloqueo">{errorVista}</Nota>{/if}
{#if !vista && !errorVista}<div class="cargando-linea">Preparando la vista previa…</div>{/if}
{#if vista && compuesta}
  {#key preparacionId}
    <VistaPrevia titulo="Etiqueta del blíster" {vista} {nombreArchivo} impresora={ajustes?.impresoraEtiquetas}
      anchoMm={compuesta.anchoMm || undefined} altoMm={compuesta.altoMm || undefined} motivoNoImprimir={motivoNoImprimir || 'Esta etiqueta no se puede imprimir tal como está.'}
      {controles} onImpreso={alImprimir} avisos={compuesta.avisos} />
  {/key}
{:else if !vista}
  <div class="tarjeta apilado">{@render controles()}</div>
{/if}
{#if hojaPrueba}
  <div class="apilado" style="margin-top:1rem" data-prueba="vista-hoja-prueba">
    {#if hojaPrueba.problemas.length}<Nota gravedad="atencion">{hojaPrueba.problemas.join(' ')}</Nota>
    {:else}
      <Nota gravedad="info">Hoja de prueba: sin datos de nadie. Imprímela (o guárdala en PDF) con «Escala 100 %» y compárala con la hoja de etiquetas a contraluz antes de gastar etiquetas. Las marcas de la regla del borde están cada 10 mm.</Nota>
      <VistaPrevia titulo="Hoja de prueba" vista={{ html: hojaPrueba.html, imprimible: true, problemas: [], faltan: [] }} nombreArchivo="hoja-de-prueba-etiquetas.pdf"
        impresora={ajustes?.impresoraEtiquetas} anchoMm={hojaPrueba.anchoMm} altoMm={hojaPrueba.altoMm} />
    {/if}
  </div>
{/if}
