<script lang="ts">
  import { spd } from '../../api.ts';
  import type { SaludDatoDto } from '../../../servicios/api.ts';
  import Dialogo from '../../componentes/Dialogo.svelte';
  import Campo from '../../componentes/Campo.svelte';
  import Aviso from '../../componentes/Aviso.svelte';
  import { fecha, hoyIso } from '../../lib/formato.ts';
  import { avisar } from '../../componentes/util.ts';
  import { SALUD_TIPOS } from './constantes.ts';

  let { pacienteId, salud, alcambiar }: { pacienteId: number; salud: SaludDatoDto[]; alcambiar: () => void } = $props();
  let editando = $state<Partial<SaludDatoDto> | null>(null); let error = $state<string | null>(null); let errDesc = $state<string | null>(null); let ocupado = $state(false);
  const vigentes = $derived(salud.filter(s => s.vigente)); const antiguos = $derived(salud.filter(s => !s.vigente));
  function nuevo() { editando = { tipo: 'alergia', descripcion: '', valor: '', fecha: '', fuente: '', vigente: true }; error = errDesc = null; }
  async function guardar() {
    if (!editando) return;
    errDesc = null; error = null;
    if (!editando.descripcion?.trim()) { errDesc = 'Describe el dato (p. ej. «Penicilina»).'; return; }
    ocupado = true;
    const e = editando;
    const r = await spd.guardarSalud({ id: e.id, pacienteId, tipo: e.tipo!, descripcion: e.descripcion!.trim(), valor: e.valor?.trim() || null, fecha: e.fecha || null, fuente: e.fuente?.trim() || null, vigente: e.vigente !== false });
    ocupado = false;
    if (r.ok) { editando = null; avisar('Dato de salud guardado.'); alcambiar(); } else error = r.error;
  }
</script>

<section class="seccion">
  <div class="fila"><h2 class="sin-margen">Salud</h2><span class="suave pequeno">Solo lo necesario para preparar con seguridad.</span><span class="espacio"></span>
    <button class="btn" onclick={nuevo}>Añadir dato</button></div>
  {#if !salud.length}<div class="vacio">No hay datos de salud registrados. Si el paciente tiene alergias, anótalas aquí: salen siempre en la cabecera.</div>
  {:else}
    <table class="tabla"><thead><tr><th>Tipo</th><th>Descripción</th><th>Valor</th><th>Fecha</th><th>Fuente</th><th></th></tr></thead><tbody>
      {#each vigentes as s (s.id)}
        <tr><td><span class="etiqueta" class:alergia={s.tipo === 'alergia'}>{SALUD_TIPOS[s.tipo] ?? s.tipo}</span></td><td class="negrita">{s.descripcion}</td><td>{s.valor ?? ''}</td><td>{fecha(s.fecha)}</td><td>{s.fuente ?? ''}</td>
          <td class="derecha"><button class="btn enlace" onclick={() => { editando = { ...s }; error = errDesc = null; }}>Editar</button></td></tr>
      {/each}
      {#each antiguos as s (s.id)}
        <tr class="suave"><td>{SALUD_TIPOS[s.tipo] ?? s.tipo} <span class="etiqueta">Ya no vigente</span></td><td>{s.descripcion}</td><td>{s.valor ?? ''}</td><td>{fecha(s.fecha)}</td><td>{s.fuente ?? ''}</td>
          <td class="derecha"><button class="btn enlace" onclick={() => { editando = { ...s }; error = errDesc = null; }}>Editar</button></td></tr>
      {/each}
    </tbody></table>
  {/if}
</section>

<Dialogo abierto={!!editando} titulo={editando?.id ? 'Editar dato de salud' : 'Nuevo dato de salud'} onclose={() => (editando = null)}>
  {#if editando}
    <Campo etiqueta="Tipo" tipo="seleccion" bind:valor={editando.tipo} opciones={Object.entries(SALUD_TIPOS).map(([valor, texto]) => ({ valor, texto }))} />
    <Campo etiqueta="Descripción" bind:valor={editando.descripcion} error={errDesc} requerido autofocus onenter={guardar} />
    <div class="cols-2">
      <Campo etiqueta="Valor (si procede)" bind:valor={editando.valor} ayuda="Peso en kg, filtrado en mL/min…" onenter={guardar} />
      <Campo etiqueta="Fecha" tipo="fecha" bind:valor={editando.fecha} max={hoyIso()} />
    </div>
    <Campo etiqueta="Fuente" bind:valor={editando.fuente} ayuda="Informe médico, el propio paciente, historia clínica…" onenter={guardar} />
    <label class="marca"><input type="checkbox" checked={editando.vigente !== false} onchange={(e) => (editando!.vigente = e.currentTarget.checked)} />Sigue vigente</label>
    {#if error}<Aviso tipo="bloqueo" titulo="No se ha guardado">{error}</Aviso>{/if}
  {/if}
  {#snippet pie()}
    <button class="btn" onclick={() => (editando = null)}>Cancelar</button>
    <button class="btn principal" onclick={guardar} disabled={ocupado}>Guardar</button>
  {/snippet}
</Dialogo>
