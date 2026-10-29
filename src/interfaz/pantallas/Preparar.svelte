<script lang="ts">
  /**
   * Preparar un blíster: asistente de tres pasos «Revisar → Llenar → Validar».
   * El programa decide (bloqueos, avisos, mapa, caducidad); esta pantalla lo enseña y guía las manos.
   */
  import { onMount } from 'svelte';
  import { spd, datos } from '../api.ts';
  import type { Ajustes, EvaluacionPreparacion, EvaluarPreparacionParams, PreparacionDto, UsuarioPublico } from '../../servicios/api.ts';
  import { diasHasta, hoyIso, sumarDias } from '../lib/formato.ts';
  import '../estilos/u2.css';
  import { hojaTrabajoHtml } from './preparacion/hoja.ts';
  import Modal from './preparacion/Modal.svelte';
  import Nota from './preparacion/Nota.svelte';
  import PasoLlenar from './preparacion/PasoLlenar.svelte';
  import PasoRevisar from './preparacion/PasoRevisar.svelte';
  import PasoValidar from './preparacion/PasoValidar.svelte';
  import type { EntradaPreparar } from './preparacion/tipos.ts';
  import VistaPrevia from './preparacion/VistaPrevia.svelte';
  import { borrarLocal, cargarSesion, corto, guardarLocal, leerLocal, mensaje, tomarPaso } from './preparacion/util.ts';

  let { pacienteId }: { pacienteId?: number } = $props();
  type Paso = 'revisar' | 'llenar' | 'validar';
  const CLAVE_CURSO = 'spd.preparar.curso';

  const hoy = hoyIso();
  function proximoLunes(): string {
    const dow = new Date(hoy + 'T00:00:00Z').getUTCDay() || 7;
    return sumarDias(hoy, 8 - dow);
  }
  const nuevaEntrada = (): EntradaPreparar => ({ paciente: null, modoInicio: 'lunes', desde: proximoLunes(), dias: 7, validez: 14, justificacion: '' });

  let sesion = $state<UsuarioPublico | null>(null);
  let ajustes = $state<Ajustes | null>(null);
  let entrada = $state<EntradaPreparar>(nuevaEntrada());
  let evaluacion = $state<EvaluacionPreparacion | null>(null);
  let evaluando = $state(false); let errorEval = $state('');
  let preparacion = $state<PreparacionDto | null>(null);
  let paso = $state<Paso>('revisar');
  let marcando = $state(false); let errorMarcar = $state('');
  let listo = $state(false); let errorCarga = $state('');
  let hojaAbierta = $state(false);

  const claveLlenado = $derived(`spd.llenado.${entrada.paciente?.id ?? 0}.${entrada.desde}.${entrada.dias}`);
  const bloqueada = $derived(!!preparacion);

  onMount(async () => {
    sesion = await cargarSesion();
    try { ajustes = await datos(spd.obtenerAjustes()); } catch { /* sin ajustes: valores estándar */ }
    const abrir = tomarPaso('spd.abrirPreparacion');
    try {
      if (abrir && Number(abrir)) await abrirExistente(Number(abrir));
      else {
        const curso = leerLocal<{ preparacionId?: number; entrada?: EntradaPreparar; paso?: Paso } | null>(CLAVE_CURSO, null);
        if (curso?.preparacionId && (!pacienteId || curso.entrada?.paciente?.id === pacienteId)) await abrirExistente(curso.preparacionId, curso.paso);
        else if (curso?.entrada && !pacienteId) { entrada = { ...nuevaEntrada(), ...curso.entrada, desde: curso.entrada.desde >= hoy ? curso.entrada.desde : proximoLunes() }; }
      }
    } catch (e) { errorCarga = mensaje(e); borrarLocal(CLAVE_CURSO); }
    listo = true;
  });

  async function abrirExistente(id: number, pasoPreferido?: Paso) {
    const r = await datos(spd.obtenerPreparacion(id));
    const p = r.preparacion;
    if (p.estado === 'anulado') { errorCarga = `El blíster ${p.idPublico} está anulado: no se puede continuar con él.`; borrarLocal(CLAVE_CURSO); return; }
    preparacion = p; evaluacion = r.evaluacion;
    entrada = { paciente: { id: p.pacienteId, nombre: p.pacienteNombre }, modoInicio: 'otra', desde: p.fechaInicio,
      dias: ([7, 14, 28].includes(diasHasta(p.fechaInicio, p.fechaFin) + 1) ? diasHasta(p.fechaInicio, p.fechaFin) + 1 : 7) as 7 | 14 | 28, validez: p.validezDias, justificacion: p.justificacionValidez ?? '' };
    paso = p.estado === 'borrador' ? (pasoPreferido === 'revisar' ? 'revisar' : 'llenar') : 'validar';
  }

  // Recuerda dónde se quedó (se retoma tras una interrupción)
  $effect(() => {
    if (!listo) return;
    if (preparacion?.estado === 'entregado' || preparacion?.estado === 'anulado') { borrarLocal(CLAVE_CURSO); return; }
    guardarLocal(CLAVE_CURSO, { preparacionId: preparacion?.id, entrada: $state.snapshot(entrada), paso });
  });

  // Evaluación automática al cambiar paciente / fechas / validez (mientras aún no hay borrador guardado)
  let seq = 0;
  function paramsEval(): EvaluarPreparacionParams | null {
    if (!entrada.paciente || !/^\d{4}-\d{2}-\d{2}$/.test(entrada.desde)) return null;
    return { pacienteId: entrada.paciente.id, desde: entrada.desde, dias: entrada.dias, fechaPreparacion: hoy, diasValidez: entrada.validez, justificacion: entrada.justificacion.trim() || undefined };
  }
  $effect(() => {
    const p = paramsEval(); const congelada = bloqueada; const ok = listo;
    if (!ok || congelada) return;
    if (!p) { evaluacion = null; errorEval = ''; return; }
    const mi = ++seq; evaluando = true;
    const t = setTimeout(async () => {
      const r = await spd.evaluarPreparacion(p);
      if (mi !== seq) return;
      evaluando = false;
      if (r.ok) { evaluacion = r.datos; errorEval = ''; } else { evaluacion = null; errorEval = r.error; }
    }, 300);
    return () => clearTimeout(t);
  });

  async function marcarPreparado(c: { temperatura: number; humedad: number; observaciones?: string }) {
    marcando = true; errorMarcar = '';
    try {
      let id = preparacion?.id;
      if (!id) {
        const p = paramsEval()!;
        const creada = await datos(spd.crearPreparacion({ ...p, temperatura: c.temperatura, humedad: c.humedad, observaciones: c.observaciones }));
        preparacion = creada; id = creada.id;
      }
      if (preparacion!.estado === 'borrador') preparacion = await datos(spd.marcarPreparada(id));
      const r = await datos(spd.obtenerPreparacion(id));
      preparacion = r.preparacion; evaluacion = r.evaluacion;
      paso = 'validar';
    } catch (e) { errorMarcar = mensaje(e); } finally { marcando = false; }
  }
  function cambioPreparacion(p: PreparacionDto) { preparacion = p; }
  function nueva() { borrarLocal(CLAVE_CURSO); preparacion = null; evaluacion = null; entrada = { ...nuevaEntrada(), paciente: null }; paso = 'revisar'; errorMarcar = ''; errorCarga = ''; }

  const puedeIr = (p: Paso) => p === 'revisar' ? !preparacion || preparacion.estado === 'borrador' || preparacion.estado === 'preparado'
    : p === 'llenar' ? !!evaluacion && (!preparacion || preparacion.estado === 'borrador' || preparacion.estado === 'preparado')
    : !!preparacion && preparacion.estado !== 'borrador';
  const PASOS: { id: Paso; nombre: string }[] = [{ id: 'revisar', nombre: 'Revisar' }, { id: 'llenar', nombre: 'Llenar' }, { id: 'validar', nombre: 'Validar' }];
  const orden = (p: Paso) => PASOS.findIndex(x => x.id === p);

  const hojaVista = $derived(evaluacion ? { html: hojaTrabajoHtml(evaluacion, { desde: entrada.desde, dias: entrada.dias }), imprimible: true, problemas: [], faltan: [] } : null);
