<script lang="ts">
  /**
   * Entrada de cajas: una pantalla, un campo de escaneo con el foco permanente.
   * Lote y caducidad son obligatorios; el DataMatrix es opcional (sin lector se teclean).
   * Las reglas (bloqueos, avisos, caducidad próxima…) las decide el programa: aquí sólo se enseñan.
   */
  import { onMount, tick } from 'svelte';
  import { spd, datos } from '../api.ts';
  import type { Ajustes, EntradaEnvaseParams, MedicamentoDto, ResultadoEntradaEnvase, TratamientoDto } from '../../servicios/api.ts';
  import { normalizarCN, parsearGS1, GS } from '../../dominio/gs1.ts';
  import { fecha, hoyIso } from '../lib/formato.ts';
  import '../estilos/u2.css';
  import BuscaPaciente from './preparacion/BuscaPaciente.svelte';
  import Nota from './preparacion/Nota.svelte';
  import { dejarPaso, guardarLocal, ir, leerLocal, mensaje, pita, rutas } from './preparacion/util.ts';

  let { pacienteId }: { pacienteId?: number } = $props();

  // ── estado ──
  let ajustes = $state<Ajustes | null>(null);
  let paciente = $state<{ id: number; nombre: string } | null>(null);
  let tratamientos = $state<TratamientoDto[]>([]);
  let tratamientoId = $state<number | ''>('');
  let cargandoTrat = $state(false);

  let escaneo = $state('');
  let cn = $state(''); let lote = $state(''); let caducidad = $state(''); let serie = $state('');
  let lectura = $state('');
  let unidadesTxt = $state(''); let unidadesEditadas = false;
  let medicamento = $state<MedicamentoDto | null | undefined>(undefined);   // undefined = sin consultar
  let ambiguas = $state<Record<string, string>[] | null>(null);
  let errorEscaneo = $state('');

  let resultado = $state<ResultadoEntradaEnvase | null>(null);
  let comprobando = $state(false);
  let errorComprobar = $state('');
  let guardando = $state(false);
  let exito = $state('');
  let errorGuardar = $state('');

  type Entrada = { hora: string; fecha: string; paciente: string; medicamento: string; lote: string; caducidad: string; unidades: number };
  let hoy = $state<Entrada[]>([]);

  let campoEscaneo: HTMLInputElement | undefined = $state();
  let campoLote: HTMLInputElement | undefined = $state();
  let campoCaducidad: HTMLInputElement | undefined = $state();
  let campoUnidades: HTMLInputElement | undefined = $state();
  let btnGuardar: HTMLButtonElement | undefined = $state();

  // ── derivados ──
  const cn6 = $derived(normalizarCN(cn));
  const unidades = $derived(Number(unidadesTxt.replace(',', '.')));
  const unidadesOk = $derived(Number.isFinite(unidades) && unidades > 0 && Number.isInteger(unidades));
  const hayBloqueos = $derived((resultado?.bloqueos.length ?? 0) > 0);
  const faltanCampos = $derived(!paciente || !cn6 || !lote.trim() || !caducidad.trim() || !unidadesOk);
  const puedeGuardar = $derived(!faltanCampos && !!resultado && !hayBloqueos && !comprobando && !guardando && !ambiguas);
  const tratamientoActual = $derived(tratamientos.find(t => t.id === tratamientoId));

  function parametros(): EntradaEnvaseParams | null {
    if (!paciente || !cn6) return null;
    return {
      pacienteId: paciente.id, tratamientoId: tratamientoId === '' ? null : tratamientoId,
      cn: cn.trim(), lote: lote.trim() || undefined, caducidad: caducidad.trim() || undefined,
      numeroSerie: serie.trim() || undefined, lecturaDatamatrix: lectura || undefined,
      unidades: unidadesOk ? unidades : 0,
    };
  }

  onMount(async () => {
    const hoyTxt = hoyIso();
    const guardadas = leerLocal<Entrada[]>('spd.cajas.hoy', []);
    hoy = guardadas.filter(e => e.fecha === hoyTxt);
    try { ajustes = await datos(spd.obtenerAjustes()); } catch { /* se usa el separador por defecto */ }
    const reenfocar = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest('input,select,textarea,button,a,label,dialog,summary')) campoEscaneo?.focus();
    };
    document.addEventListener('click', reenfocar);
    return () => document.removeEventListener('click', reenfocar);
  });

  // Paciente → sus tratamientos y cobertura
  $effect(() => {
    const id = paciente?.id;
    if (id) void cargarTratamientos(id); else { tratamientos = []; tratamientoId = ''; }
  });
  async function cargarTratamientos(id: number) {
    cargandoTrat = true;
    try {
      const t = await datos(spd.listarTratamientos(id, false));
      if (paciente?.id !== id) return;
      tratamientos = t;
      if (tratamientoId === '' || !t.some(x => x.id === tratamientoId)) tratamientoId = t.length === 1 ? t[0].id : '';
    } catch (e) { errorEscaneo = mensaje(e); } finally { cargandoTrat = false; }
  }

  // CN → ficha del medicamento (unidades por envase, ¿lo conocemos?) y tratamiento probable
  $effect(() => {
    const c = cn6;
    medicamento = undefined;
    if (!c) return;
    let vigente = true;
    spd.obtenerMedicamento(c).then(r => {
      if (!vigente) return;
      medicamento = r.ok ? r.datos : undefined;
      if (r.ok && r.datos) {
        if (!unidadesEditadas && r.datos.unidadesEnvase) unidadesTxt = String(r.datos.unidadesEnvase);
        if (tratamientoId === '') proponerTratamiento(c, r.datos);
      }
    });
    return () => { vigente = false; };
  });
  function proponerTratamiento(c: string, m: MedicamentoDto) {
    const exacto = tratamientos.filter(t => t.cnPreferente && normalizarCN(t.cnPreferente) === c);
    if (exacto.length === 1) { tratamientoId = exacto[0].id; return; }
    const pa = (m.principiosActivos ?? '').toLowerCase();
    const parecidos = pa ? tratamientos.filter(t => t.principioActivo && pa.includes(t.principioActivo.toLowerCase())) : [];
    if (parecidos.length === 1) tratamientoId = parecidos[0].id;
  }

  // Comprobación EN VIVO (sin guardar)
  let secuencia = 0;
  $effect(() => {
    const p = parametros();
    // dependencias explícitas para que Svelte las vigile aunque `parametros` salga antes
    void [lote, caducidad, serie, lectura, unidadesTxt, tratamientoId];
    if (!p) { resultado = null; errorComprobar = ''; return; }
    const mi = ++secuencia;
    comprobando = true;
    const t = setTimeout(async () => {
      const r = await spd.comprobarEntradaEnvase(p);
      if (mi !== secuencia) return;
      comprobando = false;
      if (r.ok) { resultado = r.datos; errorComprobar = ''; } else { resultado = null; errorComprobar = r.error; }
    }, 250);
    return () => clearTimeout(t);
  });

  // ── lectura del escáner ──
  function pareceDataMatrix(t: string, sep: string): boolean {
    return t.includes(GS) || t.startsWith(']d2') || (!!sep && t.includes(sep)) || t.replace(/\s/g, '').length > 14;
  }
  function limpiarCaja(conservarNada = true) {
    if (conservarNada) { cn = ''; lote = ''; caducidad = ''; serie = ''; lectura = ''; }
    ambiguas = null; unidadesEditadas = false; unidadesTxt = ''; exito = ''; errorGuardar = '';
  }
  async function procesarEscaneo(bruto: string) {
    const t = bruto.trim(); errorEscaneo = ''; exito = '';
    if (!t) return;
    const sep = ajustes?.lector.separadorGs ?? '';
    if (pareceDataMatrix(t, sep)) {
      const l = parsearGS1(bruto, { separadores: sep ? [sep] : [] });
      if (l.gtin === undefined) {
        const comoCn = normalizarCN(t);
        if (comoCn) { limpiarCaja(); cn = comoCn; }
        else { pita(); errorEscaneo = 'No he podido leer ese código. Vuelve a escanear la caja o escribe el código nacional, el lote y la caducidad a mano.'; return; }
      } else {
        limpiarCaja();
        cn = l.cn ?? ''; lote = l.lote ?? ''; caducidad = l.caducidad ?? ''; serie = l.serie ?? '';
        if (l.ambiguo) { ambiguas = l.candidatas; lectura = ''; pita(); }
        else lectura = bruto;
        if (!l.cn) errorEscaneo = 'Ese código no es de un envase español: escribe el código nacional a mano.';
      }
    } else {
      const c = normalizarCN(t);
      if (!c) { pita(); errorEscaneo = 'No reconozco ese código. El código nacional tiene 6 o 7 cifras.'; return; }
      limpiarCaja(); cn = c;
    }
    escaneo = '';
    await tick();
    siguienteCampo();
  }
  function siguienteCampo() {
    if (ambiguas) return;
    if (!lote.trim()) campoLote?.focus();
    else if (!caducidad.trim()) campoCaducidad?.focus();
    else if (!unidadesOk) campoUnidades?.focus();
    else campoEscaneo?.focus();
  }
  function teclaEscaneo(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (escaneo.trim()) void procesarEscaneo(escaneo);
    else if (puedeGuardar) void guardar();
    else siguienteCampo();
  }

  /** El lector no mandó el separador: el usuario confirma, mirando la caja, cuál es el lote. Se reconstruye la lectura con el separador en su sitio. */
  function confirmarCandidata(c: Record<string, string>) {
    lote = c['10'] ?? ''; serie = c['21'] ?? '';
    const partes = [`01${c['01']}`]; if (c['11']) partes.push(`11${c['11']}`); if (c['17']) partes.push(`17${c['17']}`);
    if (c['10']) partes.push(`10${c['10']}`);
    if (c['21']) partes.push((c['10'] ? GS : '') + `21${c['21']}`);
    lectura = partes.join('');
    ambiguas = null;
    void tick().then(() => campoEscaneo?.focus());
  }
  function rotuloCandidata(c: Record<string, string>) { return `Lote ${c['10'] ?? '—'}${c['21'] ? ' · serie ' + c['21'] : ' · sin serie'}`; }

  // Máscara de caducidad: MM/AAAA (o MM/AA) y AAAA-MM-DD
  function mascara(v: string): string {
    const limpio = v.replace(/[^0-9/\-]/g, '');
    const d = limpio.replace(/\D/g, '');
    if (d.length >= 2 && Number(d.slice(0, 2)) > 12) {            // empieza por el año → AAAA-MM-DD
      return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8)].filter(Boolean).join('-');
    }
    if (d.length <= 2) return limpio.endsWith('/') && d.length === 2 ? d + '/' : d;
    return d.slice(0, 2) + '/' + d.slice(2, 6);
  }
  function alCaducidad(e: Event) { const el = e.currentTarget as HTMLInputElement; caducidad = mascara(el.value); el.value = caducidad; }

  function pasarA(sig: () => HTMLElement | undefined) { return (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); sig()?.focus(); } }; }
  function enterUnidades(e: KeyboardEvent) { if (e.key === 'Enter') { e.preventDefault(); if (puedeGuardar) void guardar(); else btnGuardar?.focus(); } }

  async function guardar() {
    const p = parametros(); if (!p || !puedeGuardar) return;
    guardando = true; errorGuardar = ''; exito = '';
    const r = await spd.registrarEnvase(p);
    guardando = false;
    if (!r.ok) { errorGuardar = r.error; pita(); return; }
    if (!r.datos.ok) { resultado = r.datos; pita(); return; }
    const nombre = r.datos.medicamentoNombre ?? medicamento?.nombre ?? `CN ${cn6}`;
    const n = r.datos.normalizado;
    const nueva: Entrada = { hora: new Date().toTimeString().slice(0, 5), fecha: hoyIso(), paciente: paciente!.nombre, medicamento: nombre, lote: n?.lote ?? lote, caducidad: n?.caducidad ?? caducidad, unidades: n?.unidades ?? unidades };
    hoy = [nueva, ...hoy].slice(0, 60); guardarLocal('spd.cajas.hoy', hoy);
    exito = `Guardada: ${nombre}, lote ${nueva.lote}, ${nueva.unidades} unidades.`;
    limpiarCaja(); resultado = null; escaneo = '';
    await cargarTratamientos(paciente!.id);
    campoEscaneo?.focus();
  }

  function altaMedicamento() { dejarPaso('spd.medicamentos.altaCn', cn6 ?? cn); ir(rutas.medicamentos()); }
  function claseCobertura(d: number | null) { return d == null ? '' : d <= 0 ? 'poca' : d < 7 ? 'justa' : 'bien'; }
  function textoCobertura(d: number | null) { return d == null ? 'sin pauta' : d <= 0 ? 'no cubre ni un día' : d === 1 ? 'cubre 1 día' : `cubre ${d} días`; }
