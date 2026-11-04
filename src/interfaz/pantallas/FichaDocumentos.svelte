<script lang="ts">
  /** Pestaña «Documentos»: consentimientos del paciente (qué falta, vista previa, imprimir, firma, revocación). */
  import { spd, datos } from '../api.ts';
  import type { ContactoDto, EstadoConsentimientosDto, PlantillaDocumentoDto, VistaDocumento } from '../../servicios/api.ts';
  import { GESTIONABLES_SIN_FIRMA } from '../../dominio/documentos-gestion.ts';
  import { fechaHora } from '../lib/formato.ts';
  import '../estilos/u2.css';
  import Modal from './preparacion/Modal.svelte';
  import Nota from './preparacion/Nota.svelte';
  import { cargarSesion, guardarLocal, htmlDocumentoImprimible, ir, nombrePdfSugerido, leerLocal, mdBasico, mensaje, puedeValidar, rutas } from './preparacion/util.ts';
  import { mensajeError } from '../componentes/util.ts';

  type Calidad = 'paciente' | 'representante_legal' | 'guardador_de_hecho';
  let { pacienteId }: { pacienteId: number } = $props();

  let plantillas = $state<PlantillaDocumentoDto[]>([]);
  let estado = $state<EstadoConsentimientosDto | null>(null);
  let contactos = $state<ContactoDto[]>([]);
  let nombrePaciente = $state(''); let deCentro = $state(false); let puedeGestionar = $state(false);
  let cargando = $state(true); let error = $state('');

  let actual = $state<PlantillaDocumentoDto | null>(null); let abierto = $state(false);
  let calidad = $state<Calidad>('paciente'); let contactoId = $state<number | ''>('');
  let nombreFirmante = $state(''); let dniFirmante = $state('');
  let vista = $state<VistaDocumento | null>(null); let cargandoVista = $state(false); let errorVista = $state('');
  let trabajando = $state(false); let mensajeOk = $state('');
  // Ya hay una firma vigente de este documento: sólo se registra otra si sustituye a la anterior, con motivo (la anterior queda revocada, no se borra).
  let yaFirmado = $state(false); let sustituyendo = $state(false); let motivoSust = $state(''); let errorSust = $state('');

  let revocando = $state<{ id: number; titulo: string } | null>(null); let abiertoRev = $state(false); let motivo = $state(''); let errorRev = $state('');

  // Qué datos faltan y de QUIÉN son (la ruta de cada variable empieza por farmacia., paciente., firmante., autorizado…): cada uno se arregla en un sitio distinto.
  const NOMBRE_DATO: Record<string, string> = {
    'farmacia.nombre': 'nombre de la farmacia', 'farmacia.titular': 'titular', 'farmacia.nif': 'NIF', 'farmacia.direccion': 'dirección', 'farmacia.municipio': 'municipio',
    'farmacia.rgpd_contacto': 'contacto de protección de datos', 'farmacia.rgpd_dpd': 'delegado de protección de datos', 'farmacia.rgpd_responsable': 'responsable del tratamiento',
    'paciente.nombre_completo': 'nombre del paciente', 'paciente.dni_nie': 'DNI/NIE del paciente',
    'autorizado.nombre': 'nombre de la persona autorizada', 'autorizado.dni_nie': 'DNI/NIE de la persona autorizada', 'autorizado.parentesco': 'relación de la persona autorizada', 'autorizado.telefono': 'teléfono de la persona autorizada',
    'firmante.nombre': 'nombre de quien firma', 'firmante.dni_nie': 'DNI/NIE de quien firma', 'firmante.calidad': 'calidad de quien firma',
  };
  const dato = (r: string) => NOMBRE_DATO[r] ?? r.replace(/\./g, ': ').replace(/dni_nie/g, 'DNI/NIE').replace(/_/g, ' ');
  type Entidad = 'paciente' | 'firmante' | 'farmacia' | 'autorizado' | 'documento' | 'otro';
  const entidadDe = (r: string): Entidad => (['paciente', 'firmante', 'farmacia', 'autorizado'] as const).find(e => r.startsWith(e + '.')) ?? 'otro';
  /** Lo que falta agrupado por de quién es el dato, con la etiqueta de cada campo y a dónde ir a corregirlo. */
  const gruposFalta = $derived.by(() => {
    const detalle = vista?.faltanDetalle ?? (vista?.faltan ?? []).map(r => ({ ruta: r, entidad: entidadDe(r), campo: r, etiqueta: dato(r) }));
    const orden: Entidad[] = ['farmacia', 'paciente', 'firmante', 'autorizado', 'documento', 'otro'];
    return orden.map(e => {
      const campos = [...new Set(detalle.filter(f => f.entidad === e).map(f => (f.etiqueta === f.ruta ? dato(f.ruta) : f.etiqueta)))];
      return { entidad: e, campos };
    }).filter(g => g.campos.length);
  });
  /** Dónde se corrige cada grupo (la ficha, Ajustes…). `ruta` navega; `texto` explica lo que no tiene pantalla propia. */
  function dondeCorregir(e: Entidad): { titulo: string; enlace?: { texto: string; ruta: string }; ayuda?: string } {
    switch (e) {
      case 'farmacia': return { titulo: 'Faltan datos de la farmacia', enlace: { texto: 'Ir a Ajustes → Farmacia', ruta: '#/ajustes/farmacia' } };
      case 'paciente': return { titulo: 'Faltan datos del paciente', enlace: { texto: 'Completar en la pestaña Datos', ruta: rutas.paciente(pacienteId, 'datos') } };
      case 'firmante': return calidad === 'paciente'
        ? { titulo: 'Faltan datos de quien firma (el paciente)', enlace: { texto: 'Completar en la pestaña Datos', ruta: rutas.paciente(pacienteId, 'datos') } }
        : { titulo: 'Faltan datos de quien firma', ayuda: 'Escríbelos arriba, o elige a la persona entre los contactos del paciente.' };
      case 'autorizado': return { titulo: 'Faltan datos de la persona autorizada', enlace: { texto: 'Completar en Contactos (pestaña Datos)', ruta: rutas.paciente(pacienteId, 'datos') } };
      default: return { titulo: 'Faltan otros datos del documento', ayuda: 'Este documento necesita información que el programa no tiene todavía; no se puede registrar la firma hasta tenerla.' };
    }
  }
  const claveIds = $derived(`spd.docs.firmados.${pacienteId}`);
  const CALIDADES: { v: Calidad; t: string }[] = [{ v: 'paciente', t: 'El propio paciente' }, { v: 'representante_legal', t: 'Su representante legal' }, { v: 'guardador_de_hecho', t: 'Un guardador de hecho' }];

  async function cargar() {
    cargando = true; error = '';
    try {
      const [p, e, c, pac] = await Promise.all([datos(spd.listarPlantillasDocumento()), datos(spd.estadoConsentimientos(pacienteId)), datos(spd.listarContactos(pacienteId)), datos(spd.obtenerPaciente(pacienteId))]);
      plantillas = p; estado = e; contactos = c;
      nombrePaciente = [pac.nombre, pac.apellido1, pac.apellido2].filter(Boolean).join(' ');
      deCentro = !!pac.centroId;
      puedeGestionar = puedeValidar((await cargarSesion())?.rol);
    } catch (x) { error = mensaje(x); } finally { cargando = false; }
  }
  $effect(() => { pacienteId; void cargar(); });

  type Firmado = EstadoConsentimientosDto['firmados'][number];
  type Fila = { p: PlantillaDocumentoDto; situacion: 'vigente' | 'gestionado' | 'falta' | 'desactualizado' | 'revocado'; firmado?: Firmado };
  const filas = $derived.by<Fila[]>(() => plantillas.map(p => {
    // El documento que cuenta es el último que no esté revocado (si todos lo están, el último).
    const propios = (estado?.firmados ?? []).filter(x => x.codigo === p.codigo);
    const f = [...propios].reverse().find(x => !x.revocado) ?? propios[propios.length - 1];
    const situacion = estado?.revocados.includes(p.codigo) ? 'revocado' : estado?.desactualizados.includes(p.codigo) ? 'desactualizado'
      : f && f.origen === 'gestionado_sin_firma' && !f.revocado ? 'gestionado' : f ? 'vigente' : 'falta';
    return { p, situacion, firmado: f };
  }));
  const textoGestionado = $derived(deCentro ? 'Gestionado por el centro, sin firma individual' : 'Gestionado por la farmacia, sin firma individual');
  const ROT = { vigente: { t: 'Firmado y vigente', c: 'ok' }, gestionado: { t: 'Gestionado, sin firma individual', c: 'info' }, falta: { t: 'Falta', c: 'bloqueo' }, desactualizado: { t: 'Hay una versión nueva', c: 'atencion' }, revocado: { t: 'Revocado', c: 'bloqueo' } } as const;
  // «Falta» en rojo sólo si la farmacia lo exige para validar; si no, es información.
  const claseFalta = (f: Fila) => (estado && !estado.exigido && (f.situacion === 'falta' || f.situacion === 'revocado' || f.situacion === 'desactualizado') ? 'info' : ROT[f.situacion].c);

  // «Gestionado sin firma individual» (lo recoge el centro, p. ej.): no es una firma; queda con su motivo, quién y cuándo.
  let gestionando = $state<PlantillaDocumentoDto | null>(null); let abiertoGes = $state(false); let motivoGes = $state(''); let errorGes = $state(''); let ocupadoGes = $state(false);
  function pedirGestionar(p: PlantillaDocumentoDto) { gestionando = p; motivoGes = ''; errorGes = ''; abiertoGes = true; }
  async function gestionar() {
    if (!gestionando) return;
    if (motivoGes.trim().length < 5) { errorGes = 'Escribe el motivo (p. ej. «Consentimiento recogido por el centro»): queda en el historial.'; return; }
    ocupadoGes = true; errorGes = '';
    const r = await spd.gestionarDocumentosSinFirma({ pacienteIds: [pacienteId], codigos: [gestionando.codigo], motivo: motivoGes.trim() });
    ocupadoGes = false;
    if (!r.ok) { errorGes = mensajeError(r); return; }
    abiertoGes = false; await cargar();
  }

  function firmante() {
    const c = contactos.find(x => x.id === contactoId);
    const nombre = calidad === 'paciente' ? nombrePaciente : (c?.nombre ?? nombreFirmante).trim();
    return { nombre, dniNie: calidad === 'paciente' ? undefined : (c?.dniNie ?? dniFirmante).trim() || undefined, calidad, contactoId: calidad === 'paciente' || !c ? undefined : c.id };
  }
  const candidatos = $derived(contactos.filter(c => calidad === 'representante_legal' ? c.tipo === 'representante_legal' : true));
  const firmanteListo = $derived(calidad === 'paciente' || !!firmante().nombre);

  async function abrirDoc(p: PlantillaDocumentoDto) {
    yaFirmado = false; sustituyendo = false; motivoSust = ''; errorSust = ''; actual = p; calidad = 'paciente'; contactoId = ''; nombreFirmante = ''; dniFirmante = ''; mensajeOk = ''; vista = null; errorVista = ''; abierto = true;
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

  async function imprimir() {
    if (!vista || !actual) return;
    trabajando = true;
    const r = await spd.imprimirHtml(htmlDocumentoImprimible(vista.texto, actual.titulo), { impresora: undefined, silenciosa: false });
    trabajando = false;
    mensajeOk = r.ok ? 'Enviado a la impresora.' : `No se pudo imprimir: ${r.error}`;
  }
  async function guardarPdf() {
    if (!vista || !actual) return;
    trabajando = true;
    const r = await spd.exportarPdf(htmlDocumentoImprimible(vista.texto, actual.titulo), nombrePdfSugerido(actual.codigo, nombrePaciente));
    trabajando = false;
    if (!r.ok) mensajeOk = `No se pudo guardar el PDF: ${r.error} Comprueba que la carpeta elegida existe y que puedes escribir en ella, o prueba con otra.`;
    else if (r.datos) mensajeOk = `PDF guardado en ${r.datos.ruta}. Ya puedes imprimirlo desde otro equipo o programa.`;
  }
  async function marcarFirmado(sustituir = false) {
    if (!actual) return;
    if (sustituir && motivoSust.trim().length < 5) { errorSust = 'Escribe el motivo de la sustitución (unas palabras bastan, mínimo 5 letras): queda en el historial.'; return; }
    trabajando = true; errorVista = ''; errorSust = '';
    const r = await spd.registrarDocumentoFirmado(actual.codigo, pacienteId, firmante(), sustituir ? { sustituir: true, motivo: motivoSust.trim() } : undefined);
    trabajando = false;
    if (!r.ok) {
      if (r.codigo === 'DOCUMENTO_YA_FIRMADO') { yaFirmado = true; return; }
      if (sustituir) errorSust = mensajeError(r); else errorVista = mensajeError(r);
      return;
    }
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
  {#if estado?.completo}<Nota gravedad="ok" id="docs-completos">Están todos los consentimientos necesarios para validar un blíster.{#if estado.gestionados.length} Algunos constan sólo como <strong>gestionados sin firma individual</strong> (no hay firma del paciente).{/if}</Nota>
  {:else if estado && !estado.exigido}<Nota gravedad="info" id="docs-no-exigidos"><strong>Hay consentimientos pendientes, pero esta farmacia no los exige para validar.</strong> La farmacia gestiona los consentimientos fuera del programa (Ajustes → Consentimientos).</Nota>
  {:else}<Nota gravedad="bloqueo" id="docs-faltan"><strong>Faltan consentimientos.</strong> Sin ellos no se puede validar ningún blíster de este paciente.</Nota>{/if}
  <div class="tarjeta scroll-x margen-s">
    <table class="tabla" data-prueba="tabla-docs">
      <thead><tr><th>Documento</th><th>Estado</th><th>Firmado</th><th></th></tr></thead>
      <tbody>
        {#each filas as f (f.p.codigo)}
          <tr>
            <td><strong>{f.p.titulo}</strong>{#if f.p.obligatorioParaValidar} <span class="etiqueta info">necesario para validar</span>{/if}</td>
            <td><span class="etiqueta {claseFalta(f)}">{f.situacion === 'gestionado' ? textoGestionado : ROT[f.situacion].t}</span></td>
            <td class="suave">{#if f.firmado && f.firmado.origen === 'gestionado_sin_firma'}{fechaHora(f.firmado.firmadoEn)} · registrado por {f.firmado.registradoPor ?? '—'}{#if f.firmado.motivoGestion} · motivo: {f.firmado.motivoGestion}{/if}{:else if f.firmado}{fechaHora(f.firmado.firmadoEn)} · {f.firmado.firmante}{:else}—{/if}</td>
            <td class="derecha nowrap">
              <button class="btn mini" class:principal={f.situacion !== 'vigente'} type="button" onclick={() => abrirDoc(f.p)} aria-label="{f.situacion === 'vigente' ? 'Ver' : 'Preparar para firmar'}: {f.p.titulo}" data-prueba="doc-{f.p.codigo}">{f.situacion === 'vigente' ? 'Ver' : f.situacion === 'gestionado' ? 'Ver o recoger la firma' : 'Preparar para firmar'}</button>
              {#if puedeGestionar && GESTIONABLES_SIN_FIRMA.includes(f.p.codigo) && f.situacion !== 'vigente' && f.situacion !== 'gestionado'}<button class="btn mini" type="button" onclick={() => pedirGestionar(f.p)} aria-label="Registrar como gestionado sin firma individual: {f.p.titulo}" data-prueba="gestionar-{f.p.codigo}">Gestionado sin firma</button>{/if}
              {#if f.situacion === 'vigente' || f.situacion === 'gestionado'}<button class="btn mini peligro" type="button" onclick={() => pedirRevocar(f)} aria-label="Revocar: {f.p.titulo}">Revocar</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<Modal titulo={actual?.titulo ?? 'Documento'} bind:abierto ancho>
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
  {#if yaFirmado}
    <Nota gravedad="atencion" id="ya-firmado"><strong>Este documento ya está firmado y vigente.</strong> No se registra otra firma igual. Si la nueva sustituye a la anterior (otro firmante, otra versión del texto…), puedes sustituirla: la anterior queda revocada en el historial, no se borra.
      {#snippet accion()}{#if !sustituyendo}<button class="btn" type="button" onclick={() => (sustituyendo = true)} data-prueba="sustituir-firma">Sustituir firma anterior</button>{/if}{/snippet}
    </Nota>
    {#if sustituyendo}
      <div class="campo"><label for="motivo-sust">Motivo de la sustitución (obligatorio)</label>
        <textarea id="motivo-sust" bind:value={motivoSust} placeholder="Por qué se firma de nuevo: p. ej. firma ahora el representante legal"></textarea></div>
      {#if errorSust}<Nota gravedad="bloqueo">{errorSust}</Nota>{/if}
      <div class="fila"><button class="btn principal" type="button" onclick={() => marcarFirmado(true)} disabled={trabajando || (vista?.faltan.length ?? 0) > 0 || !firmanteListo} data-prueba="confirmar-sustitucion">Sustituir la firma anterior</button>
        <button class="btn" type="button" onclick={() => { sustituyendo = false; yaFirmado = false; motivoSust = ''; errorSust = ''; }}>No sustituir</button></div>
    {/if}
  {/if}
  {#if mensajeOk}<Nota gravedad="info">{mensajeOk}</Nota>{/if}
  {#if cargandoVista && !vista}<div class="cargando-linea">Preparando el documento…</div>{/if}
  {#if vista}
    {#each vista.avisos as a (a)}<Nota gravedad="atencion">{a}</Nota>{/each}
    {#each gruposFalta as g (g.entidad)}
      {@const d = dondeCorregir(g.entidad)}
      <Nota gravedad="bloqueo"><strong>{d.titulo}:</strong> {g.campos.join(', ')}.{#if d.ayuda} {d.ayuda}{/if}
        {#snippet accion()}{#if d.enlace}<button class="btn" type="button" onclick={() => { abierto = false; ir(d.enlace!.ruta); }} data-prueba="falta-{g.entidad}">{d.enlace.texto}</button>{/if}{/snippet}
      </Nota>
    {/each}
    {#if gruposFalta.length}<p class="suave pequeno sin-margen">Mientras falte algún dato no se puede registrar la firma.</p>{/if}
    <div class="tarjeta" style="max-height:46vh;overflow:auto;line-height:1.5" data-prueba="texto-documento">{@html mdBasico(vista.texto)}</div>
  {/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (abierto = false)}>Cerrar</button>
    <button class="btn" type="button" onclick={guardarPdf} disabled={!vista || trabajando} data-prueba="guardar-pdf">Guardar como PDF</button>
    <button class="btn" type="button" onclick={imprimir} disabled={!vista || trabajando}>Imprimir</button>
    <button class="btn principal" type="button" onclick={() => marcarFirmado()} disabled={!vista || trabajando || !firmanteListo || (vista?.faltan.length ?? 0) > 0} data-prueba="marcar-firmado">Marcar como firmado</button>
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

<Modal titulo="Registrar como gestionado sin firma individual" bind:abierto={abiertoGes}>
  {#if gestionando}
    <p><strong>{gestionando.titulo}</strong> · {nombrePaciente}</p>
    <Nota gravedad="atencion">Esto <strong>no es una firma</strong>: queda registrado que la farmacia da el documento por gestionado sin firma individual (p. ej. lo recoge el centro). Se verá siempre como «{textoGestionado}», con su fecha, usuario y motivo, y se puede revocar. La farmacia asume la responsabilidad de ese consentimiento.</Nota>
    <div class="campo"><label for="motivo-ges">Motivo (obligatorio)</label><textarea id="motivo-ges" bind:value={motivoGes} placeholder="Ej.: Consentimiento recogido por el centro" data-prueba="motivo-gestion"></textarea></div>
    {#if errorGes}<Nota gravedad="bloqueo">{errorGes}</Nota>{/if}
  {/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (abiertoGes = false)}>Cancelar</button>
    <button class="btn principal" type="button" onclick={gestionar} disabled={ocupadoGes} data-prueba="confirmar-gestion">Registrar como gestionado</button>
  {/snippet}
</Modal>
