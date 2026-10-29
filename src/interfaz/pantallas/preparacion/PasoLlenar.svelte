<script lang="ts">
  /**
   * Paso 2 · Llenar: el mapa del blíster es el protagonista. Se elige un medicamento (clic, número o
   * escaneando su caja) y la pantalla resalta el SIGUIENTE alvéolo con las unidades que van.
   * Lo marcado se guarda solo en este equipo para poder retomarlo tras una interrupción.
   */
  import { onMount } from 'svelte';
  import { ordenLlenado } from '../../../dominio/disposicion-blister.ts';
  import { parsearGS1 } from '../../../dominio/gs1.ts';
  import type { Ajustes, EvaluacionPreparacion } from '../../../servicios/api.ts';
  import { fecha, unidades } from '../../lib/formato.ts';
  import '../../estilos/u2.css';
  import Leyenda from './Leyenda.svelte';
  import Mapa from './Mapa.svelte';
  import Modal from './Modal.svelte';
  import Nota from './Nota.svelte';
  import { colorMed, guardarLocal, leerLocal, pita } from './util.ts';

  type Tarea = { clave: string; mapa: number; fila: number; columna: number; tratamientoId: number; unidades: number; lote?: string };
  let { evaluacion, claveGuardado, ajustes, marcando, errorMarcar, yaPreparado = false, onMarcar, onHoja, onAtras }: {
    evaluacion: EvaluacionPreparacion; claveGuardado: string; ajustes: Ajustes | null; marcando: boolean; errorMarcar: string; yaPreparado?: boolean;
    onMarcar: (c: { temperatura: number; humedad: number; observaciones?: string }) => void; onHoja: () => void; onAtras: () => void;
  } = $props();

  // ── tareas en orden de llenado (el orden de celdas lo da el dominio; aquí sólo se recorre) ──
  const tareas = $derived.by<Tarea[]>(() => {
    const out: Tarea[] = [];
    const pos = ajustes?.posicionInicial ?? 'izquierda';
    for (const mapa of evaluacion.mapas) {
      for (const celda of ordenLlenado(mapa, pos)) {
        const al = evaluacion.alveolos.find(a => a.mapa === mapa.indice && a.fila === celda.fila && a.columna === celda.columna);
        for (const x of al?.contenido ?? []) out.push({ clave: `${mapa.indice}:${celda.fila}:${celda.columna}:${x.tratamientoId}`, mapa: mapa.indice, fila: celda.fila, columna: celda.columna, tratamientoId: x.tratamientoId, unidades: x.unidades, lote: x.lote });
      }
    }
    return out;
  });
  let hechosLista = $state<string[]>(leerLocal<string[]>(claveGuardado, []));
  const hechos = $derived(new Set(hechosLista));
  $effect(() => { guardarLocal(claveGuardado, hechosLista); });

  const progreso = $derived.by(() => {
    const p: Record<number, { hechos: number; total: number }> = {};
    for (const m of evaluacion.leyenda) p[m.tratamientoId] = { hechos: 0, total: 0 };
    for (const t of tareas) { const r = (p[t.tratamientoId] ??= { hechos: 0, total: 0 }); r.total++; if (hechos.has(t.clave)) r.hechos++; }
    return p;
  });
  const totalHechos = $derived(tareas.filter(t => hechos.has(t.clave)).length);
  const faltan = $derived(tareas.length - totalHechos);

  let activo = $state<number | null>(null);
  const siguiente = $derived(activo === null ? null : tareas.find(t => t.tratamientoId === activo && !hechos.has(t.clave)) ?? null);
  const primerIncompleto = $derived(evaluacion.leyenda.find(m => (progreso[m.tratamientoId]?.hechos ?? 0) < (progreso[m.tratamientoId]?.total ?? 0))?.tratamientoId ?? null);
  onMount(() => { activo = primerIncompleto; });

  let mapaSel = $state(0);
  $effect(() => { if (siguiente) mapaSel = siguiente.mapa; });
  const mapaActual = $derived(evaluacion.mapas.find(m => m.indice === mapaSel) ?? evaluacion.mapas[0]);
  const medActivo = $derived(evaluacion.leyenda.find(m => m.tratamientoId === activo));
  const indiceActivo = $derived(evaluacion.leyenda.findIndex(m => m.tratamientoId === activo));

  let aviso = $state<{ g: 'ok' | 'atencion' | 'bloqueo' | 'info'; t: string } | null>(null);
  let escaneo = $state('');
  let campoEscaneo: HTMLInputElement | undefined = $state();

  function elegir(id: number) { activo = id; aviso = null; }
  function avanzarSiCompleto(id: number) {
    const p = progreso[id];
    // `progreso` se recalcula tras el cambio: se mira con la lista nueva
    const hechosAhora = tareas.filter(t => t.tratamientoId === id && hechosLista.includes(t.clave)).length;
    if (p && hechosAhora >= p.total) {
      const nombre = evaluacion.leyenda.find(m => m.tratamientoId === id)?.nombre ?? 'El medicamento';
      const otro = evaluacion.leyenda.find(m => m.tratamientoId !== id && tareas.filter(t => t.tratamientoId === m.tratamientoId && !hechosLista.includes(t.clave)).length > 0);
      aviso = { g: 'ok', t: `${nombre}: completo.${otro ? ` Sigue con ${otro.nombre}.` : ' Ya está todo marcado.'}` };
      activo = otro?.tratamientoId ?? id;
    }
  }
  function marcarSiguiente() {
    const s = siguiente; if (!s) return;
    hechosLista = [...hechosLista, s.clave];
    avanzarSiCompleto(s.tratamientoId);
  }
  function deshacer() {
    if (!hechosLista.length) return;
    const ultima = hechosLista[hechosLista.length - 1];
    hechosLista = hechosLista.slice(0, -1);
    const t = tareas.find(x => x.clave === ultima); if (t) activo = t.tratamientoId;
    aviso = { g: 'info', t: 'Último alvéolo desmarcado.' };
  }
  function alternar(fila: number, columna: number) {
    const aqui = tareas.filter(t => t.mapa === mapaActual.indice && t.fila === fila && t.columna === columna);
    const t = aqui.length === 1 ? aqui[0] : aqui.find(x => x.tratamientoId === activo);
    if (!t) { aviso = { g: 'atencion', t: 'En este alvéolo van dos medicamentos: elige antes cuál estás poniendo.' }; return; }
    if (hechos.has(t.clave)) hechosLista = hechosLista.filter(k => k !== t.clave);
    else { hechosLista = [...hechosLista, t.clave]; activo = t.tratamientoId; avanzarSiCompleto(t.tratamientoId); }
  }

  // ── caja escaneada: ¿es de este blíster? ──
  function leerCaja() {
    const bruto = escaneo; escaneo = '';
    if (!bruto.trim()) { marcarSiguiente(); return; }
    const sep = ajustes?.lector.separadorGs ?? '';
    const l = parsearGS1(bruto, { separadores: sep ? [sep] : [] });
    if (l.gtin === undefined) { pita(); aviso = { g: 'atencion', t: 'No he podido leer ese código. Escanea el DataMatrix de la caja o elige el medicamento en la lista.' }; return; }
    if (l.ambiguo || !l.lote) { aviso = { g: 'atencion', t: 'El lector no ha enviado el separador: no puedo saber el lote. Elige el medicamento en la lista y comprueba el lote en la caja.' }; return; }
    const lote = l.lote.toLowerCase();
    const coinciden = evaluacion.lineasReparto.filter(x => x.lote.toLowerCase() === lote && (!l.caducidad || x.caducidad === l.caducidad));
    const ids = [...new Set(coinciden.map(x => x.tratamientoId))];
    if (!ids.length) {
      pita();
      aviso = { g: 'bloqueo', t: `Esta caja (lote ${l.lote}) NO es una de las que se usan en este blíster. Déjala y coge la que indica la pantalla.` };
      return;
    }
    if (ids.length > 1) { aviso = { g: 'atencion', t: 'Ese lote sale en más de un medicamento de este blíster: elígelo en la lista.' }; return; }
    activo = ids[0];
    const nombre = evaluacion.leyenda.find(m => m.tratamientoId === ids[0])?.nombre ?? '';
    const p = progreso[ids[0]];
    aviso = p && p.hechos >= p.total ? { g: 'info', t: `${nombre}: ya estaba todo marcado.` } : { g: 'ok', t: `Caja correcta: ${nombre}, lote ${l.lote}.` };
  }
  function teclaGlobal(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && t.closest('input,textarea,select,button,a,dialog')) return;
    if (/^[1-9]$/.test(e.key)) { const m = evaluacion.leyenda[+e.key - 1]; if (m) { e.preventDefault(); elegir(m.tratamientoId); } }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); marcarSiguiente(); }
    else if (e.key === 'Backspace') { e.preventDefault(); deshacer(); }
  }

  // ── condiciones de la sala y cierre ──
  let temperatura = $state(''); let humedad = $state(''); let observaciones = $state('');
  let errorSala = $state('');
  let confirmando = $state(false);
  const num = (s: string) => Number(s.replace(',', '.'));
  function pedirMarcar() {
    errorSala = '';
    if (!temperatura.trim() || !humedad.trim() || !Number.isFinite(num(temperatura)) || !Number.isFinite(num(humedad))) { errorSala = 'Anota la temperatura y la humedad de la sala: son un registro obligatorio de la preparación.'; return; }
    if (faltan > 0) confirmando = true; else marcar();
  }
  function marcar() { confirmando = false; onMarcar({ temperatura: num(temperatura), humedad: num(humedad), observaciones: observaciones.trim() || undefined }); }

  const dia = (f: string | null) => f ? fecha(f) : '';
  const sigMapa = $derived(siguiente ? evaluacion.mapas.find(m => m.indice === siguiente!.mapa) : null);
  const textoSig = $derived(siguiente && sigMapa ? `${sigMapa.filas[siguiente.fila]?.fecha ? dia(sigMapa.filas[siguiente.fila].fecha) : 'fila ' + (siguiente.fila + 1)} · ${sigMapa.columnas[siguiente.columna]?.nombre ?? ''}${evaluacion.mapas.length > 1 ? ` · blíster ${siguiente.mapa + 1}` : ''}` : '');
