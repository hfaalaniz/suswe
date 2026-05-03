# 🔌 SUSWE SU800/SU900 — Configurador WiFi con ESP32

<div align="center">

![Badge Arduino](https://img.shields.io/badge/Arduino-ESP32-blue?logo=arduino)
![Badge Modbus](https://img.shields.io/badge/Protocolo-Modbus%20RTU-orange)
![Badge WiFi](https://img.shields.io/badge/Conectividad-WiFi%202.4GHz-brightgreen)
![Badge Licencia](https://img.shields.io/badge/Licencia-MIT-lightgrey)

**Pasarela WiFi ↔ Modbus RTU para variadores de frecuencia SUSWE SU800/SU900.**  
Configurá, monitoreá y controlá tu variador desde cualquier navegador, sin cables ni software especial.

[Ver Demo](#demo) · [Instalación rápida](#instalación-rápida) · [Documentación](#documentación) · [Contribuir](#contribuir)

</div>

---

## 📋 Tabla de contenidos

- [¿Qué es esto?](#qué-es-esto)
- [Arquitectura](#arquitectura)
- [Requisitos](#requisitos)
- [Instalación rápida](#instalación-rápida)
  - [1. Cableado](#1-cableado)
  - [2. Configurar el variador](#2-configurar-el-variador)
  - [3. Preparar Arduino IDE](#3-preparar-arduino-ide)
  - [4. Cargar el firmware](#4-cargar-el-firmware)
  - [5. Usar el configurador HTML](#5-usar-el-configurador-html)
- [Documentación de la API REST](#documentación-de-la-api-rest)
- [Mapa de registros Modbus](#mapa-de-registros-modbus)
- [Solución de problemas](#solución-de-problemas)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

---

## ¿Qué es esto?

Este proyecto convierte un **ESP32** en una pasarela WiFi para variadores de frecuencia SUSWE SU800/SU900. Permite:

- **Configurar** todos los grupos de parámetros (P0 ~ P6 + PD) desde el browser
- **Controlar** el variador: marcha FWD/REV, paro, jog, reset de falla
- **Monitorear** en tiempo real: frecuencia, corriente, tensión, temperatura, par
- **Gestionar perfiles** de configuración (guardar/restaurar como JSON)
- **Diagnosticar** fallas activas e historial de errores

Todo desde un **archivo HTML** que se abre directamente en el navegador — sin instalar Node.js, sin servidor, sin nada extra.

---

## Arquitectura

```
┌──────────────────┐     RS-485 (Modbus RTU)     ┌──────────────────┐
│  VARIADOR SU900  │ ◄──────────────────────────► │     MAX485       │
│                  │      A+ / B−                 │  (transceptor)   │
│  Todos los       │                              └────────┬─────────┘
│  parámetros P0~  │                                   TTL │ 3.3V
│  PD via Modbus   │                              ┌────────▼─────────┐
└──────────────────┘                              │      ESP32       │
                                                  │                  │
                                                  │  Servidor HTTP   │
                                                  │  API REST /api/  │
                                                  └────────┬─────────┘
                                                      WiFi │ 2.4 GHz
                                                  ┌────────▼─────────┐
                                                  │    Navegador     │
                                                  │  Chrome/Firefox  │
                                                  │                  │
                                                  │  configurador    │
                                                  │  .html (local)   │
                                                  └──────────────────┘
```

El ESP32 expone una **API REST HTTP** en el puerto 80. El archivo HTML se comunica con esa API directamente desde el navegador, sin ningún intermediario.

---

## Requisitos

### Hardware

| Componente | Especificación | Costo aprox. |
|---|---|---|
| ESP32 | Cualquier variante (WROOM-32, DevKit, etc.) | ~$5 USD |
| Módulo RS-485 | MAX485, SP3485 o SN65HVD72 | ~$1 USD |
| Cable par trenzado | UTP Cat5 sirve para distancias cortas | — |
| Variador | SUSWE SU800 o SU900 (cualquier potencia) | — |

> **Nota:** Se recomienda usar un módulo MAX485 con **aislamiento óptico** en entornos industriales con ruido eléctrico elevado. El variador genera switching a alta frecuencia que puede dañar el ESP32 sin aislamiento.

### Software

- [Arduino IDE](https://www.arduino.cc/en/software) 2.x o superior
- Soporte ESP32 para Arduino (ver instalación abajo)
- Librerías:
  - [ModbusMaster](https://github.com/4-20ma/ModbusMaster) v2.x
  - [ArduinoJson](https://arduinojson.org/) v7.x

---

## Instalación rápida

### 1. Cableado

```
VARIADOR SU900          MAX485              ESP32
  Terminal A+  ──────►  A  
  Terminal B−  ──────►  B  
                         VCC  ──────────►  3.3V
                         GND  ──────────►  GND
                         RO   ──────────►  GPIO 16 (RX2)
                         DI   ──────────►  GPIO 17 (TX2)
                         DE ─┐
                         RE ─┴──────────►  GPIO 4  (DIR)
```

Los terminales RS-485 del variador se encuentran en la bornera de comunicaciones, generalmente marcados como **485+** / **485−** o **A** / **B**.

> ⚠️ Para cables largos (> 5 m) agregar una **resistencia de terminación de 120 Ω** entre A y B en cada extremo del bus.

---

### 2. Configurar el variador

Antes de conectar, acceder al panel del SU900 y configurar:

| Parámetro | Valor | Descripción |
|---|---|---|
| **Pd-00** | `5` | Baudrate = 9600 bps |
| **Pd-01** | `0` | Formato 8-N-2 (sin paridad, 2 stop bits) |
| **Pd-02** | `1` | Dirección esclavo Modbus = 1 |
| **Pd-05** | `0` | Protocolo Modbus RTU |

Para que el control por comunicación funcione también configurar:

| Parámetro | Valor | Descripción |
|---|---|---|
| **P0-02** | `2` | Fuente de comando = Comunicación |
| **P0-03** | `9` | Fuente de frecuencia = Comunicación |

---

### 3. Preparar Arduino IDE

**a) Agregar soporte ESP32:**

En Archivo → Preferencias → *URL adicionales para el gestor de placas*, agregar:
```
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```
Luego en Herramientas → Gestor de placas, buscar **"esp32"** e instalar.

**b) Instalar librerías** (Herramientas → Gestionar librerías):
- Buscar `ModbusMaster` (autor: 4-20ma) → Instalar
- Buscar `ArduinoJson` (autor: Benoit Blanchon) → Instalar v7.x

---

### 4. Cargar el firmware

1. Clonar este repositorio:
   ```bash
   git clone https://github.com/tu-usuario/su900-esp32-wifi.git
   ```

2. Abrir `SU900_ESP32_Gateway/SU900_ESP32_Gateway.ino` en Arduino IDE

3. Editar las dos líneas de configuración WiFi:
   ```cpp
   const char* WIFI_SSID     = "TU_RED_WIFI";    // ← Nombre de tu red
   const char* WIFI_PASSWORD = "TU_CLAVE_WIFI";  // ← Contraseña
   ```

4. Seleccionar la placa: **Herramientas → Placa → ESP32 Dev Module**

5. Subir el sketch (botón → o Ctrl+U)

6. Abrir el Monitor Serial a **115200 bps**. Deberías ver:
   ```
   === SUSWE SU900 ESP32 Gateway ===
   Modbus RTU inicializado (9600 bps, 8-N-2, esclavo ID=1)
   Conectando a WiFi 'MiRed'....
   WiFi conectado!
   ===========================================
     IP del ESP32: 192.168.1.105
     En el configurador HTML:
     Conexión → Modbus TCP/IP
     IP: 192.168.1.105  Puerto: 80
   ===========================================
   Servidor HTTP iniciado en puerto 80
   ```
   > **Anotar la IP** que aparece — la vas a usar en el siguiente paso.

---

### 5. Usar el configurador HTML

1. Abrir el archivo `suswe_su900_modbus_configurator_ESP32.html` con Chrome o Firefox (doble clic)

2. Ir a **"Configurar conexión"** en el menú lateral

3. Ingresar la IP del ESP32 y hacer clic en **Guardar IP**:

   ```
   IP del ESP32: [ 192.168.1.105 ] :80   [Guardar IP]
   ```

4. Hacer clic en **Conectar**

5. El indicador en la barra inferior izquierda pasará a verde: **Conectado ●**

A partir de ahí podés:
- **Dashboard** → marcha, paro, slider de frecuencia, monitor en vivo
- **P0 ~ PD** → leer y escribir parámetros individuales o grupos completos
- **Monitor** → gráfica en tiempo real de variables U0
- **Diagnóstico** → leer código de falla activo e historial
- **Perfiles** → guardar y restaurar configuraciones completas como JSON

---

## Documentación de la API REST

El ESP32 expone los siguientes endpoints en `http://<IP_ESP32>/api/`:

### Conexión

| Método | Endpoint | Descripción |
|---|---|---|
| `POST` | `/api/connect` | Inicializa la sesión (respuesta inmediata OK) |
| `POST` | `/api/disconnect` | Cierra la sesión |

### Estado y monitoreo

| Método | Endpoint | Respuesta |
|---|---|---|
| `GET` | `/api/status` | `{running, reverse, fault, freqOut, current, voltage, statusWord}` |
| `GET` | `/api/monitor` | Bloque de 16 registros U0 con valores en tiempo real |

**Ejemplo `/api/status`:**
```json
{
  "running": true,
  "reverse": false,
  "fault": false,
  "freqOut": 48.50,
  "current": 12.30,
  "voltage": 380,
  "statusWord": 1
}
```

### Parámetros

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/api/param/:code` | Lee un parámetro (ej: `/api/param/P0-03`) |
| `PUT` | `/api/param/:code` | Escribe un parámetro — body: `{"value": N}` |
| `GET` | `/api/group/:key` | Lee todos los parámetros de un grupo (p0, p1, p2, p3, p4, p5, p6, pd) |

**Ejemplo GET `/api/param/P0-03`:**
```json
{
  "code": "P0-03",
  "raw": 9,
  "realValue": 9
}
```

### Control

| Método | Endpoint | Body | Descripción |
|---|---|---|---|
| `POST` | `/api/command` | `{"command": "RUN_FORWARD"}` | Envía un comando de marcha/paro |
| `POST` | `/api/frequency` | `{"freqHz": 30.0}` | Escribe la consigna de frecuencia |
| `POST` | `/api/digital-outputs` | `{"bits": 3}` | Controla salidas digitales DO |

**Comandos disponibles:**

| Comando | Descripción | Registro (0x2000) |
|---|---|---|
| `RUN_FORWARD` | Marcha adelante | `0x0001` |
| `RUN_REVERSE` | Marcha inversa | `0x0002` |
| `RAMP_STOP` | Paro con rampa | `0x0005` |
| `FREE_STOP` | Paro libre (inercia) | `0x0006` |
| `JOG_FORWARD` | Jog adelante | `0x0007` |
| `JOG_REVERSE` | Jog inverso | `0x0008` |
| `FAULT_RESET` | Reset de falla activa | `0x0409` |

### Fallas

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/api/fault` | Lee el código de falla activa |
| `POST` | `/api/fault` | Resetea la falla |
| `GET` | `/api/fault-history` | Historial de las últimas 3 fallas |

### Perfiles

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/api/profile/read` | Lee todos los parámetros conocidos del variador |
| `POST` | `/api/profile/write` | Escribe un bloque de parámetros — body: `{"params": {"P0-03": 9, ...}}` |

---

## Mapa de registros Modbus

### Registros de control (escritura)

| Registro | Hex | Descripción |
|---|---|---|
| Comando control | `0x2000` | Marcha, paro, jog, reset |
| Consigna frecuencia | `0x1000` | Valor × 100 (50 Hz = 5000) |
| Salidas digitales | `0x2001` | Bitmask de salidas DO |

### Registros de monitoreo U0 (lectura desde `0x3000`)

| Offset | Descripción | Escala |
|---|---|---|
| +0 | Estado del variador (bitmask) | — |
| +1 | Frecuencia de salida | ÷ 100 → Hz |
| +2 | Corriente de salida | ÷ 10 → A |
| +3 | Tensión de salida | V |
| +4 | Tensión bus DC | V |
| +5 | Par de salida | % |
| +6 | Potencia de salida | ÷ 10 → kW |
| +7 | Velocidad | rpm |
| +8 | Temperatura módulo | °C |

### Parámetros PD — Comunicación

| Parámetro | Dirección | Descripción |
|---|---|---|
| Pd-00 | `0xD000` | Baudrate |
| Pd-01 | `0xD001` | Formato de datos |
| Pd-02 | `0xD002` | Dirección esclavo |
| Pd-05 | `0xD005` | Protocolo (0 = Modbus RTU) |

---

## Solución de problemas

### ❌ "No se pudo contactar el servidor"

- Verificar que el ESP32 y la PC estén en la **misma red WiFi**
- Verificar la IP desde la terminal: `ping 192.168.1.XXX`
- Si el ping no responde: reiniciar el ESP32 y revisar el monitor serial

### ❌ "modbus_fail" en el log del configurador

Verificar en orden:
1. **Cableado:** A+ y B− no invertidos, sin empalmes sueltos
2. **Baudrate:** Pd-00 debe ser `5` (9600 bps), igual a `MODBUS_BAUD` en el firmware
3. **Formato:** Pd-01 debe ser `0` (8-N-2), igual a `SERIAL_8N2` en el firmware
4. **Dirección:** Pd-02 debe coincidir con `MODBUS_SLAVE_ID` (por defecto: 1)
5. **Terminación:** Para cables > 5 m, agregar 120 Ω entre A y B

### ❌ El variador no arranca por comunicación

- Verificar **P0-02 = 2** (fuente de comando = comunicación)
- Para control de frecuencia por comunicación: **P0-03 = 9**

### ❌ Error CORS en el navegador

- Usar **Chrome o Firefox** (no Internet Explorer ni Edge en modo compatibilidad)
- Abrir el HTML como **archivo local** (`file://`) y no desde un servidor HTTP propio
- Verificar que el ESP32 esté respondiendo los headers `Access-Control-Allow-Origin: *`

---

## Personalización del firmware

Las constantes al inicio del `.ino` permiten adaptar el firmware sin tocar el resto del código:

```cpp
// ─── WiFi ──────────────────────────────────────────────
const char* WIFI_SSID     = "TU_RED_WIFI";
const char* WIFI_PASSWORD = "TU_CLAVE_WIFI";

// ─── Pines RS-485 ──────────────────────────────────────
#define RS485_RX_PIN   16   // Cambiar si usás otros GPIO
#define RS485_TX_PIN   17
#define RS485_DIR_PIN   4

// ─── Modbus ────────────────────────────────────────────
#define MODBUS_BAUD      9600   // Debe coincidir con Pd-00 del variador
#define MODBUS_SLAVE_ID     1   // Debe coincidir con Pd-02 del variador
```

---

## Estructura del repositorio

```
su900-esp32-wifi/
├── SU900_ESP32_Gateway/
│   └── SU900_ESP32_Gateway.ino       # Firmware ESP32 (Arduino)
├── suswe_su900_modbus_configurator_ESP32.html  # Interfaz web (abrir en browser)
├── README_INSTALACION.md             # Guía detallada paso a paso
└── README.md                         # Este archivo
```

---

## Contribuir

¡Las contribuciones son bienvenidas! Para contribuir:

1. Fork del repositorio
2. Crear una rama: `git checkout -b feature/mi-mejora`
3. Hacer los cambios y commitear: `git commit -m 'Agrega soporte para X'`
4. Push a la rama: `git push origin feature/mi-mejora`
5. Abrir un Pull Request

### Ideas para contribuir

- [ ] Soporte OTA (actualización de firmware por WiFi)
- [ ] Historial de datos con gráfica de tendencia
- [ ] Soporte para múltiples variadores en el mismo bus RS-485
- [ ] Autenticación básica para el servidor HTTP
- [ ] Modo punto de acceso (AP) para configuración inicial sin red existente
- [ ] Compatibilidad con otros variadores Modbus RTU

---

## Licencia

MIT License — libre para uso personal y comercial.  
Ver archivo [LICENSE](LICENSE) para más detalles.

---

<div align="center">
Desarrollado para facilitar la puesta en marcha y mantenimiento<br>
de variadores SUSWE SU800/SU900 en entornos industriales.
</div>