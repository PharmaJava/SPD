<script lang="ts">
  // Iconos lineales propios (trazo 1.8, sin librerías).
  let { n, tam = 20 }: { n: string; tam?: number } = $props();
  const D: Record<string, string> = {
    hoy: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
    pacientes: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.2a3.5 3.5 0 0 1 0 6.6',
    cajas: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3.3 7.7L12 12.5l8.7-4.8M12 12.5V21',
    preparar: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    medicamentos: 'M10.5 20.5a4.95 4.95 0 0 1-7-7l9-9a4.95 4.95 0 0 1 7 7l-9 9zM8.5 8.5l7 7',
    auditoria: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3zM8.5 12l2.5 2.5L16 9.5',
    ajustes: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    buscar: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
    bloquear: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2',
    imprimir: 'M7 9V3h10v6M7 17H4v-6h16v6h-3M7 14h10v7H7z',
    copiar: 'M9 9h11v11H9zM5 15H4V4h11v1',
    alerta: 'M12 3l10 18H2L12 3zM12 10v5M12 18v.01',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7.5v.01',
    ok: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 12.5l2.7 2.7L16 9.5',
    bloqueo: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9 9l6 6M15 9l-6 6',
    x: 'M6 6l12 12M18 6L6 18',
    mas: 'M12 5v14M5 12h14',
    flecha: 'M5 12h14M13 6l6 6-6 6',
    atras: 'M19 12H5M11 6l-6 6 6 6',
    arriba: 'M12 19V5M6 11l6-6 6 6',
    abajo: 'M12 5v14M6 13l6 6 6-6',
    papelera: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    lapiz: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
    sol: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    luna: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    usuario: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    caja: 'M3 7l9-4 9 4v10l-9 4-9-4V7z',
    calendario: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    reloj: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    check: 'M5 12.5l4.5 4.5L19 7.5',
  };
</script>
<svg class="icono-svg" width={tam} height={tam} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={D[n] ?? ''} /></svg>
