<script lang="ts">
  import { spd } from '../api.ts';
  import type { PanelHoy, TareaHoy } from '../../servicios/api.ts';
  import { ir } from '../router.ts';
  import { fechaLarga } from '../lib/formato.ts';
  import Cargando from '../componentes/Cargando.svelte';
  import Icono from '../componentes/Icono.svelte';
  import Aviso from '../componentes/Aviso.svelte';
  import { mensajeError } from '../componentes/util.ts';

  let panel = $state<PanelHoy | null>(null); let error = $state<string | null>(null);
  async function cargar() { const r = await spd.panelHoy(); if (r.ok) panel = r.datos; else error = mensajeError(r); }
  $effect(() => { cargar(); });

  const GRUPOS = [
    { g: 'bloqueo', titulo: 'Hay que resolver ya', icono: 'bloqueo', rot: 'Bloquea' },
    { g: 'atencion', titulo: 'Conviene revisar', icono: 'alerta', rot: 'Atención' },
    { g: 'info', titulo: 'Para tener en cuenta', icono: 'info', rot: 'Aviso' },
  ] as const;
  // Destino de cada tarea: la acción del servicio manda; si no, el tipo.
  function destino(t: TareaHoy): { texto: string; ruta: string } {
    const a = (t.accion ?? t.tipo ?? '').toLowerCase();
    if (/copia/.test(a)) return { texto: 'Hacer copia', ruta: 'ajustes/copias' };
    if (/prepar/.test(a) && t.pacienteId) return { texto: 'Preparar', ruta: `preparar/${t.pacienteId}` };
    if (/prepar/.test(a)) return { texto: 'Ir a preparar', ruta: 'preparar' };
    if (/caja|envase|caduc|cobertura|unidades|alerta|calidad/.test(a)) return t.pacienteId ? { texto: 'Ver cajas', ruta: `cajas/${t.pacienteId}` } : { texto: 'Ver cajas', ruta: 'cajas' };
    if (/ficha|medicamento|aspecto|descripci/.test(a)) return { texto: 'Completar ficha', ruta: 'medicamentos' };
    if (/consent|document|paciente|revis/.test(a) && t.pacienteId) return { texto: 'Abrir paciente', ruta: `pacientes/${t.pacienteId}` };
    return t.pacienteId ? { texto: 'Abrir paciente', ruta: `pacientes/${t.pacienteId}` } : { texto: 'Ver', ruta: 'pacientes' };
  }
  const cifras = $derived(panel ? [
    { v: panel.cifras.pacientesActivos, t: 'Pacientes activos', ruta: 'pacientes', alerta: false },
    { v: panel.cifras.preparacionesPendientes, t: 'Preparaciones pendientes', ruta: 'preparar', alerta: panel.cifras.preparacionesPendientes > 0 },
    { v: panel.cifras.cajasQueCaducan, t: 'Cajas que caducan pronto', ruta: 'cajas', alerta: panel.cifras.cajasQueCaducan > 0 },
    { v: panel.cifras.pacientesSinCobertura, t: 'Pacientes sin cobertura', ruta: 'pacientes', alerta: panel.cifras.pacientesSinCobertura > 0 },
    { v: panel.cifras.fichasIncompletas, t: 'Fichas de medicamento por completar', ruta: 'medicamentos', alerta: panel.cifras.fichasIncompletas > 0 },
  ] : []);
</script>

<div class="cabecera-pagina"><div><h1>Hoy</h1><p class="suave sin-margen">{panel ? fechaLarga(panel.fecha) : ''}</p></div></div>

{#if error}<Aviso tipo="bloqueo" titulo="No se ha podido cargar">{error}</Aviso>
{:else if !panel}<Cargando />
{:else}
  <div class="cifras">
    {#each cifras as c (c.t)}
      <button class="tarjeta cifra" class:alerta={c.alerta} onclick={() => ir(c.ruta)}>
        <div class="valor">{c.v}</div><div class="rotulo">{c.t}</div>
      </button>
    {/each}
  </div>

  {#if !panel.tareas.length && !panel.copias.atrasada}
    <div class="tarjeta todo-al-dia">
      <div class="gran"><Icono n="check" tam={36} /></div>
      <h2>Todo al día</h2>
      <p class="suave">No hay nada pendiente. Buen momento para revisar los pacientes o preparar con adelanto.</p>
      <button class="btn principal" onclick={() => ir('pacientes')}>Ver pacientes</button>
    </div>
  {:else}
    {#if panel.copias.atrasada}
      <div class="tarea atencion"><div class="txt"><span class="rot"><Icono n="alerta" tam={16} />Atención</span><div>La copia de seguridad está atrasada.</div></div>
        <button class="btn principal" onclick={() => ir('ajustes/copias')}>Hacer copia</button></div>
    {/if}
    {#each GRUPOS as gr (gr.g)}
      {@const ts = panel.tareas.filter(t => t.gravedad === gr.g)}
      {#if ts.length}
        <section class="seccion" aria-label={gr.titulo}>
          <h2>{gr.titulo} <span class="etiqueta {gr.g}">{ts.length}</span></h2>
          {#each ts as t, i (gr.g + i + t.texto)}
            {@const d = destino(t)}
            <div class="tarea {t.gravedad}">
              <div class="txt"><span class="rot"><Icono n={gr.icono} tam={16} />{gr.rot}</span><div>{t.texto}</div></div>
              <button class="btn" onclick={() => ir(d.ruta)}>{d.texto}<Icono n="flecha" tam={16} /></button>
            </div>
          {/each}
        </section>
      {/if}
    {/each}
  {/if}
{/if}
