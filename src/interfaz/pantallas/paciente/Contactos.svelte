<script lang="ts">
  import { spd } from '../../api.ts';
  import type { ContactoDto } from '../../../servicios/api.ts';
  import Dialogo from '../../componentes/Dialogo.svelte';
  import Campo from '../../componentes/Campo.svelte';
  import Aviso from '../../componentes/Aviso.svelte';
  import { avisar } from '../../componentes/util.ts';
  import { CONTACTO_TIPOS } from './constantes.ts';

  let { pacienteId, contactos, alcambiar }: { pacienteId: number; contactos: ContactoDto[]; alcambiar: () => void } = $props();
  let editando = $state<Partial<ContactoDto> | null>(null); let error = $state<string | null>(null); let errNombre = $state<string | null>(null); let ocupado = $state(false);
  function nuevo() { editando = { tipo: 'cuidador', nombre: '', autorizadoRecoger: false }; error = errNombre = null; }
  async function guardar() {
    if (!editando) return;
    error = errNombre = null;
    if (!editando.nombre?.trim()) { errNombre = 'Escribe el nombre.'; return; }
    const e = editando; const n = (v?: string | null) => (v?.trim() ? v.trim() : null);
    ocupado = true;
    const r = await spd.guardarContacto({ id: e.id, pacienteId, tipo: e.tipo!, nombre: e.nombre!.trim(), dniNie: n(e.dniNie), parentesco: n(e.parentesco), telefono: n(e.telefono), email: n(e.email),
      numColegiado: n(e.numColegiado), centroSalud: n(e.centroSalud), autorizadoRecoger: !!e.autorizadoRecoger, notas: n(e.notas) });
    ocupado = false;
    if (r.ok) { editando = null; avisar('Contacto guardado.'); alcambiar(); } else error = r.error;
  }
  const esMedico = $derived(editando?.tipo === 'medico_cabecera' || editando?.tipo === 'especialista');
</script>

<section class="seccion">
  <div class="fila"><h2 class="sin-margen">Contactos</h2><span class="suave pequeno">Cuidador, representante, médico prescriptor…</span><span class="espacio"></span><button class="btn" onclick={nuevo}>Añadir contacto</button></div>
  {#if !contactos.length}<div class="vacio">Sin contactos. Añade al cuidador o al médico que prescribe para tenerlos a mano al preparar y entregar.</div>
  {:else}
    <table class="tabla"><thead><tr><th>Quién</th><th>Tipo</th><th>Teléfono</th><th>Puede recoger</th><th></th></tr></thead><tbody>
      {#each contactos as c (c.id)}
        <tr><td class="negrita">{c.nombre}{#if c.parentesco} <span class="suave">({c.parentesco})</span>{/if}</td><td>{CONTACTO_TIPOS[c.tipo] ?? c.tipo}</td><td>{c.telefono ?? '—'}</td>
          <td>{#if c.autorizadoRecoger}<span class="etiqueta ok">Sí</span>{:else}<span class="suave">No</span>{/if}</td>
          <td class="derecha"><button class="btn enlace" onclick={() => { editando = { ...c }; error = errNombre = null; }}>Editar</button></td></tr>
      {/each}
    </tbody></table>
  {/if}
</section>

<Dialogo abierto={!!editando} titulo={editando?.id ? 'Editar contacto' : 'Nuevo contacto'} onclose={() => (editando = null)} ancho={640}>
  {#if editando}
    <div class="cols-2">
      <Campo etiqueta="Tipo" tipo="seleccion" bind:valor={editando.tipo} opciones={Object.entries(CONTACTO_TIPOS).map(([valor, texto]) => ({ valor, texto }))} />
      <Campo etiqueta="Nombre" bind:valor={editando.nombre} error={errNombre} requerido autofocus />
      <Campo etiqueta="Teléfono" bind:valor={editando.telefono} inputmode="tel" />
      <Campo etiqueta="Correo electrónico" tipo="email" bind:valor={editando.email} />
      <Campo etiqueta="Parentesco o relación" bind:valor={editando.parentesco} />
      <Campo etiqueta="DNI / NIE" bind:valor={editando.dniNie} />
      {#if esMedico}
        <Campo etiqueta="Nº de colegiado" bind:valor={editando.numColegiado} />
        <Campo etiqueta="Centro de salud" bind:valor={editando.centroSalud} />
      {/if}
    </div>
    <label class="marca"><input type="checkbox" checked={!!editando.autorizadoRecoger} onchange={(e) => (editando!.autorizadoRecoger = e.currentTarget.checked)} />Está autorizado/a a recoger la medicación</label>
    <Campo etiqueta="Notas" tipo="area" bind:valor={editando.notas} />
    {#if error}<Aviso tipo="bloqueo" titulo="No se ha guardado">{error}</Aviso>{/if}
  {/if}
  {#snippet pie()}
    <button class="btn" onclick={() => (editando = null)}>Cancelar</button>
    <button class="btn principal" onclick={guardar} disabled={ocupado}>Guardar</button>
  {/snippet}
</Dialogo>
