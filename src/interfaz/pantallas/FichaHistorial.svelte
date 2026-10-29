<script lang="ts">
  /** Pestaña «Historial»: quién hizo qué con este paciente, en lenguaje llano. */
  import { spd, datos } from '../api.ts';
  import type { EntradaAuditoriaDto } from '../../servicios/api.ts';
  import { fechaHora } from '../lib/formato.ts';
  import '../estilos/u2.css';
  import Nota from './preparacion/Nota.svelte';
  import { mensaje } from './preparacion/util.ts';
  import { accionHumana } from './preparacion/auditoria.ts';

  let { pacienteId }: { pacienteId: number } = $props();
  let lista = $state<EntradaAuditoriaDto[]>([]); let cargando = $state(true); let error = $state('');
  $effect(() => {
    const id = pacienteId; cargando = true; error = '';
    datos(spd.listarAuditoria({ entidad: 'paciente', entidadId: String(id), limite: 200 })).then(l => { lista = l; }).catch(e => { error = mensaje(e); }).finally(() => { cargando = false; });
  });
</script>

<h2>Historial del paciente</h2>
{#if error}<Nota gravedad="atencion">{error}</Nota>{/if}
{#if cargando}<div class="cargando-linea">Cargando…</div>
{:else if !lista.length && !error}<div class="tarjeta vacio">Todavía no hay nada registrado.</div>
{:else if lista.length}
  <div class="tarjeta">
    <ul class="lista-plana" data-prueba="historial">
      {#each lista as a (a.id)}
        <li><span class="suave mono nowrap">{fechaHora(a.momento)}</span>
          <span class="espacio"><strong>{accionHumana(a.accion)}</strong> · {a.usuario ?? 'sistema'}{#if a.motivo}<br /><span class="suave">Motivo: {a.motivo}</span>{/if}{#if a.resumen}<br /><span class="suave pequeno">{a.resumen}</span>{/if}</span></li>
      {/each}
    </ul>
  </div>
{/if}
