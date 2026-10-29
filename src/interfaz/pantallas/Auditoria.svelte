<script lang="ts">
  /** Auditoría: todo lo que se ha hecho en el programa, filtrable, y la comprobación de que nada se ha tocado. */
  import { spd, datos } from '../api.ts';
  import type { EntradaAuditoriaDto } from '../../servicios/api.ts';
  import { fechaHora } from '../lib/formato.ts';
  import '../estilos/u2.css';
  import Nota from './preparacion/Nota.svelte';
  import { accionHumana, entidadHumana, ENTIDADES_FILTRO } from './preparacion/auditoria.ts';
  import { mensaje } from './preparacion/util.ts';

  let { pacienteId }: { pacienteId?: number } = $props();
  let entidad = $state(pacienteId ? 'paciente' : ''); let texto = $state('');
  let lista = $state<EntradaAuditoriaDto[]>([]); let cargando = $state(true); let error = $state('');
  let verificando = $state(false);
  let veredicto = $state<{ ok: boolean; entradas: number; primerError?: string } | null>(null); let errorVer = $state('');

  $effect(() => {
    const e = entidad; cargando = true; error = '';
    let vigente = true;
    datos(spd.listarAuditoria({ entidad: e || undefined, entidadId: pacienteId ? String(pacienteId) : undefined, limite: 500 }))
      .then(l => { if (vigente) lista = l; }).catch(x => { if (vigente) error = mensaje(x); }).finally(() => { if (vigente) cargando = false; });
    return () => { vigente = false; };
  });
  const visibles = $derived.by(() => {
    const t = texto.trim().toLowerCase();
    return t ? lista.filter(a => [a.usuario, accionHumana(a.accion), entidadHumana(a.entidad), a.motivo, a.resumen, a.entidadId].join(' ').toLowerCase().includes(t)) : lista;
  });
  async function verificar() {
    verificando = true; errorVer = ''; veredicto = null;
    try { veredicto = await datos(spd.verificarAuditoria()); } catch (e) { errorVer = mensaje(e); } finally { verificando = false; }
  }
</script>

<div class="cabecera-pagina">
  <div><h1>Auditoría</h1><p class="subtitulo">Quién ha hecho qué y cuándo. Nada se borra: los cambios dejan rastro.</p></div>
  <span class="espacio"></span>
  <button class="btn principal" type="button" onclick={verificar} disabled={verificando} data-prueba="verificar">{verificando ? 'Comprobando…' : 'Comprobar que no se ha alterado'}</button>
</div>

{#if veredicto}
  {#if veredicto.ok}<Nota gravedad="ok" id="veredicto"><strong>Todo en orden.</strong> Se han revisado {veredicto.entradas} anotaciones y ninguna ha sido modificada ni eliminada.</Nota>
  {:else}<Nota gravedad="bloqueo" id="veredicto"><strong>Atención: el registro no cuadra.</strong> Alguna anotación parece haber sido cambiada o borrada{veredicto.primerError ? ` (${veredicto.primerError})` : ''}. No sigas trabajando con normalidad: avisa al titular y conserva una copia de seguridad tal como está.</Nota>{/if}
{/if}
{#if errorVer}<Nota gravedad="atencion">{errorVer}</Nota>{/if}

<div class="filtros">
  <div class="campo"><label for="f-ent">Qué</label>
    <select id="f-ent" bind:value={entidad}><option value="">Todo</option>{#each ENTIDADES_FILTRO as [k, v] (k)}<option value={k}>{v}</option>{/each}</select></div>
  <div class="campo" style="min-width:260px"><label for="f-txt">Buscar</label><input id="f-txt" bind:value={texto} placeholder="Persona, acción, motivo…" /></div>
  <span class="suave pequeno">{visibles.length} {visibles.length === 1 ? 'anotación' : 'anotaciones'}</span>
</div>

{#if error}<Nota gravedad="atencion">{error}</Nota>
{:else if cargando}<div class="cargando-linea">Cargando…</div>
{:else if !visibles.length}<div class="tarjeta vacio">No hay anotaciones con ese filtro.</div>
{:else}
  <div class="tarjeta scroll-x">
    <table class="tabla" data-prueba="tabla-auditoria">
      <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué</th><th>Detalle</th></tr></thead>
      <tbody>
        {#each visibles as a (a.id)}
          <tr><td class="mono nowrap">{fechaHora(a.momento)}</td><td>{a.usuario ?? 'Sistema'}</td>
            <td><strong>{accionHumana(a.accion)}</strong> · {entidadHumana(a.entidad)}</td>
            <td>{a.resumen}{#if a.motivo}<div class="suave pequeno">Motivo: {a.motivo}</div>{/if}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