</script>

<div class="cabecera-pagina">
  <div>
    <h1>Entrada de cajas</h1>
    <p class="subtitulo">Escanea la caja o escribe su código nacional, el lote y la caducidad.</p>
  </div>
</div>

<div class="dos-col">
  <div class="apilado">
    <section class="tarjeta">
      <BuscaPaciente bind:paciente idInicial={pacienteId} enfocar={!pacienteId} etiqueta="¿De quién es la caja?" onElegir={() => setTimeout(() => campoEscaneo?.focus(), 0)} />
      {#if paciente}
        <div class="campo sin-margen">
          <label for="tratamiento">Tratamiento al que va</label>
          <select id="tratamiento" bind:value={tratamientoId} disabled={cargandoTrat}>
            <option value="">{tratamientos.length ? 'Que lo decida el programa por el medicamento' : 'Este paciente aún no tiene tratamientos'}</option>
            {#each tratamientos as t (t.id)}<option value={t.id}>{t.principioActivo}{t.dosisTexto ? ' ' + t.dosisTexto : ''} — {t.pautaVigenteTexto || 'sin pauta'}</option>{/each}
          </select>
        </div>
      {/if}
    </section>

    <section class="tarjeta fuerte" aria-labelledby="t-escaneo">
      <h2 id="t-escaneo">Escanear la caja</h2>
      <div class="escaneo">
        <span class="icono-lector" aria-hidden="true">▥</span>
        <input bind:this={campoEscaneo} bind:value={escaneo} onkeydown={teclaEscaneo} id="escaneo" data-prueba="escaneo"
          placeholder="Pasa el lector por la caja…" autocomplete="off" spellcheck="false" aria-label="Campo de escaneo: pasa el lector o escribe el código nacional" />
        <button class="btn grande" type="button" onclick={() => procesarEscaneo(escaneo)} disabled={!escaneo.trim()}>Leer <span class="atajo">Intro</span></button>
      </div>
      <p class="suave pequeno sin-margen margen-s">Sin lector: escribe el código nacional y pulsa Intro; después el lote y la caducidad.</p>
      {#if errorEscaneo}<Nota gravedad="atencion">{errorEscaneo}</Nota>{/if}
      {#if exito}<Nota gravedad="ok" id="exito">{exito}</Nota>{/if}
    </section>

    {#if ambiguas}
      <section class="tarjeta" aria-labelledby="t-ambiguo">
        <Nota gravedad="atencion"><strong id="t-ambiguo">Confirma el lote mirando la caja.</strong> El lector no ha enviado el separador entre el lote y el número de serie, y el programa no puede saber cuál es cuál. Elige el que coincide con lo impreso en la caja.</Nota>
        <div class="apilado margen-s">
          {#each ambiguas as c, i (i)}
            <button class="btn grande" type="button" onclick={() => confirmarCandidata(c)} data-prueba="candidata-{i}">{rotuloCandidata(c)}</button>
          {/each}
          <button class="btn enlace" type="button" onclick={() => { ambiguas = null; lectura = ''; siguienteCampo(); }}>Ninguno coincide: lo escribo yo</button>
        </div>
      </section>
    {/if}

    <section class="tarjeta" aria-labelledby="t-datos">
      <h2 id="t-datos">Datos de la caja</h2>
      <div class="dos-campos">
        <div class="campo campo-grande"><label for="cn">Código nacional (CN)</label>
          <input id="cn" bind:value={cn} inputmode="numeric" autocomplete="off" class="mono" data-prueba="cn" /></div>
        <div class="campo campo-grande"><label for="unidades">Unidades de la caja</label>
          <input id="unidades" bind:this={campoUnidades} bind:value={unidadesTxt} oninput={() => (unidadesEditadas = true)} onkeydown={enterUnidades} inputmode="numeric" autocomplete="off" class="mono" data-prueba="unidades" />
          {#if medicamento?.unidadesEnvase}<span class="ayuda">Del medicamento: {medicamento.unidadesEnvase}</span>{/if}</div>
        <div class="campo campo-grande"><label for="lote">Lote <span class="suave">(obligatorio)</span></label>
          <input id="lote" bind:this={campoLote} bind:value={lote} onkeydown={pasarA(() => campoCaducidad)} autocomplete="off" spellcheck="false" style="text-transform:uppercase" data-prueba="lote" /></div>
        <div class="campo campo-grande"><label for="caducidad">Caducidad <span class="suave">(obligatoria)</span></label>
          <input id="caducidad" bind:this={campoCaducidad} value={caducidad} oninput={alCaducidad} onkeydown={pasarA(() => campoUnidades)} inputmode="numeric" placeholder="MM/AAAA" autocomplete="off" class="mono" data-prueba="caducidad" />
          <span class="ayuda">Escribe mes y año (12/2028) o la fecha completa (2028-12-31).</span></div>
      </div>
      <details class="margen-s"><summary>Número de serie (sólo si la caja lo trae)</summary>
        <div class="campo margen-s"><input aria-label="Número de serie" bind:value={serie} autocomplete="off" spellcheck="false" data-prueba="serie" /></div>
      </details>

      {#if resultado?.medicamentoNombre || medicamento}
        <div class="resumen-envase margen-s" data-prueba="resumen-envase">
          <span class="nombre">{resultado?.medicamentoNombre ?? medicamento?.nombre}</span>
          {#if resultado?.normalizado}<span>Caduca el <strong>{fecha(resultado.normalizado.caducidad)}</strong> · lote <strong>{resultado.normalizado.lote}</strong>{resultado.normalizado.origenLectura === 'datamatrix' ? ' · leído del código' : ' · tecleado'}</span>{/if}
        </div>
      {/if}
      {#if cn6 && medicamento === null}
        <Nota gravedad="atencion">
          No conozco el código nacional {cn6}. Dalo de alta con su nombre antes de guardar la caja.
          {#snippet accion()}<button class="btn" type="button" onclick={altaMedicamento}>Dar de alta el medicamento</button>{/snippet}
        </Nota>
      {/if}

      <div aria-live="polite" data-prueba="avisos">
        {#each resultado?.bloqueos ?? [] as a (a.codigo + a.texto)}<Nota gravedad="bloqueo">{a.texto}</Nota>{/each}
        {#each resultado?.atencion ?? [] as a (a.codigo + a.texto)}<Nota gravedad="atencion">{a.texto}</Nota>{/each}
        {#each resultado?.info ?? [] as a (a.codigo + a.texto)}<Nota gravedad="info">{a.texto}</Nota>{/each}
        {#if errorComprobar}<Nota gravedad="bloqueo">{errorComprobar}</Nota>{/if}
        {#if errorGuardar}<Nota gravedad="bloqueo">{errorGuardar}</Nota>{/if}
      </div>

      <div class="barra-acciones">
        {#if !paciente}<span class="suave">Elige antes el paciente.</span>
        {:else if cn6 && (!lote.trim() || !caducidad.trim())}<span class="suave">Faltan el lote y la caducidad.</span>
        {:else if hayBloqueos}<span class="suave">Resuelve el aviso en rojo para poder guardar.</span>{/if}
        <span class="espacio"></span>
        <button class="btn principal grande" type="button" bind:this={btnGuardar} onclick={guardar} disabled={!puedeGuardar} data-prueba="guardar">
          {guardando ? 'Guardando…' : 'Guardar la caja'} <span class="atajo">Intro</span></button>
      </div>
    </section>
  </div>

  <aside class="apilado">
    {#if paciente}
      <section class="tarjeta" aria-labelledby="t-cob">
        <h2 id="t-cob">Cobertura de {paciente.nombre}</h2>
        {#if cargandoTrat}<div class="cargando-linea">Cargando…</div>
        {:else if !tratamientos.length}<div class="vacio">Este paciente no tiene tratamientos todavía. Añádelos en su ficha.</div>
        {:else}
          <ul class="lista-plana" data-prueba="cobertura">
            {#each tratamientos as t (t.id)}
              <li>
                <span class="espacio"><span class="negrita">{t.principioActivo}</span><br /><span class="suave pequeno">{t.pautaVigenteTexto || 'sin pauta'}{t.emblistable ? '' : ' · se da aparte'}</span></span>
                <span class="cobertura {claseCobertura(t.coberturaDias)}">{textoCobertura(t.coberturaDias)}</span>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="margen-s"><button class="btn enlace" type="button" onclick={() => ir(rutas.paciente(paciente!.id, 'cajas'))}>Ver todas sus cajas</button></div>
      </section>
    {/if}
    <section class="tarjeta" aria-labelledby="t-hoy">
      <h2 id="t-hoy">Entradas de hoy</h2>
      {#if !hoy.length}<div class="vacio">Todavía no has guardado ninguna caja hoy.</div>
      {:else}
        <ul class="lista-plana" data-prueba="entradas-hoy">
          {#each hoy as e, i (i)}
            <li><span class="suave mono">{e.hora}</span>
              <span class="espacio"><span class="negrita">{e.medicamento}</span><br /><span class="suave pequeno">{e.paciente} · lote {e.lote} · cad. {fecha(e.caducidad)}</span></span>
              <span class="etiqueta">{e.unidades} ud.</span></li>
          {/each}
        </ul>
      {/if}
    </section>
  </aside>
</div>
