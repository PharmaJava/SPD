<script lang="ts">
  /** Registrar la entrega del SPD: a quién se le da (el propio paciente o un contacto autorizado). */
  import { spd, datos } from '../../api.ts';
  import type { ContactoDto, PreparacionDto } from '../../../servicios/api.ts';
  import '../../estilos/u2.css';
  import Modal from './Modal.svelte';
  import Nota from './Nota.svelte';
  import { corto, mensaje } from './util.ts';

  let { abierto = $bindable(false), preparacion, pacienteNombre, onEntregada }: {
    abierto?: boolean; preparacion: PreparacionDto; pacienteNombre: string; onEntregada: (p: PreparacionDto) => void;
  } = $props();

  let contactos = $state<ContactoDto[]>([]);
  let quien = $state<'paciente' | number>('paciente');
  let observaciones = $state(''); let error = $state(''); let guardando = $state(false); let cargado = $state(false);

  $effect(() => {
    if (!abierto) { cargado = false; return; }
    quien = 'paciente'; observaciones = ''; error = '';
    datos(spd.listarContactos(preparacion.pacienteId)).then(c => { contactos = c.filter(x => x.autorizadoRecoger); cargado = true; }).catch(e => { error = mensaje(e); cargado = true; });
  });
  const nombreRecoge = $derived(quien === 'paciente' ? pacienteNombre : contactos.find(c => c.id === quien)?.nombre ?? '');

  async function registrar() {
    guardando = true; error = '';
    const r = await spd.registrarEntrega(preparacion.id, { entregadoA: nombreRecoge, contactoId: quien === 'paciente' ? undefined : quien, observaciones: observaciones.trim() || undefined });
    guardando = false;
    if (!r.ok) { error = r.error; return; }
    abierto = false; onEntregada(r.datos);
  }
</script>

<Modal titulo="Registrar la entrega" bind:abierto>
  <p>Blíster <strong>{corto(preparacion.idPublico)}</strong> de {pacienteNombre}.</p>
  <div class="campo"><label for="quien-recoge">¿Quién lo recoge?</label>
    <select id="quien-recoge" bind:value={quien} data-prueba="quien-recoge">
      <option value="paciente">El propio paciente ({pacienteNombre})</option>
      {#each contactos as c (c.id)}<option value={c.id}>{c.nombre}{c.parentesco ? ' (' + c.parentesco + ')' : ''}</option>{/each}
    </select>
    {#if cargado && !contactos.length}<span class="ayuda">Este paciente no tiene contactos autorizados para recoger. Se pueden añadir en su ficha.</span>{/if}
  </div>
  <div class="campo"><label for="obs-entrega">Observaciones (prospectos entregados, explicaciones dadas…)</label><textarea id="obs-entrega" bind:value={observaciones}></textarea></div>
  {#if error}<Nota gravedad="bloqueo">{error}</Nota>{/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (abierto = false)}>Cancelar</button>
    <button class="btn principal" type="button" onclick={registrar} disabled={guardando || !nombreRecoge} data-prueba="confirmar-entrega">Registrar la entrega</button>
  {/snippet}
</Modal>
