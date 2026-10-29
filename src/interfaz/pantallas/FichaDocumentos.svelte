<script lang="ts">
  /** Pestaña «Documentos»: consentimientos del paciente (qué falta, vista previa, imprimir, firma, revocación). */
  import { spd, datos } from '../api.ts';
  import type { ContactoDto, EstadoConsentimientosDto, PlantillaDocumentoDto, VistaDocumento } from '../../servicios/api.ts';
  import { fechaHora } from '../lib/formato.ts';
  import '../estilos/u2.css';
  import Modal from './preparacion/Modal.svelte';
  import Nota from './preparacion/Nota.svelte';
  import { escaparHtml, guardarLocal, leerLocal, mdBasico, mensaje } from './preparacion/util.ts';

  type Calidad = 'paciente' | 'representante_legal' | 'guardador_de_hecho';
  let { pacienteId }: { pacienteId: number } = $props();

  let plantillas = $state<PlantillaDocumentoDto[]>([]);
  let estado = $state<EstadoConsentimientosDto | null>(null);
  let contactos = $state<ContactoDto[]>([]);
  let nombrePaciente = $state('');
  let cargando = $state(true); let error = $state('');

  let actual = $state<PlantillaDocumentoDto | null>(null); let abierto = $state(false);
  let calidad = $state<Calidad>('paciente'); let contactoId = $state<number | ''>('');
  let nombreFirmante = $state(''); let dniFirmante = $state('');
  let vista = $state<VistaDocumento | null>(null); let cargandoVista = $state(false); let errorVista = $state('');
  let trabajando = $state(false); let mensajeOk = $state('');

  let revocando = $state<{ id: number; titulo: string } | null>(null); let abiertoRev = $state(false); let motivo = $state(''); let errorRev = $state('');

  const claveIds = $derived(`spd.docs.firmados.${pacienteId}`);
  const CALIDADES: { v: Calidad; t: string }[] = [{ v: 'paciente', t: 'El propio paciente' }, { v: 'representante_legal', t: 'Su representante legal' }, { v: 'guardador_de_hecho', t: 'Un guardador de hecho' }];

  async function cargar() {
    cargando = true; error = '';
    try {
      const [p, e, c, pac] = await Promise.all([datos(spd.listarPlantillasDocumento()), datos(spd.estadoConsentimientos(pacienteId)), datos(spd.listarContactos(pacienteId)), datos(spd.obtenerPaciente(pacienteId))]);
      plantillas = p; estado = e; contactos = c;
      nombrePaciente = [pac.nombre, pac.apellido1, pac.apellido2].filter(Boolean).join(' ');
    } catch (x) { error = mensaje(x); } finally { cargando = false; }
  }
  $effect(() => { pacienteId; void cargar(); });

  type Fila = { p: PlantillaDocumentoDto; situacion: 'vigente' | 'falta' | 'desactualizado' | 'revocado'; firmado?: EstadoConsentimientosDto['firmados'][number] & { id?: number } };
  const filas = $derived.by<Fila[]>(() => plantillas.map(p => {
    const f = estado?.firmados.find(x => x.codigo === p.codigo) as Fila['firmado'];
    const situacion = estado?.revocados.includes(p.codigo) ? 'revocado' : estado?.desactualizados.includes(p.codigo) ? 'desactualizado' : f ? 'vigente' : 'falta';
    return { p, situacion, firmado: f };
  }));
  const ROT = { vigente: { t: 'Firmado y vigente', c: 'ok' }, falta: { t: 'Falta', c: 'bloqueo' }, desactualizado: { t: 'Hay una versión nueva', c: 'atencion' }, revocado: { t: 'Revocado', c: 'bloqueo' } } as const;

  function firmante() {
    const c = contactos.find(x => x.id === contactoId);
    const nombre = calidad === 'paciente' ? nombrePaciente : (c?.nombre ?? nombreFirmante).trim();
    return { nombre, dniNie: calidad === 'paciente' ? undefined : (c?.dniNie ?? dniFirmante).trim() || undefined, calidad, contactoId: calidad === 'paciente' || !c ? undefined : c.id };
  }
  const candidatos = $derived(contactos.filter(c => calidad === 'representante_legal' ? c.tipo === 'representante_legal' : true));
  const firmanteListo = $derived(calidad === 'paciente' || !!firmante().nombre);

  async function abrirDoc(p: PlantillaDocumentoDto) {
    actual = p; calidad = 'paciente'; contactoId = ''; nombreFirmante = ''; dniFirmante = ''; mensajeOk = ''; vista = null; errorVista = ''; abierto = true;
    await refrescarVista();
  }
  async function refrescarVista() {
    if (!actual) return;
    cargandoVista = true; errorVista = '';
    const r = await spd.vistaDocumento(actual.codigo, pacienteId, firmanteListo ? firmante() : undefined);
    cargandoVista = false;
    if (r.ok) vista = r.datos; else errorVista = r.error;
  }
  $effect(() => { calidad; contactoId; if (abierto) void refrescarVista(); });

  function htmlImprimible(v: VistaDocumento, titulo: string): string {
    const marca = v.esBorrador ? '<div class="marca">BORRADOR · pendiente de revisión jurídica</div>' : '';
    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${escaparHtml(titulo)}</title><style>@page{size:A4;margin:18mm}body{font-family:Georgia,serif;font-size:11.5pt;line-height:1.4;color:#000}.marca{border:2px solid #b42318;color:#b42318;padding:2mm 4mm;font-weight:bold;margin-bottom:6mm;text-align:center}mark{background:#fff3b0}h3{font-size:13pt}</style></head><body>${marca}<div>${mdBasico(v.texto)}</div></body></html>`;
  }
  async function imprimir() {
    if (!vista || !actual) return;
    trabajando = true;
    const r = await spd.imprimirHtml(htmlImprimible(vista, actual.titulo), { impresora: undefined, silenciosa: false });
    trabajando = false;
    mensajeOk = r.ok ? 'Enviado a la impresora.' : `No se pudo imprimir: ${r.error}`;
  }
  async function marcarFirmado() {
    if (!actual) return;
    trabajando = true; errorVista = '';
    const r = await spd.registrarDocumentoFirmado(actual.codigo, pacienteId, firmante());
    trabajando = false;
    if (!r.ok) { errorVista = r.error; return; }
    const ids = leerLocal<Record<string, number>>(claveIds, {}); ids[actual.codigo] = r.datos.id; guardarLocal(claveIds, ids);
    abierto = false; await cargar();
  }
  function pedirRevocar(f: Fila) {
    const id = f.firmado?.id ?? leerLocal<Record<string, number>>(claveIds, {})[f.p.codigo];
    if (!id) { error = 'Este documento se firmó antes y desde aquí no se puede localizar para revocarlo. Pídelo al titular.'; return; }
    revocando = { id, titulo: f.p.titulo }; motivo = ''; errorRev = ''; abiertoRev = true;
  }
  async function revocar() {
    if (!revocando) return;
    if (!motivo.trim()) { errorRev = 'Escribe el motivo: queda en el historial.'; return; }
    const r = await spd.revocarDocumento(revocando.id, motivo.trim());
    if (!r.ok) { errorRev = r.error; return; }
    abiertoRev = false; await cargar();
  }
</script>

<h2>Consentimientos y documentos</h2>
{#if error}<Nota gravedad="atencion">{error}</Nota>{/if}
{#if cargando}<div class="cargando-linea">Cargando…</div>
{:else}
  {#if estado?.completo}<Nota gravedad="ok" id="docs-completos">Están todos los consentimientos necesarios para validar un blíster.</Nota>
  {:else}<Nota gravedad="bloqueo" id="docs-faltan"><strong>Faltan consentimientos.</strong> Sin ellos no se puede validar ningún blíster de este paciente.</Nota>{/if}
  <div class="tarjeta scroll-x margen-s">
    <table class="tabla" data-prueba="tabla-docs">
      <thead><tr><th>Documento</th><th>Estado</th><th>Firmado</th><th></th></tr></thead>
      <tbody>
        {#each filas as f (f.p.codigo)}
          <tr>
            <td><strong>{f.p.titulo}</strong>{#if f.p.obligatorioParaValidar} <span class="etiqueta info">necesario para validar</span>{/if}</td>
            <td><span class="etiqueta {ROT[f.situacion].c}">{ROT[f.situacion].t}</span></td>
            <td class="suave">{f.firmado ? `${fechaHora(f.firmado.firmadoEn)} · ${f.firmado.firmante}` : '—'}</td>
            <td class="derecha nowrap">
              <button class="btn mini" class:principal={f.situacion !== 'vigente'} type="button" onclick={() => abrirDoc(f.p)} data-prueba="doc-{f.p.codigo}">{f.situacion === 'vigente' ? 'Ver' : 'Preparar para firmar'}</button>
              {#if f.situacion === 'vigente'}<button class="btn mini peligro" type="button" onclick={() => pedirRevocar(f)}>Revocar</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<Modal titulo={actual?.titulo ?? 'Documento'} bind:abierto ancho>
  {#if vista?.esBorrador}<Nota gravedad="atencion"><strong>BORRADOR.</strong> Este texto es un modelo pendiente de revisión por un abogado. Impreso lleva la marca de borrador.</Nota>{/if}
  <div class="dos-campos">
    <div class="campo"><label for="firma-calidad">¿Quién firma?</label>
      <select id="firma-calidad" bind:value={calidad} data-prueba="firma-calidad">{#each CALIDADES as c (c.v)}<option value={c.v}>{c.t}</option>{/each}</select></div>
    {#if calidad !== 'paciente'}
      <div class="campo"><label for="firma-contacto">Elegir de sus contactos</label>
        <select id="firma-contacto" bind:value={contactoId}><option value="">Otra persona (la escribo)</option>{#each candidatos as c (c.id)}<option value={c.id}>{c.nombre}{c.parentesco ? ' (' + c.parentesco + ')' : ''}</option>{/each}</select></div>
    {/if}
  </div>
  {#if calidad !== 'paciente' && contactoId === ''}
    <div class="dos-campos">
      <div class="campo"><label for="firma-nombre">Nombre y apellidos de quien firma</label><input id="firma-nombre" bind:value={nombreFirmante} onchange={refrescarVista} /></div>
      <div class="campo"><label for="firma-dni">DNI / NIE</label><input id="firma-dni" bind:value={dniFirmante} onchange={refrescarVista} /></div>
    </div>
  {/if}
  {#if errorVista}<Nota gravedad="bloqueo">{errorVista}</Nota>{/if}
  {#if mensajeOk}<Nota gravedad="info">{mensajeOk}</Nota>{/if}
  {#if cargandoVista && !vista}<div class="cargando-linea">Preparando el documento…</div>{/if}
  {#if vista}
    {#each vista.avisos as a (a)}<Nota gravedad="atencion">{a}</Nota>{/each}
    {#if vista.faltan.length}<Nota gravedad="bloqueo">Faltan datos de la farmacia para completar el documento (NIF, contacto de protección de datos…). Complétalos en Ajustes → Farmacia; mientras tanto no se puede registrar la firma.</Nota>{/if}
    <div class="tarjeta" style="max-height:46vh;overflow:auto;line-height:1.5" data-prueba="texto-documento">{@html mdBasico(vista.texto)}</div>
  {/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (abierto = false)}>Cerrar</button>
    <button class="btn" type="button" onclick={imprimir} disabled={!vista || trabajando}>Imprimir</button>
    <button class="btn principal" type="button" onclick={marcarFirmado} disabled={!vista || trabajando || !firmanteListo || (vista?.faltan.length ?? 0) > 0} data-prueba="marcar-firmado">Marcar como firmado</button>
  {/snippet}
</Modal>

<Modal titulo="Revocar el documento" bind:abierto={abiertoRev}>
  {#if revocando}
    <p>Se revocará <strong>{revocando.titulo}</strong>. Mientras no se firme otro, no se podrán validar blísteres de este paciente.</p>
    <div class="campo"><label for="motivo-rev">Motivo</label><textarea id="motivo-rev" bind:value={motivo}></textarea></div>
    {#if errorRev}<Nota gravedad="bloqueo">{errorRev}</Nota>{/if}
  {/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (abiertoRev = false)}>No revocar</button>
    <button class="btn peligro" type="button" onclick={revocar}>Revocar</button>
  {/snippet}
</Modal>