</script>

<div class="cabecera-pagina">
  <div>
    <h1>Preparar un blíster</h1>
    <p class="subtitulo">{entrada.paciente ? entrada.paciente.nombre : 'Revisa, llena y valida, paso a paso.'}{preparacion ? ` · ${corto(preparacion.idPublico)}` : ''}</p>
  </div>
  <span class="espacio"></span>
  {#if preparacion || entrada.paciente}<button class="btn" type="button" onclick={nueva}>Empezar de nuevo</button>{/if}
</div>

<nav class="pasos" aria-label="Pasos para preparar">
  {#each PASOS as p, i (p.id)}
    <button type="button" class="paso" class:activo={paso === p.id} class:hecho={orden(paso) > i} aria-current={paso === p.id ? 'step' : undefined}
      disabled={!puedeIr(p.id)} onclick={() => (paso = p.id)} style="cursor:{puedeIr(p.id) ? 'pointer' : 'default'};font:inherit;text-align:left" data-prueba="paso-{p.id}">
      <span class="num">{orden(paso) > i ? '✓' : i + 1}</span><span class="txt">{p.nombre}</span>
    </button>
  {/each}
</nav>

{#if errorCarga}<Nota gravedad="atencion">{errorCarga}</Nota>{/if}

{#if !listo}
  <div class="cargando-linea">Cargando…</div>
{:else if paso === 'revisar'}
  <PasoRevisar bind:entrada pacienteIdInicial={pacienteId} {ajustes} {evaluacion} {evaluando} {errorEval} {bloqueada}
    onSiguiente={() => (paso = 'llenar')} onHoja={() => (hojaAbierta = true)} />
{:else if paso === 'llenar' && evaluacion}
  {#key claveLlenado}
    <PasoLlenar {evaluacion} claveGuardado={claveLlenado} {ajustes} {marcando} {errorMarcar} yaPreparado={preparacion?.estado === 'preparado'}
      onMarcar={marcarPreparado} onHoja={() => (hojaAbierta = true)} onAtras={() => (paso = 'revisar')} />
  {/key}
{:else if paso === 'validar' && evaluacion && preparacion}
  <PasoValidar {evaluacion} {preparacion} {sesion} {ajustes} onCambio={cambioPreparacion} onAtras={() => (paso = 'llenar')} onNueva={nueva} />
{/if}

<Modal titulo="Hoja de trabajo" bind:abierto={hojaAbierta} ancho>
  {#if hojaVista}<VistaPrevia titulo="Hoja de trabajo para la mesa" vista={hojaVista} nombreArchivo="hoja-de-trabajo.pdf" impresora={ajustes?.impresoraDocumentos} />{/if}
</Modal>
