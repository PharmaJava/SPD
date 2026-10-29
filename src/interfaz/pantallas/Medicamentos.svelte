<script lang="ts">
  /**
   * Medicamentos: catálogo local. El aspecto (color, forma, ranura) lo propone el programa o CIMA y
   * SÓLO un farmacéutico o el titular lo confirma; mientras no, la ficha se queda «sin confirmar».
   */
  import { onMount } from 'svelte';
  import { spd, datos } from '../api.ts';
  import type { MedicamentoDto, RespuestaCima, UsuarioPublico } from '../../servicios/api.ts';
  import type { PropuestaDescripcion } from '../../dominio/descripcion-fisica.ts';
  import type { Clasificacion } from '../../dominio/aptitud-spd.ts';
  import { resumenDescripcion } from '../../dominio/descripcion-fisica.ts';
  import { normalizarCN } from '../../dominio/gs1.ts';
  import '../estilos/u2.css';
  import Modal from './preparacion/Modal.svelte';
  import Nota from './preparacion/Nota.svelte';
  import { cargarSesion, mensaje, puedeValidar, tomarPaso } from './preparacion/util.ts';

  let { pacienteId: _p }: { pacienteId?: number } = $props();

  const COLORES = ['blanco', 'amarillo', 'naranja', 'rojo', 'rosa', 'azul', 'verde', 'marrón', 'gris', 'negro', 'violeta', 'morado', 'beige', 'crema', 'lila', 'turquesa', 'celeste', 'salmón', 'marfil', 'ocre', 'transparente', 'incoloro'];
  const CONTORNOS = ['redondo', 'oblongo', 'ovalado', 'elíptico', 'alargado', 'cilíndrico', 'lenticular', 'triangular', 'capsulado', 'cuadrado', 'rectangular', 'romboidal', 'hexagonal', 'octogonal'];
  const PERFILES = ['biconvexo', 'bicóncavo', 'convexo', 'plano'];
  const FORMAS_FARM = ['Comprimido', 'Comprimido recubierto con película', 'Comprimido de liberación prolongada', 'Comprimido bucodispersable', 'Comprimido efervescente', 'Cápsula dura', 'Cápsula blanda', 'Gragea', 'Solución oral', 'Sobres', 'Otra'];
  const APTITUD: Record<string, { t: string; c: string }> = { apto: { t: 'Apto para SPD', c: 'ok' }, precaucion: { t: 'Con precaución', c: 'atencion' }, no_apto: { t: 'No apto para SPD', c: 'bloqueo' } };
  const ESTADO_FICHA: Record<string, { t: string; c: string }> = { sin_datos: { t: 'Sin datos de aspecto', c: '' }, propuesta: { t: 'Propuesta sin confirmar', c: 'atencion' }, confirmada: { t: 'Aspecto confirmado', c: 'ok' } };

  let sesion = $state<UsuarioPublico | null>(null);
  const farmaceutico = $derived(puedeValidar(sesion?.rol));

  let texto = $state(''); let soloIncompletas = $state(false);
  let lista = $state<MedicamentoDto[]>([]); let incompletas = $state<number | null>(null);
  let cargando = $state(true); let error = $state('');
  let sel = $state<MedicamentoDto | null>(null);

  // formulario de aspecto
  let f = $state({ color1: '', color2: '', contorno: '', perfil: '', ranurado: '' as '' | 'si' | 'no', marcas: '', descripcion: '', aptitud: '' as '' | 'apto' | 'precaucion' | 'no_apto', motivo: '' });
  let propuestaAvisos = $state<string[]>([]); let propuestaRanura = $state(false);
  let modificado = $state(false);
  let guardando = $state(false); let errorForm = $state(''); let okForm = $state('');

  // CIMA y ficha técnica
  let consultando = $state(false); let cima = $state<RespuestaCima | null>(null); let errorCima = $state('');
  let textoFicha = $state(''); let analizando = $state(false); let errorFicha = $state('');
  let verFicha = $state(false);

  // alta manual
  let altaAbierta = $state(false); let alta = $state({ cn: '', nombre: '', forma: 'Comprimido', unidades: '' }); let errorAlta = $state(''); let guardandoAlta = $state(false);

  let t: ReturnType<typeof setTimeout> | undefined; let seq = 0;
  async function buscar() {
    const mi = ++seq; cargando = true; error = '';
    try {
      const r = soloIncompletas ? await datos(spd.fichasIncompletas()) : await datos(spd.buscarMedicamentos(texto.trim()));
      if (mi !== seq) return;
      lista = r;
    } catch (e) { if (mi === seq) error = mensaje(e); } finally { if (mi === seq) cargando = false; }
  }
  function alEscribir() { clearTimeout(t); soloIncompletas = false; t = setTimeout(buscar, 220); }
  async function contarIncompletas() { const r = await spd.fichasIncompletas(); if (r.ok) incompletas = r.datos.length; }
  onMount(async () => {
    sesion = await cargarSesion(); await buscar(); void contarIncompletas();
    const cn = tomarPaso('spd.medicamentos.altaCn'); if (cn) abrirAlta(cn);
  });

  function cargarForm(m: MedicamentoDto) {
    const [c1 = '', c2 = ''] = (m.color ?? '').split(',').map(x => x.trim());
    const [ct = '', pf = ''] = (m.forma ?? '').split(',').map(x => x.trim());
    f = { color1: COLORES.includes(c1) ? c1 : '', color2: COLORES.includes(c2) ? c2 : '', contorno: CONTORNOS.includes(ct) ? ct : '', perfil: PERFILES.includes(pf) ? pf : '',
      ranurado: m.ranurado === true ? 'si' : m.ranurado === false ? 'no' : '', marcas: m.marcasGrabado ?? '', descripcion: m.descripcionFisica ?? '', aptitud: m.spdAptitud ?? '', motivo: m.spdMotivo ?? '' };
    modificado = false; propuestaAvisos = []; propuestaRanura = false; errorForm = ''; okForm = ''; cima = null; errorCima = ''; textoFicha = ''; errorFicha = ''; verFicha = false;
  }
  function elegir(m: MedicamentoDto) { sel = m; cargarForm(m); }
  const tocar = () => { modificado = true; okForm = ''; };

  function aplicarPropuesta(d: PropuestaDescripcion | undefined, a: Clasificacion | null | undefined) {
    if (d) {
      const cols = d.colores.filter(c => COLORES.includes(c));
      f.color1 = cols[0] ?? f.color1; f.color2 = cols[1] ?? '';
      const [ct = '', pf = ''] = (d.forma ?? '').split(',').map(x => x.trim());
      if (CONTORNOS.includes(ct)) f.contorno = ct; if (PERFILES.includes(pf)) f.perfil = pf;
      if (d.marcas.length) f.marcas = d.marcas.join(' / ');
      f.descripcion = resumenDescripcion(d) || f.descripcion;
      propuestaAvisos = d.avisos; propuestaRanura = d.ranura !== 'ninguna' && d.ranura !== 'sin_dato';
      // La ranura puede no servir para partir: se deja «sin confirmar» a propósito
    }
    if (a) { f.aptitud = a.estado; f.motivo = a.motivo; }
    tocar();
  }

  function colorTexto() { return [f.color1, f.color2].filter(Boolean).join(', '); }
  async function guardar(confirmar: boolean) {
    if (!sel) return;
    guardando = true; errorForm = ''; okForm = '';
    const cambios: Partial<MedicamentoDto> & { cn: string; nombre: string } = {
      ...sel, color: colorTexto() || null, forma: [f.contorno, f.perfil].filter(Boolean).join(', ') || null,
      ranurado: f.ranurado === 'si' ? true : f.ranurado === 'no' ? false : null, marcasGrabado: f.marcas.trim() || null,
      descripcionFisica: f.descripcion.trim() || null, spdAptitud: f.aptitud || null, spdMotivo: f.motivo.trim() || null,
    };
    const r = await spd.guardarMedicamento(cambios, confirmar);
    guardando = false;
    if (!r.ok) { errorForm = r.error; return; }
    sel = r.datos; cargarForm(r.datos);
    okForm = confirmar ? 'Aspecto confirmado. Ya se usará así en las etiquetas y al validar.' : 'Guardado como propuesta: falta que un farmacéutico lo confirme.';
    lista = lista.map(x => x.cn === r.datos.cn ? r.datos : x); void contarIncompletas();
  }

  async function consultarCima() {
    if (!sel) return;
    consultando = true; errorCima = ''; cima = null;
    const r = await spd.consultarCima(sel.cn);
    consultando = false;
    if (!r.ok) errorCima = r.error; else cima = r.datos;
  }
  async function analizarFicha() {
    if (!sel || !textoFicha.trim()) return;
    analizando = true; errorFicha = '';
    const r = await spd.analizarFichaTecnica(textoFicha, sel.nombre, sel.formaFarmaceutica ?? undefined);
    analizando = false;
    if (!r.ok) { errorFicha = r.error; return; }
    aplicarPropuesta(r.datos.descripcion, r.datos.aptitud);
    okForm = 'Propuesta aplicada al formulario. Revísala y, si es correcta, confírmala.';
  }

  function abrirAlta(cn = '') { alta = { cn, nombre: '', forma: 'Comprimido', unidades: '' }; errorAlta = ''; altaAbierta = true; }
  async function darDeAlta() {
    const cn = normalizarCN(alta.cn);
    if (!cn) { errorAlta = 'El código nacional tiene 6 o 7 cifras.'; return; }
    if (!alta.nombre.trim()) { errorAlta = 'Escribe el nombre del medicamento tal como viene en la caja.'; return; }
    const u = alta.unidades.trim() ? Number(alta.unidades.replace(',', '.')) : null;
    if (u !== null && !(Number.isFinite(u) && u > 0)) { errorAlta = 'Las unidades por envase tienen que ser un número mayor que cero.'; return; }
    guardandoAlta = true;
    const r = await spd.guardarMedicamento({ cn, nombre: alta.nombre.trim(), formaFarmaceutica: alta.forma, unidadesEnvase: u, creadoManual: true });
    guardandoAlta = false;
    if (!r.ok) { errorAlta = r.error; return; }
    altaAbierta = false; texto = r.datos.nombre; soloIncompletas = false; await buscar(); elegir(r.datos); void contarIncompletas();
  }
