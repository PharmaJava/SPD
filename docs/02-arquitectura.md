# 2. Arquitectura (ADR-001)

**Estado:** propuesta · **Fecha:** 28-oct-2026

## Requisitos que deciden

| Requisito | Peso |
|---|---|
| Windows 10/11, instalable por alguien no técnico | Imprescindible |
| Funciona sin internet | Imprescindible |
| Base de datos local **cifrada** | Imprescindible (datos de salud) |
| Impresión precisa en milímetros, a cualquier impresora, sin diálogo | Imprescindible |
| Lector de DataMatrix (teclado HID o puerto serie) | Imprescindible |
| Mantenible por Antonio, que programa en JavaScript | Muy alto |
| Actualizaciones automáticas firmadas | Alto |
| Varios puestos en la misma farmacia | Medio (fase 2) |

## Opciones estudiadas

| Opción | A favor | En contra |
|---|---|---|
| **.NET 8 + WPF/WinUI + SQLite** | Nativo, impresión excelente, instalador pequeño | C#/XAML: otro lenguaje para Antonio; UI más lenta de iterar |
| **Tauri 2 (Rust + WebView2)** | Instalador ~10 MB, seguro | Impresión silenciosa con tamaño de página exacto no está resuelta sin plugin propio; la lógica nativa es Rust |
| **Electron + Node + SQLite** | Todo JavaScript/TypeScript; `webContents.print()` admite impresora concreta, tamaño en micras y modo silencioso; `printToPDF`; puerto serie con `serialport`; actualizador maduro | Instalador ~90-120 MB; consumo de memoria mayor |
| Web + servidor local | Multipuesto natural | Exige instalar y mantener un servidor; impresión desde navegador limitada |

## Decisión

**Electron + TypeScript + SQLite cifrada (SQLCipher)**, con la interfaz en
**Svelte 5** (decidido, ver doc 13).

Motivos, por orden de peso:
1. **Impresión**: es el corazón del producto (etiquetas de tamaños
   arbitrarios) y Electron lo resuelve de serie con CSS en `mm` y
   `print({ deviceName, pageSize: { width, height } en micras, silent, margins })`.
2. **Un solo lenguaje** para Antonio y para el dominio, que se puede probar
   con `node --test` sin abrir la aplicación.
3. El tamaño del instalador no importa en un puesto de farmacia.

## Capas

```
┌──────────────────────── Proceso de interfaz (renderer) ────────────────────────┐
│  Pantallas (Svelte) · sin acceso a Node · sólo habla con la API de preload     │
└────────────────────────────────────┬───────────────────────────────────────────┘
                                     │ IPC tipado (contextBridge, lista blanca)
┌────────────────────────────────────┴───────────────────────────────────────────┐
│  Proceso principal (Node)                                                       │
│   ├─ servicios/   casos de uso: prepararSPD, registrarEnvase, imprimir…         │
│   ├─ dominio/     lógica PURA (pauta, consumo FEFO, caducidades, GS1, etiquetas)│
│   ├─ datos/       repositorios sobre SQLite cifrada + migraciones + auditoría   │
│   ├─ externos/    CIMA (HTTP + caché), lector serie, impresoras                 │
│   └─ sistema/     copias, actualizaciones, registro de errores                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- **`dominio/` no toca disco, red ni interfaz.** Es la misma regla que
  `/calculos/` en conveniodefarmacia.com y por el mismo motivo: se prueba
  solo y no puede tener dos copias.
- **El renderer no tiene Node** (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`). Si una vista se viera
  comprometida no podría leer la base de datos.
- **IPC con lista blanca**: cada canal valida su entrada (esquema) en el
  proceso principal. Nada de «ejecuta este SQL».

## Base de datos

- **SQLite** en un único fichero, cifrado con SQLCipher
  (`better-sqlite3-multiple-ciphers`). Clave de datos aleatoria envuelta
  con la contraseña de la farmacia y exportable como clave de recuperación
  (doc 10), nunca guardada en claro.
- Modo WAL, claves foráneas activas, migraciones numeradas en `db/`.
- Fechas en ISO-8601 (texto), importes en céntimos (entero).
- **Una capa de repositorios** para que, en fase 2, el mismo servicio pueda
  trabajar contra un servidor de la LAN sin reescribir los casos de uso.

## Multipuesto (fase 2, decisión aplazada)

SQLite en una carpeta compartida de red **no es seguro** (bloqueos de SMB).
Cuando haga falta: un puesto actúa como **servidor** (el mismo programa en
modo servidor, HTTP en la LAN con TLS y usuario) y los demás como clientes.
Por eso los servicios no hablan con SQLite directamente, sino con
repositorios.

## Lector de códigos

Dos modos (doc 06):
- **Puerto serie / USB-COM** (recomendado): se lee con `serialport`; llega el
  carácter GS intacto.
- **Teclado (HID)**: un campo con el foco recibe la lectura; hay que
  configurar el lector para que mande el GS como un carácter reconocible.

## Distribución

- Instalador **NSIS** con `electron-builder`, firmado con certificado de
  firma de código (sin firma, Windows SmartScreen asusta al usuario).
- Actualizaciones con `electron-updater` desde las *releases* de GitHub.
  El repositorio puede ser privado; las releases necesitan un token o un
  servidor de descargas propio (doc 12).
- Antes de migrar la base de datos en una actualización se hace copia
  automática.

## Estructura del repositorio (objetivo)

```
SPD/
├── db/                 schema.sql + migraciones/NNN_*.sql
├── docs/
├── plantillas/         consentimientos y etiquetas por defecto
├── src/
│   ├── dominio/        TS puro + pruebas
│   ├── principal/      proceso principal Electron
│   ├── preload/
│   └── interfaz/       renderer
└── tests/
```