</script>

<svelte:window onkeydown={teclaGlobal} />

<div class="dos-col">
  <section class="tarjeta" aria-labelledby="t-mapa-llenar">
    <div class="fila"><h2 id="t-mapa-llenar" class="sin-margen">Mapa del blíster</h2><span class="espacio"></span>
      {#if evaluacion.mapas.length > 1}
        <div class="fila" role="tablist" aria-label="Blísteres">
          {#each evaluacion.mapas as m (m.indice)}
            <button class="btn mini" class:principal={m.indice === mapaSel} type="button" role="tab" aria-selected={m.indice === mapaSel} onclick={() => (mapaSel = m.indice)}>Blíster {m.indice + 1}</button>
          {/each}
        </div>
      {/if}
    </div>

    {#if aviso}<div aria-live="polite"><Nota gravedad={aviso.g}>{aviso.t}</Nota></div>{/if}

    {#if siguiente && medActivo}
      <div class="indicacion-siguiente" data-prueba="siguiente">
        <span class="chip-med" style="--c:{colorMed(medActivo.color, indiceActivo)}"><span class="letra">{medActivo.letra}</span><span class="ud">{unidades(siguiente.unidades)}</span></span>
        <div class="espacio">
          <div class="grande">Pon {unidades(siguiente.unidades)} de {medActivo.nombre}</div>
          <div>en <strong>{textoSig}</strong>{#if siguiente.lote}&nbsp;· de la caja con lote <strong>{siguiente.lote}</strong>{/if}</div>
        </div>
        <button class="btn principal grande" type="button" onclick={marcarSiguiente} data-prueba="marcar-siguiente">Ya está puesto <span class="atajo">Intro</span></button>
      </div>
    {:else if medActivo && progreso[medActivo.tratamientoId]?.total}
      {#if !aviso}<Nota gravedad="ok">{medActivo.nombre} está completo.</Nota>{/if}
    {:else}
      <Nota gravedad="info">Elige un medicamento de la lista (o escanea su caja) para que se marque dónde va.</Nota>
    {/if}

    {#if mapaActual}
      <Mapa mapa={mapaActual} alveolos={evaluacion.alveolos} leyenda={evaluacion.leyenda} {hechos}
        resaltar={activo} siguiente={siguiente && siguiente.mapa === mapaActual.indice ? { fila: siguiente.fila, columna: siguiente.columna } : null} onCelda={alternar} />
    {/if}
    <div class="fila margen-s">
      <button class="btn mini" type="button" onclick={deshacer} disabled={!hechosLista.length}>Deshacer el último <span class="atajo">Retroceso</span></button>
      <button class="btn mini" type="button" onclick={onHoja}>Hoja de trabajo para la mesa</button>
      <span class="espacio"></span>
      <span class="suave" data-prueba="total-avance">{totalHechos} de {tareas.length} puestos</span>
    </div>
  </section>

  <aside class="apilado">
    <section class="tarjeta" aria-labelledby="t-meds">
      <h2 id="t-meds">Medicamentos</h2>
      <div class="campo">
        <label for="escanear-caja">Escanea la caja que vas a usar</label>
        <input id="escanear-caja" bind:this={campoEscaneo} bind:value={escaneo} placeholder="Pasa el lector…" autocomplete="off"
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); leerCaja(); } }} data-prueba="escaneo-llenar" />
      </div>
      <Leyenda leyenda={evaluacion.leyenda} {activo} {progreso} seleccionable mostrarDescripcion onElegir={elegir} />
    </section>
    <section class="tarjeta" aria-labelledby="t-sala">
      <h2 id="t-sala">Condiciones de la sala</h2>
      <div class="dos-campos">
        <div class="campo"><label for="temp">Temperatura (°C)</label><input id="temp" bind:value={temperatura} inputmode="decimal" data-prueba="temperatura" class:error={!!errorSala && !temperatura.trim()} /></div>
        <div class="campo"><label for="hum">Humedad (%)</label><input id="hum" bind:value={humedad} inputmode="decimal" data-prueba="humedad" class:error={!!errorSala && !humedad.trim()} /></div>
      </div>
      <div class="campo"><label for="obs">Observaciones (opcional)</label><textarea id="obs" bind:value={observaciones}></textarea></div>
      {#if errorSala}<Nota gravedad="bloqueo">{errorSala}</Nota>{/if}
      {#if errorMarcar}<Nota gravedad="bloqueo">{errorMarcar}</Nota>{/if}
    </section>
  </aside>
</div>

<div class="barra-acciones">
  <button class="btn" type="button" onclick={onAtras}>← Volver a revisar</button>
  <span class="espacio"></span>
  {#if faltan > 0}<span class="suave">Faltan {faltan} {faltan === 1 ? 'puesto' : 'puestos'} por marcar.</span>{/if}
  <button class="btn principal grande" type="button" onclick={pedirMarcar} disabled={marcando} data-prueba="marcar-preparado">
    {marcando ? 'Guardando…' : yaPreparado ? 'Seguir a validar' : 'Marcar como preparado'} →</button>
</div>

<Modal titulo="¿Está completo el blíster?" bind:abierto={confirmando}>
  <p>En pantalla faltan <strong>{faltan}</strong> {faltan === 1 ? 'puesto' : 'puestos'} por marcar. Sólo sigue si has comprobado que el blíster físico está completo y la pantalla se ha quedado atrás.</p>
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (confirmando = false)}>Todavía no, sigo llenando</button>
    <button class="btn peligro" type="button" onclick={marcar} data-prueba="confirmar-completo">Sí, el blíster está completo</button>
  {/snippet}
</Modal>