</script>

<div class="cabecera-pagina">
  <div><h1>Medicamentos</h1><p class="subtitulo">El catálogo de la farmacia: cómo es cada comprimido y si sirve para el SPD.</p></div>
  <span class="espacio"></span>
  <button class="btn principal" type="button" onclick={() => abrirAlta()} data-prueba="nuevo-med">Nuevo medicamento</button>
</div>

<div class="filtros">
  <div class="campo" style="flex:1;min-width:260px"><label for="busca-med">Buscar por nombre o código nacional</label>
    <input id="busca-med" bind:value={texto} oninput={alEscribir} placeholder="Metformina, 650123…" autocomplete="off" data-prueba="busca-med" /></div>
  <button class="btn" class:principal={soloIncompletas} type="button" aria-pressed={soloIncompletas} data-prueba="incompletas"
    onclick={() => { soloIncompletas = !soloIncompletas; void buscar(); }}>Fichas por completar{incompletas !== null ? ` (${incompletas})` : ''}</button>
</div>

<div class="dos-col">
  <section class="tarjeta" aria-label="Lista de medicamentos">
    {#if error}<Nota gravedad="bloqueo">{error}</Nota>{/if}
    {#if cargando}<div class="cargando-linea">Buscando…</div>
    {:else if !lista.length}
      <div class="vacio">{soloIncompletas ? 'No hay fichas pendientes: todos los aspectos están confirmados.' : 'No hay ningún medicamento con ese nombre o código.'}
        {#if !soloIncompletas}<div class="margen-s"><button class="btn" type="button" onclick={() => abrirAlta(normalizarCN(texto) ?? '')}>Darlo de alta</button></div>{/if}</div>
    {:else}
      <div class="scroll-x">
        <table class="tabla" data-prueba="lista-med">
          <thead><tr><th>CN</th><th>Medicamento</th><th>Aspecto</th><th>Ficha</th><th>SPD</th></tr></thead>
          <tbody>
            {#each lista as m (m.cn)}
              <tr class="clicable" tabindex="0" onclick={() => elegir(m)} onkeydown={(e) => { if (e.key === 'Enter') elegir(m); }} aria-selected={sel?.cn === m.cn} style={sel?.cn === m.cn ? 'background:var(--acento-fondo)' : ''}>
                <td class="mono">{m.cn}</td>
                <td><strong>{m.nombre}</strong><div class="suave pequeno">{m.formaFarmaceutica ?? ''}{m.unidadesEnvase ? ` · ${m.unidadesEnvase} ud.` : ''}</div></td>
                <td class="pequeno">{[m.color, m.forma, m.ranurado ? 'ranurado' : ''].filter(Boolean).join(' · ') || '—'}</td>
                <td><span class="etiqueta {ESTADO_FICHA[m.descripcionEstado].c}">{ESTADO_FICHA[m.descripcionEstado].t}</span></td>
                <td>{#if m.spdAptitud}<span class="etiqueta {APTITUD[m.spdAptitud].c}">{APTITUD[m.spdAptitud].t}</span>{:else}<span class="suave pequeno">Sin evaluar</span>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <aside class="apilado">
    {#if !sel}
      <div class="tarjeta vacio">Elige un medicamento de la lista para ver y completar su ficha.</div>
    {:else}
      <section class="tarjeta" aria-labelledby="t-ficha" data-prueba="ficha-med">
        <h2 id="t-ficha">{sel.nombre}</h2>
        <div class="fila"><span class="mono suave">CN {sel.cn}</span><span class="etiqueta {ESTADO_FICHA[sel.descripcionEstado].c}">{ESTADO_FICHA[sel.descripcionEstado].t}</span>
          {#if sel.spdAptitud}<span class="etiqueta {APTITUD[sel.spdAptitud].c}">{APTITUD[sel.spdAptitud].t}</span>{/if}</div>
        <dl class="ficha-detalle">
          <dt>Forma</dt><dd>{sel.formaFarmaceutica ?? '—'}{sel.unidadesEnvase ? ` · ${sel.unidadesEnvase} unidades por envase` : ''}</dd>
          {#if sel.principiosActivos}<dt>Principio activo</dt><dd>{sel.principiosActivos}</dd>{/if}
          {#if sel.laboratorio}<dt>Laboratorio</dt><dd>{sel.laboratorio}</dd>{/if}
        </dl>
        <div class="fila margen-s">
          <button class="btn" type="button" onclick={consultarCima} disabled={consultando} data-prueba="cima">{consultando ? 'Consultando…' : 'Consultar en CIMA'}</button>
          <button class="btn" type="button" onclick={() => (verFicha = !verFicha)} aria-expanded={verFicha}>Pegar la ficha técnica</button>
        </div>
        <p class="suave pequeno sin-margen margen-s">A CIMA sólo viaja el código nacional.</p>

        {#if errorCima}<Nota gravedad="atencion">{errorCima}</Nota>{/if}
        {#if cima && !cima.disponible}
          <Nota gravedad="info" id="cima-no">No he podido consultar CIMA ahora{cima.aviso ? ` (${cima.aviso})` : ''}. No pasa nada: puedes rellenar la ficha a mano, o pegar abajo el texto de la ficha técnica.</Nota>
        {:else if cima}
          <Nota gravedad="info" id="cima-si">
            <strong>CIMA propone:</strong> {cima.medicamento?.nombre ?? sel.nombre}{cima.descripcion ? ` — ${resumenDescripcion(cima.descripcion) || 'sin descripción del aspecto'}` : ''}.
            {#if cima.aptitud}<br />Aptitud SPD sugerida: <strong>{APTITUD[cima.aptitud.estado]?.t}</strong> — {cima.aptitud.motivo}{/if}
            {#if cima.aviso}<br />{cima.aviso}{/if}
            {#snippet accion()}<button class="btn" type="button" onclick={() => aplicarPropuesta(cima?.descripcion, cima?.aptitud)}>Usar la propuesta</button>{/snippet}
          </Nota>
        {/if}

        {#if verFicha}
          <div class="campo margen-s"><label for="texto-ficha">Texto de la sección 3 («Forma farmacéutica») de la ficha técnica</label>
            <textarea id="texto-ficha" bind:value={textoFicha} placeholder="Comprimido blanco, redondo, biconvexo, ranurado…" data-prueba="texto-ficha"></textarea></div>
          {#if errorFicha}<Nota gravedad="bloqueo">{errorFicha}</Nota>{/if}
          <button class="btn" type="button" onclick={analizarFicha} disabled={analizando || !textoFicha.trim()} data-prueba="analizar">{analizando ? 'Analizando…' : 'Proponer el aspecto'}</button>
        {/if}
      </section>

      <section class="tarjeta" aria-labelledby="t-aspecto">
        <h2 id="t-aspecto">Aspecto y aptitud</h2>
        {#each propuestaAvisos as a (a)}<Nota gravedad="atencion">{a}</Nota>{/each}
        {#if propuestaRanura}<Nota gravedad="atencion">Tiene ranura, pero puede ser sólo para tragarlo mejor. Comprueba en la ficha técnica si se puede partir antes de contestar «sí».</Nota>{/if}
        <div class="dos-campos">
          <div class="campo"><label for="c1">Color</label><select id="c1" bind:value={f.color1} onchange={tocar} data-prueba="color"><option value="">Sin indicar</option>{#each COLORES as c (c)}<option>{c}</option>{/each}</select></div>
          <div class="campo"><label for="c2">Segundo color (cápsulas bicolor)</label><select id="c2" bind:value={f.color2} onchange={tocar}><option value="">—</option>{#each COLORES as c (c)}<option>{c}</option>{/each}</select></div>
          <div class="campo"><label for="ct">Forma</label><select id="ct" bind:value={f.contorno} onchange={tocar} data-prueba="forma"><option value="">Sin indicar</option>{#each CONTORNOS as c (c)}<option>{c}</option>{/each}</select></div>
          <div class="campo"><label for="pf">Perfil</label><select id="pf" bind:value={f.perfil} onchange={tocar}><option value="">—</option>{#each PERFILES as c (c)}<option>{c}</option>{/each}</select></div>
          <div class="campo"><label for="rn">¿Se puede partir?</label><select id="rn" bind:value={f.ranurado} onchange={tocar}><option value="">No consta</option><option value="si">Sí, está indicado en la ficha</option><option value="no">No</option></select></div>
          <div class="campo"><label for="mg">Marcas grabadas</label><input id="mg" bind:value={f.marcas} oninput={tocar} placeholder="«M 500»" /></div>
        </div>
        <div class="campo"><label for="df">Descripción para la etiqueta</label><textarea id="df" bind:value={f.descripcion} oninput={tocar} placeholder="Comprimido blanco, redondo, ranurado" data-prueba="descripcion"></textarea></div>
        <div class="dos-campos">
          <div class="campo"><label for="ap">¿Sirve para el SPD?</label><select id="ap" bind:value={f.aptitud} onchange={tocar} data-prueba="aptitud"><option value="">Sin evaluar</option><option value="apto">Apto</option><option value="precaucion">Con precaución</option><option value="no_apto">No apto</option></select></div>
          <div class="campo"><label for="am">Motivo</label><input id="am" bind:value={f.motivo} oninput={tocar} /></div>
        </div>
        {#if errorForm}<Nota gravedad="bloqueo">{errorForm}</Nota>{/if}
        {#if okForm}<Nota gravedad="ok" id="ok-form">{okForm}</Nota>{/if}
        <div class="barra-acciones">
          <button class="btn" type="button" onclick={() => guardar(false)} disabled={guardando || !modificado} data-prueba="guardar-propuesta">Guardar sin confirmar</button>
          {#if farmaceutico}
            <button class="btn principal" type="button" onclick={() => guardar(true)} disabled={guardando || (sel.descripcionEstado === 'confirmada' && !modificado)} data-prueba="confirmar-aspecto">Confirmar aspecto</button>
          {:else}
            <span class="suave pequeno">Confirmar el aspecto lo hace un farmacéutico o el titular.</span>
          {/if}
        </div>
      </section>
    {/if}
  </aside>
</div>

<Modal titulo="Nuevo medicamento" bind:abierto={altaAbierta}>
  <div class="dos-campos">
    <div class="campo"><label for="a-cn">Código nacional (CN)</label><input id="a-cn" bind:value={alta.cn} inputmode="numeric" class="mono" data-prueba="alta-cn" /></div>
    <div class="campo"><label for="a-u">Unidades por envase</label><input id="a-u" bind:value={alta.unidades} inputmode="numeric" data-prueba="alta-unidades" /></div>
  </div>
  <div class="campo"><label for="a-n">Nombre (como viene en la caja)</label><input id="a-n" bind:value={alta.nombre} data-prueba="alta-nombre" /></div>
  <div class="campo"><label for="a-f">Forma</label><select id="a-f" bind:value={alta.forma}>{#each FORMAS_FARM as c (c)}<option>{c}</option>{/each}</select></div>
  <p class="suave pequeno">Después podrás consultar CIMA o escribir cómo es el comprimido; hasta que un farmacéutico confirme el aspecto, la ficha figura «por completar».</p>
  {#if errorAlta}<Nota gravedad="bloqueo">{errorAlta}</Nota>{/if}
  {#snippet pie()}
    <button class="btn" type="button" onclick={() => (altaAbierta = false)}>Cancelar</button>
    <button class="btn principal" type="button" onclick={darDeAlta} disabled={guardandoAlta} data-prueba="alta-guardar">Dar de alta</button>
  {/snippet}
</Modal>
