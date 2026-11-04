<script lang="ts">
  /**
   * Editor del modo de impresión de la etiqueta (rollo, hoja de etiquetas, ajustable).
   * `rapido`: sólo lo que se toca al imprimir (modo, posición libre, escala y desplazamiento).
   * Completo (Ajustes → Impresoras): además el tamaño del rollo y las medidas de la hoja de etiquetas.
   * Las comprobaciones de verdad las hace el dominio (etiquetas-hoja.ts); aquí sólo se enseñan sus motivos.
   */
  import Campo from './Campo.svelte';
  import {
    MODOS_IMPRESION, NOMBRE_MODO, PLANTILLAS_HOJA, validarRejilla, validarRollo, validarAjustable, validarPosicionLibre, libresDesde, ESCALA_MIN_PCT, ESCALA_MAX_PCT,
  } from '../../dominio/etiquetas-hoja.ts';
  import type { ConfigImpresion, ModoImpresion } from '../../dominio/etiquetas-hoja.ts';

  let { config = $bindable(), rapido = false, alcambiar }: { config: ConfigImpresion; rapido?: boolean; alcambiar?: () => void } = $props();

  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
  const rejilla = $derived(config.hoja);
  const erroresHoja = $derived([...validarRejilla(rejilla), ...(validarRejilla(rejilla).length ? [] : validarPosicionLibre(rejilla.primeraLibre, rejilla))]);
  const erroresRollo = $derived(validarRollo(config.rollo));
  const erroresAjuste = $derived(validarAjustable(config.ajustable));
  const idPlantilla = $derived(PLANTILLAS_HOJA.find((p) => (['columnas', 'filas', 'anchoMm', 'altoMm', 'margenSupMm', 'margenIzqMm', 'separacionHMm', 'separacionVMm'] as const).every((k) => p.rejilla[k] === rejilla[k]))?.id ?? 'personalizada');

  function elegirPlantilla(id: string | number | null | undefined) {
    const p = PLANTILLAS_HOJA.find((x) => x.id === id);
    if (!p) return;
    config.hoja = { ...p.rejilla, primeraLibre: { fila: 1, columna: 1 } };
    alcambiar?.();
  }
</script>

