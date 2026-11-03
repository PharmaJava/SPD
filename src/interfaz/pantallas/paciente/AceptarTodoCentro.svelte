<script lang="ts">
  /**
   * «Aceptar todo»: la farmacia da por GESTIONADOS SIN FIRMA INDIVIDUAL los consentimientos de todos los pacientes activos de un
   * centro (p. ej. la residencia los recoge). No es una firma: cada paciente recibe un registro con su motivo, quién y cuándo,
   * visible como «Gestionado por el centro, sin firma individual» y revocable. Sólo titular y farmacéutico (el servicio lo exige).
   */
  import { spd } from '../../api.ts';
  import type { PlantillaDocumentoDto, ResultadoGestionSinFirma } from '../../../servicios/api.ts';
  import { GESTIONABLES_SIN_FIRMA } from '../../../dominio/documentos-gestion.ts';
  import { avisar, mensajeError } from '../../componentes/util.ts';
  import Modal from '../preparacion/Modal.svelte';
  import Nota from '../preparacion/Nota.svelte';

  let { centroId, centroNombre, alhecho }: { centroId: number; centroNombre: string; alhecho: () => void } = $props();

  let abierto = $state(false);
  let plantillas = $state<PlantillaDocumentoDto[]>([]);
  let elegidos = $state<string[]>(['consentimiento_spd', 'info_rgpd']);
  let motivo = $state('Consentimiento recogido por el centro');
  let previa = $state<ResultadoGestionSinFirma | null>(null);
  let error = $state(''); let cargando = $state(false); let ocupado = $state(false);

  const gestionables = $derived(plantillas.filter((p) => GESTIONABLES_SIN_FIRMA.includes(p.codigo)));
  const motivoValido = $derived(motivo.trim().length >= 5);
  const puedeConfirmar = $derived(!!previa && previa.totalRegistrados > 0 && motivoValido && !ocupado && !cargando);

  async function abrir() {
    error = ''; previa = null; abierto = true;
    const r = await spd.listarPlantillasDocumento();
    if (r.ok) plantillas = r.datos; else error = mensajeError(r);
    await simular();
  }
  /** Cuenta, sin escribir nada: cuántos pacientes y documentos, y a quiénes ya les consta (se saltan). */
  async function simular() {
    previa = null; error = '';
    if (elegidos.length === 0) return;
    cargando = true;
    const r = await spd.gestionarDocumentosSinFirma({ centroId, codigos: elegidos, motivo: motivo.trim(), simular: true });
    cargando = false;
    if (r.ok) previa = r.datos; else error = mensajeError(r);
  }
  function alternar(codigo: string) {
    elegidos = elegidos.includes(codigo) ? elegidos.filter((c) => c !== codigo) : [...elegidos, codigo];
    void simular();
  }
  async function confirmar() {
    if (!puedeConfirmar) return;
    ocupado = true; error = '';
    const r = await spd.gestionarDocumentosSinFirma({ centroId, codigos: elegidos, motivo: motivo.trim() });
    ocupado = false;
    if (!r.ok) { error = mensajeError(r); return; }
    abierto = false;
    avisar(`Registrado como gestionado sin firma individual: ${r.datos.totalRegistrados} ${r.datos.totalRegistrados === 1 ? 'documento' : 'documentos'} en ${r.datos.totalPacientes} ${r.datos.totalPacientes === 1 ? 'paciente' : 'pacientes'}.`);
    alhecho();
  }
</script>

<button class="btn" type="button" onclick={abrir} data-prueba="aceptar-todo" title="Registrar los consentimientos de todos los pacientes activos de este centro como gestionados sin firma individual">Aceptar todo</button>

<Modal titulo="Aceptar todo: gestionado sin firma individual" bind:abierto ancho>
  <Nota gravedad="atencion"><strong>Esto no es una firma.</strong> Se registra, en cada paciente activo de «{centroNombre}», que la farmacia da estos documentos por gestionados sin firma individual (p. ej. los recoge el centro). Se verá como «Gestionado por el centro, sin firma individual», con fecha, usuario y motivo; no se imprime como firmado y se puede revocar paciente a paciente. <strong>La farmacia asume la responsabilidad.</strong></Nota>
  <fieldset class="campo">
    <legend>Documentos</legend>
    {#each gestionables as p (p.codigo)}
      <label class="marca"><input type="checkbox" checked={elegidos.includes(p.codigo)} onchange={() => alternar(p.codigo)} data-prueba="gestion-doc-{p.codigo}" />{p.titulo}</label>
    {/each}
  </fieldset>
  <div class="campo"><label for="motivo-masivo">Motivo (obligatorio)</label>
    <textarea id="motivo-masivo" bind:value={motivo} onchange={simular} placeholder="Ej.: Consentimiento recogido por el centro" data-prueba="motivo-masivo"></textarea></div>
  {#if cargando}<div class="cargando-linea">Contando…</div>{/if}
  {#if previa}
    <Nota gravedad={previa.totalRegistrados > 0 ? 'info' : 'ok'} id="resumen-masivo">
      {#if previa.totalRegistrados > 0}
        Se registrarán <strong>{previa.totalRegistrados} {previa.totalRegistrados === 1 ? 'documento' : 'documentos'}</strong> en <strong>{previa.totalPacientes} {previa.totalPacientes === 1 ? 'paciente activo' : 'pacientes activos'}</strong>
        ({previa.documentos.map((d) => d.titulo).join('; ')}).
        {#if previa.totalSaltados > 0} Se saltan {previa.totalSaltados} que ya tienen el documento vigente.{/if}
      {:else}
        Nada que registrar: los {previa.totalPacientes} pacientes activos ya tienen vigentes esos documentos.
      {/if}
    </Nota>
  {:else if elegidos.length === 0}<Nota gravedad="atencion">Elige al menos un documento.</Nota>{/if}
  {#if error}<Nota gravedad="bloqueo">{error}</Nota>{/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (abierto = false)}>Cancelar</button>
    <button class="btn principal" type="button" onclick={confirmar} disabled={!puedeConfirmar} data-prueba="confirmar-aceptar-todo">Registrar como gestionado</button>
  {/snippet}
</Modal>
