<script lang="ts">
  /** Pestaña «Blísteres» de la ficha: preparaciones del paciente, con su estado. */
  import { spd, datos } from '../api.ts';
  import type { EstadoPreparacion, PreparacionDto } from '../../servicios/api.ts';
  import { fecha } from '../lib/formato.ts';
  import '../estilos/u2.css';
  import Modal from './preparacion/Modal.svelte';
  import Nota from './preparacion/Nota.svelte';
  import { corto, dejarPaso, ir, mensaje, rutas } from './preparacion/util.ts';

  let { pacienteId }: { pacienteId: number } = $props();
  let lista = $state<PreparacionDto[]>([]); let cargando = $state(true); let error = $state('');
  let anulando = $state<PreparacionDto | null>(null); let abierto = $state(false); let motivo = $state(''); let errorAnular = $state(''); let trabajando = $state(false);

  const ESTADOS: Record<EstadoPreparacion, { t: string; c: string }> = {
    borrador: { t: 'Borrador', c: 'info' }, preparado: { t: 'Preparado, falta validar', c: 'atencion' }, validado: { t: 'Validado', c: 'ok' },
    entregado: { t: 'Entregado', c: 'ok' }, anulado: { t: 'Anulado', c: 'bloqueo' },
  };
  async function cargar() {
    cargando = true; error = '';
    try { lista = await datos(spd.listarPreparaciones({ pacienteId, estado: 'todas' })); } catch (e) { error = mensaje(e); } finally { cargando = false; }
  }
  $effect(() => { pacienteId; void cargar(); });

  function abrir(p: PreparacionDto, imprimir = false) { dejarPaso('spd.abrirPreparacion', String(p.id)); void imprimir; ir(rutas.preparar(pacienteId)); }
  function pedirAnular(p: PreparacionDto) { anulando = p; motivo = ''; errorAnular = ''; abierto = true; }
  async function anular() {
    if (!anulando) return;
    if (!motivo.trim()) { errorAnular = 'Escribe el motivo: queda en el historial.'; return; }
    trabajando = true;
    const r = await spd.anularPreparacion(anulando.id, motivo.trim());
    trabajando = false;
    if (!r.ok) { errorAnular = r.error; return; }
    abierto = false; await cargar();
  }
</script>

<div class="fila" style="margin-bottom:1rem">
  <h2 class="sin-margen">Blísteres</h2><span class="espacio"></span>
  <button class="btn principal" type="button" onclick={() => ir(rutas.preparar(pacienteId))} data-prueba="nuevo-blister">Preparar un blíster</button>
</div>
{#if error}<Nota gravedad="bloqueo">{error}</Nota>{/if}
{#if cargando}<div class="cargando-linea">Cargando…</div>
{:else if !lista.length}<div class="tarjeta vacio">Todavía no se ha preparado ningún blíster para este paciente.</div>
{:else}
  <div class="tarjeta scroll-x">
    <table class="tabla" data-prueba="lista-blisteres">
      <thead><tr><th>Blíster</th><th>Periodo</th><th>Caduca</th><th>Estado</th><th></th></tr></thead>
      <tbody>
        {#each lista as p (p.id)}
          {@const e = ESTADOS[p.estado]}
          <tr>
            <td class="negrita mono">{corto(p.idPublico)}</td>
            <td class="nowrap">{fecha(p.fechaInicio)} – {fecha(p.fechaFin)}</td>
            <td class="nowrap">{fecha(p.caducidadSpd)}{#if p.fueraDeEstandar} <span class="etiqueta atencion">ampliada</span>{/if}</td>
            <td><span class="etiqueta {e.c}">{e.t}</span></td>
            <td class="derecha nowrap">
              {#if p.estado !== 'anulado'}<button class="btn mini" type="button" onclick={() => abrir(p)}>{p.estado === 'validado' || p.estado === 'entregado' ? 'Abrir y reimprimir' : 'Abrir'}</button>{/if}
              {#if p.estado !== 'anulado' && p.estado !== 'entregado'}<button class="btn mini peligro" type="button" onclick={() => pedirAnular(p)}>Anular</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<Modal titulo="Anular el blíster" bind:abierto>
  {#if anulando}
    <p>Vas a anular <strong>{corto(anulando.idPublico)}</strong> ({fecha(anulando.fechaInicio)} – {fecha(anulando.fechaFin)}). No se borra: queda en el historial con su motivo.</p>
    <div class="campo"><label for="motivo-anular">Motivo</label><textarea id="motivo-anular" bind:value={motivo}></textarea></div>
    {#if errorAnular}<Nota gravedad="bloqueo">{errorAnular}</Nota>{/if}
  {/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (abierto = false)}>No anular</button>
    <button class="btn peligro" type="button" onclick={anular} disabled={trabajando}>Anular el blíster</button>
  {/snippet}
</Modal>
