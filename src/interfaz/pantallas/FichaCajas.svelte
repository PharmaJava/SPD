<script lang="ts">
  /** Pestaña «Cajas» de la ficha del paciente: lo que hay en custodia, con su lote y caducidad. */

  import { spd, datos } from '../api.ts';
  import type { EnvaseDto } from '../../servicios/api.ts';
  import { DIAS_AVISO_CADUCIDAD_POR_DEFECTO } from '../../dominio/entrada-envase.ts';
  import { diasHasta, fecha, hoyIso } from '../lib/formato.ts';
  import '../estilos/u2.css';
  import Modal from './preparacion/Modal.svelte';
  import Nota from './preparacion/Nota.svelte';
  import { ir, mensaje, rutas } from './preparacion/util.ts';

  let { pacienteId }: { pacienteId: number } = $props();

  let envases = $state<EnvaseDto[]>([]);
  let cargando = $state(true);
  let error = $state('');
  let verCerradas = $state(false);

  let cerrando = $state<EnvaseDto | null>(null);
  let abierto = $state(false);
  let estadoCierre = $state<'devuelto' | 'retirado' | 'desechado'>('devuelto');
  let motivo = $state('');
  let errorCierre = $state('');
  let trabajando = $state(false);

  const enUso = $derived(envases.filter(e => e.estado === 'en_uso'));
  const cerradas = $derived(envases.filter(e => e.estado !== 'en_uso'));

  async function cargar() {
    cargando = true; error = '';
    try { envases = await datos(spd.listarEnvases(pacienteId, true)); } catch (e) { error = mensaje(e); } finally { cargando = false; }
  }
  $effect(() => { pacienteId; void cargar(); });

  function estadoCaducidad(c: string): { clase: string; texto: string } | null {
    const d = diasHasta(hoyIso(), c);
    if (d < 0) return { clase: 'bloqueo', texto: `Caducada hace ${-d} ${-d === 1 ? 'día' : 'días'}` };
    if (d <= DIAS_AVISO_CADUCIDAD_POR_DEFECTO) return { clase: 'atencion', texto: d === 0 ? 'Caduca hoy' : `Caduca en ${d} ${d === 1 ? 'día' : 'días'}` };
    return null;
  }
  const ESTADO: Record<string, string> = { en_uso: 'En uso', agotado: 'Agotada', devuelto: 'Devuelta al paciente', retirado: 'Retirada', desechado: 'Desechada' };

  function pedirCierre(e: EnvaseDto) { cerrando = e; estadoCierre = 'devuelto'; motivo = ''; errorCierre = ''; abierto = true; }
  async function confirmarCierre() {
    if (!cerrando) return;
    if (!motivo.trim()) { errorCierre = 'Escribe el motivo: queda en el historial.'; return; }
    trabajando = true; errorCierre = '';
    const r = await spd.cerrarEnvase(cerrando.id, estadoCierre, motivo.trim());
    trabajando = false;
    if (!r.ok) { errorCierre = r.error; return; }
    abierto = false; await cargar();
  }
</script>

<div class="fila margen-s" style="margin-bottom:1rem">
  <h2 class="sin-margen">Cajas en custodia</h2><span class="espacio"></span>
  <button class="btn principal" type="button" onclick={() => ir(rutas.cajas(pacienteId))} data-prueba="entrada-cajas">Registrar entrada de cajas</button>
</div>

{#if error}<Nota gravedad="bloqueo">{error}</Nota>{/if}
{#if cargando}<div class="cargando-linea">Cargando cajas…</div>
{:else}
  {#if !enUso.length}
    <div class="tarjeta vacio">Este paciente no tiene cajas en uso. Cuando llegue medicación, regístrala en «Entrada de cajas».</div>
  {:else}
    <div class="tarjeta scroll-x">
      <table class="tabla" data-prueba="cajas-en-uso">
        <thead><tr><th>Medicamento</th><th>Lote</th><th>Caducidad</th><th class="derecha">Quedan</th><th>Recibida</th><th></th></tr></thead>
        <tbody>
          {#each enUso as e (e.id)}
            {@const cad = estadoCaducidad(e.caducidad)}
            <tr>
              <td class="negrita">{e.medicamentoNombre}</td>
              <td class="mono">{e.lote}</td>
              <td class="mono nowrap">{fecha(e.caducidad)} {#if cad}<span class="etiqueta {cad.clase}">{cad.texto}</span>{/if}</td>
              <td class="derecha mono nowrap">{e.unidadesRestantes} de {e.unidadesInicio}</td>
              <td class="suave nowrap">{fecha(e.recibidoEn)}</td>
              <td class="derecha"><button class="btn mini" type="button" onclick={() => pedirCierre(e)}>Cerrar caja</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if cerradas.length}
    <div class="margen-m">
      <button class="btn enlace" type="button" onclick={() => (verCerradas = !verCerradas)} aria-expanded={verCerradas}>
        {verCerradas ? 'Ocultar' : 'Ver'} las {cerradas.length} {cerradas.length === 1 ? 'caja cerrada' : 'cajas cerradas'}</button>
      {#if verCerradas}
        <div class="tarjeta scroll-x margen-s">
          <table class="tabla" data-prueba="cajas-cerradas">
            <thead><tr><th>Medicamento</th><th>Lote</th><th>Caducidad</th><th>Estado</th></tr></thead>
            <tbody>{#each cerradas as e (e.id)}
              <tr><td>{e.medicamentoNombre}</td><td class="mono">{e.lote}</td><td class="mono">{fecha(e.caducidad)}</td><td><span class="etiqueta">{ESTADO[e.estado] ?? e.estado}</span></td></tr>
            {/each}</tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
{/if}

<Modal titulo="Cerrar la caja" bind:abierto>
  {#if cerrando}
    <p><strong>{cerrando.medicamentoNombre}</strong>, lote {cerrando.lote} (quedan {cerrando.unidadesRestantes} unidades).</p>
    <div class="campo"><label for="estado-cierre">¿Qué pasa con la caja?</label>
      <select id="estado-cierre" bind:value={estadoCierre}>
        <option value="devuelto">Se devuelve al paciente</option><option value="retirado">Se retira (alerta de calidad u otro motivo)</option><option value="desechado">Se desecha</option>
      </select></div>
    <div class="campo"><label for="motivo-cierre">Motivo</label><textarea id="motivo-cierre" bind:value={motivo} class:error={!!errorCierre}></textarea></div>
    {#if errorCierre}<Nota gravedad="bloqueo">{errorCierre}</Nota>{/if}
  {/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (abierto = false)}>Cancelar</button>
    <button class="btn principal" type="button" onclick={confirmarCierre} disabled={trabajando}>Cerrar la caja</button>
  {/snippet}
</Modal>