<div class="apilado" data-prueba="config-impresion">
  <Campo etiqueta="Cómo se imprime la etiqueta" tipo="seleccion" bind:valor={config.modo} opciones={MODOS_IMPRESION.map((m: ModoImpresion) => ({ valor: m, texto: NOMBRE_MODO[m] }))} id={rapido ? 'modo-rapido' : 'modo-ajustes'} />
  {#if config.modo === 'rollo'}
    {#if !rapido}
      <div class="fila">
        <Campo etiqueta="Ancho del rollo (mm)" tipo="numero" bind:valor={config.rollo.anchoMm} min={20} max={300} step="0.1" />
        <Campo etiqueta="Alto de la etiqueta (mm)" tipo="numero" bind:valor={config.rollo.altoMm} min={20} max={300} step="0.1" />
      </div>
      <p class="suave sin-margen">Una etiqueta por página, del tamaño del rollo. Si no es de 100×150 mm, la etiqueta se compone para ese espacio y, si lo que hay que decir no cabe, no se deja imprimir.</p>
    {/if}
    {#each erroresRollo as e (e)}<div class="error-texto">{e}</div>{/each}
  {:else if config.modo === 'hoja'}
    <div class="campo">
      <label for={rapido ? 'plantilla-hoja-rapida' : 'plantilla-hoja'}>Hoja de etiquetas</label>
      <select id={rapido ? 'plantilla-hoja-rapida' : 'plantilla-hoja'} value={idPlantilla} onchange={(e) => elegirPlantilla(e.currentTarget.value)}>
        {#each PLANTILLAS_HOJA as p (p.id)}<option value={p.id}>{p.nombre}</option>{/each}
        <option value="personalizada">Personalizada (medidas editadas)</option>
      </select>
      <div class="ayuda">Valores de partida: comprueba las medidas con la caja de tus etiquetas{rapido ? ' y edítalas en Ajustes → Impresoras' : ' y edítalas aquí'} si hace falta.</div>
    </div>
    {#if !rapido}
      <div class="fila" style="flex-wrap:wrap">
        <Campo etiqueta="Columnas" tipo="numero" bind:valor={config.hoja.columnas} min={1} max={10} pequeno />
        <Campo etiqueta="Filas" tipo="numero" bind:valor={config.hoja.filas} min={1} max={30} pequeno />
        <Campo etiqueta="Ancho etiqueta (mm)" tipo="numero" bind:valor={config.hoja.anchoMm} step="0.1" min={5} pequeno />
        <Campo etiqueta="Alto etiqueta (mm)" tipo="numero" bind:valor={config.hoja.altoMm} step="0.1" min={5} pequeno />
      </div>
      <div class="fila" style="flex-wrap:wrap">
        <Campo etiqueta="Margen superior (mm)" tipo="numero" bind:valor={config.hoja.margenSupMm} step="0.1" min={0} pequeno />
        <Campo etiqueta="Margen izquierdo (mm)" tipo="numero" bind:valor={config.hoja.margenIzqMm} step="0.1" min={0} pequeno />
        <Campo etiqueta="Separación horizontal (mm)" tipo="numero" bind:valor={config.hoja.separacionHMm} step="0.1" min={0} pequeno />
        <Campo etiqueta="Separación vertical (mm)" tipo="numero" bind:valor={config.hoja.separacionVMm} step="0.1" min={0} pequeno />
      </div>
    {/if}
    <div class="fila" style="flex-wrap:wrap">
      <Campo etiqueta="Primera libre: fila" tipo="numero" bind:valor={config.hoja.primeraLibre.fila} min={1} max={rejilla.filas} pequeno id={rapido ? 'libre-fila-rapida' : 'libre-fila'} />
      <Campo etiqueta="Primera libre: columna" tipo="numero" bind:valor={config.hoja.primeraLibre.columna} min={1} max={rejilla.columnas} pequeno id={rapido ? 'libre-col-rapida' : 'libre-col'} />
    </div>
    {#if !erroresHoja.length}<p class="suave sin-margen">En la primera hoja quedan {libresDesde(rejilla, rejilla.primeraLibre)} etiquetas libres, empezando en la fila {rejilla.primeraLibre.fila}, columna {rejilla.primeraLibre.columna}.</p>{/if}
    {#each erroresHoja as e (e)}<div class="error-texto">{e}</div>{/each}
  {:else}
    <div class="fila" style="flex-wrap:wrap">
      <Campo etiqueta="Escala (%)" tipo="numero" bind:valor={config.ajustable.escalaPct} min={ESCALA_MIN_PCT} max={ESCALA_MAX_PCT} step="1" pequeno id={rapido ? 'escala-rapida' : 'escala'} />
      <Campo etiqueta="Desplazamiento X (mm)" tipo="numero" bind:valor={config.ajustable.dxMm} step="0.5" pequeno id={rapido ? 'dx-rapido' : 'dx'} />
      <Campo etiqueta="Desplazamiento Y (mm)" tipo="numero" bind:valor={config.ajustable.dyMm} step="0.5" pequeno id={rapido ? 'dy-rapido' : 'dy'} />
    </div>
    <p class="suave sin-margen">La etiqueta se coloca en la esquina superior izquierda del folio A4, se escala entre {ESCALA_MIN_PCT} y {ESCALA_MAX_PCT} % y se desplaza X mm a la derecha e Y mm hacia abajo. Imprime la hoja de prueba para calibrar.</p>
    {#each erroresAjuste as e (e)}<div class="error-texto">{e}</div>{/each}
  {/if}
  {#if config.modo !== 'rollo'}<p class="suave sin-margen"><strong>Al imprimir elige «Escala 100 %» o «Tamaño real» (nunca «Ajustar a la página»)</strong> y papel A4: si no, las etiquetas se desplazan.</p>{/if}
</div>
