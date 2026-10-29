<script lang="ts">
  import { spd } from '../../api.ts';
  import type { PacienteDto, CentroDto, SaludDatoDto, ContactoDto, EstadoPaciente } from '../../../servicios/api.ts';
  import FormPaciente from './FormPaciente.svelte';
  import Salud from './Salud.svelte';
  import Contactos from './Contactos.svelte';
  import Confirmar from '../../componentes/Confirmar.svelte';
  import { avisar } from '../../componentes/util.ts';

  let { paciente, centros, salud, contactos, alcambiar }: { paciente: PacienteDto; centros: CentroDto[]; salud: SaludDatoDto[]; contactos: ContactoDto[]; alcambiar: () => void } = $props();
  let cambio = $state<Exclude<EstadoPaciente, 'activo'> | null>(null);
  const TEXTO = { pausado: 'Pausar', baja: 'Dar de baja', fallecido: 'Marcar como fallecido' } as const;
  async function aplicar(motivo: string) {
    const e = cambio!; const r = await spd.darDeBajaPaciente(paciente.id, motivo, e); cambio = null;
    if (r.ok) { avisar('Estado actualizado.'); alcambiar(); } else avisar(r.error, 'bloqueo', 6000);
  }
</script>

<section class="seccion"><h2>Datos del paciente</h2>
  <div class="tarjeta">{#key paciente.id + ':' + paciente.altaEn}<FormPaciente inicial={paciente} {centros} onguardado={alcambiar} />{/key}</div>
</section>
<div class="tarjeta seccion"><Salud pacienteId={paciente.id} {salud} {alcambiar} /></div>
<div class="tarjeta seccion"><Contactos pacienteId={paciente.id} {contactos} {alcambiar} /></div>
{#if paciente.estado === 'activo'}
  <section class="seccion tarjeta">
    <h2>Situación del paciente</h2>
    <p class="suave">Si el paciente deja de usar el servicio, no se borra nada: su historial se conserva el tiempo que exige la ley.</p>
    <div class="fila">{#each (['pausado', 'baja', 'fallecido'] as const) as e}<button class="btn peligro" onclick={() => (cambio = e)}>{TEXTO[e]}</button>{/each}</div>
  </section>
{/if}
<Confirmar abierto={!!cambio} titulo={cambio ? TEXTO[cambio] : ''} mensaje="Dejará de aparecer entre los pacientes activos. El historial se conserva." confirmarTexto="Confirmar" peligro pideMotivo onconfirmar={aplicar} oncancelar={() => (cambio = null)} />
