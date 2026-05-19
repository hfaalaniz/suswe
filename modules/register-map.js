/**
 * modules/register-map.js
 * Mapa completo de registros Modbus del SUSWE SU900-30R0G3
 *
 * Reglas de direccionamiento (según manual Cap.5):
 *  - Grupos P0~PF → dirección = 0xNNmm donde NN=grupo hex, mm=índice hex
 *    Ej: P0-16 → 0x0010, P3-12 → 0x030C
 *  - Grupos A0~AF → dirección = 0xANmm (lectura RAM: 0x4Nmm)
 *  - Grupo U0     → dirección = 0x70mm (solo lectura)
 *  - Registros especiales fijos:
 *      0x1000         Consigna de frecuencia por comunicación (W) — mismo espacio que P1
 *      0x1001~0x101F  Monitor en tiempo real U0 — mismo espacio que P1
 *      0x2000         Comando de control (W)    — mismo espacio que P2
 *      0x2001         Control salidas DO (W)    — mismo espacio que P2
 *      0x2002~0x2004  Control AO1, AO2, FMP (W)— mismo espacio que P2
 *      0x3000         Estado de funcionamiento (R) — mismo espacio que P3
 *      0x8000         Código de falla activa (R)
 *      0x1F00         Contraseña usuario (W)
 *      0x1F01         Inicialización parámetros (W)
 *
 * ⚠ ADVERTENCIA DE COLISIÓN DE DIRECCIONES (confirmado por manual Cap.5):
 *  Los grupos P1 (0x10xx), P2 (0x20xx) y P3 (0x30xx) comparten el espacio de
 *  direcciones con registros de control/monitoreo de uso frecuente:
 *    - P1-00 (0x1000) = misma dirección que FREQ_SETPOINT (consigna de frecuencia)
 *    - P1-01..P1-37 (0x1001..0x1025) = mismas direcciones que U0 monitor en tiempo real
 *    - P2-00 (0x2000) = misma dirección que COMMAND (comando de control)
 *    - P2-01 (0x2001) = misma dirección que DO_CONTROL (salidas digitales)
 *    - P3-00 (0x3000) = misma dirección que RUN_STATUS (estado de funcionamiento)
 *  El manual distingue el contexto por el tipo de operación (FC03 lectura de parámetros
 *  vs registros de estado/control), pero el hardware interpreta las lecturas/escrituras
 *  según el contexto del frame Modbus. Por esto, los grupos P1, P2 y P3 SOLO deben
 *  leerse/escribirse individualmente (parámetro por parámetro), NUNCA en lectura de
 *  bloque contigua que atraviese los límites de esos grupos.
 *
 * Escalas: el valor crudo se multiplica por `scale` para obtener la magnitud real.
 * rw: true = lectura/escritura,  false = solo lectura
 */

'use strict';

// ─── Grupo P0: Parámetros operativos básicos ─────────────────────────────────
const GROUP_P0 = [
  { code: 'P0-00', addr: 0x0000, name: 'Tipo G/P',                     scale: 1,    unit: '',    min: 1,    max: 2,     def: 1,    rw: true  },
  { code: 'P0-01', addr: 0x0001, name: 'Modo de control',              scale: 1,    unit: '',    min: 0,    max: 2,     def: 2,    rw: true  },
  { code: 'P0-02', addr: 0x0002, name: 'Fuente de comando',            scale: 1,    unit: '',    min: 0,    max: 2,     def: 0,    rw: true  },
  { code: 'P0-03', addr: 0x0003, name: 'Fuente frecuencia principal X', scale: 1,   unit: '',    min: 0,    max: 9,     def: 0,    rw: true  },
  { code: 'P0-04', addr: 0x0004, name: 'Fuente frecuencia auxiliar Y', scale: 1,    unit: '',    min: 0,    max: 9,     def: 0,    rw: true  },
  { code: 'P0-06', addr: 0x0006, name: 'Rango cobertura frec. Y',      scale: 0.1,  unit: '%',   min: 0,    max: 150,   def: 100,  rw: true  },
  { code: 'P0-07', addr: 0x0007, name: 'Dirección de giro',            scale: 1,    unit: '',    min: 0,    max: 1,     def: 0,    rw: true  },
  { code: 'P0-08', addr: 0x0008, name: 'Frecuencia predeterminada',    scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 5000, rw: true  },
  { code: 'P0-10', addr: 0x000A, name: 'Frecuencia máxima',            scale: 0.01, unit: 'Hz',  min: 5000, max: 32000, def: 5000, rw: true  },
  { code: 'P0-11', addr: 0x000B, name: 'Fuente frec. límite superior', scale: 1,    unit: '',    min: 0,    max: 5,     def: 0,    rw: true  },
  { code: 'P0-12', addr: 0x000C, name: 'Frecuencia límite superior',   scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 5000, rw: true  },
  { code: 'P0-14', addr: 0x000E, name: 'Frecuencia límite inferior',   scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 0,    rw: true  },
  { code: 'P0-15', addr: 0x000F, name: 'Frecuencia portadora',         scale: 0.1,  unit: 'kHz', min: 5,    max: 160,   def: 60,   rw: true  },
  { code: 'P0-17', addr: 0x0011, name: 'Tiempo de aceleración 1',      scale: 0.1,  unit: 's',   min: 0,    max: 65000, def: 100,  rw: true  },
  { code: 'P0-18', addr: 0x0012, name: 'Tiempo de desaceleración 1',   scale: 0.1,  unit: 's',   min: 0,    max: 65000, def: 100,  rw: true  },
  { code: 'P0-19', addr: 0x0013, name: 'Unidad de tiempo Acl/Dcl',     scale: 1,    unit: '',    min: 0,    max: 2,     def: 1,    rw: true  },
  { code: 'P0-22', addr: 0x0016, name: 'Resolución de frecuencia',     scale: 1,    unit: '',    min: 0,    max: 2,     def: 1,    rw: true  },
  { code: 'P0-25', addr: 0x0019, name: 'Frec. referencia Acl/Dcl',     scale: 1,    unit: '',    min: 0,    max: 1,     def: 0,    rw: true  },
  { code: 'P0-29', addr: 0x001D, name: 'Macro de aplicación',          scale: 1,    unit: '',    min: 0,    max: 65535, def: 0,    rw: true  },
];

// ─── Grupo P1: Parámetros del motor ──────────────────────────────────────────
const GROUP_P1 = [
  { code: 'P1-00', addr: 0x1000, name: 'Tipo de motor',                scale: 1,    unit: '',    min: 0,    max: 2,     def: 0,    rw: false },
  { code: 'P1-01', addr: 0x1001, name: 'Potencia nominal',             scale: 0.1,  unit: 'kW',  min: 1,    max: 10000, def: 300,  rw: true  },
  { code: 'P1-02', addr: 0x1002, name: 'Tensión nominal',              scale: 1,    unit: 'V',   min: 1,    max: 380,   def: 380,  rw: true  },
  { code: 'P1-03', addr: 0x1003, name: 'Corriente nominal',            scale: 0.01, unit: 'A',   min: 1,    max: 10000, def: 5800, rw: true  },
  { code: 'P1-04', addr: 0x1004, name: 'Frecuencia nominal',           scale: 0.01, unit: 'Hz',  min: 1,    max: 32000, def: 5000, rw: true  },
  { code: 'P1-05', addr: 0x1005, name: 'Velocidad nominal',            scale: 1,    unit: 'rpm', min: 1,    max: 65535, def: 1470, rw: true  },
  { code: 'P1-06', addr: 0x1006, name: 'Factor de potencia nominal',   scale: 0.001,unit: '',    min: 500,  max: 1000,  def: 850,  rw: true  },
  { code: 'P1-07', addr: 0x1007, name: 'Corriente de descarga motor',  scale: 0.01, unit: 'A',   min: 1,    max: 10000, def: 4000, rw: true  },
  { code: 'P1-37', addr: 0x1025, name: 'Selección de ajuste motor',    scale: 1,    unit: '',    min: 0,    max: 3,     def: 0,    rw: true  },
];

// ─── Grupo P2: Control vectorial ─────────────────────────────────────────────
const GROUP_P2 = [
  { code: 'P2-00', addr: 0x2000, name: 'Ganancia KP1 anillo velocidad', scale: 1,   unit: '',    min: 1,    max: 100,   def: 30,   rw: true  },
  { code: 'P2-01', addr: 0x2001, name: 'Tiempo integral KI1',           scale: 0.001,unit: 's',  min: 10,   max: 10000, def: 500,  rw: true  },
  { code: 'P2-02', addr: 0x2002, name: 'Frecuencia cambio ganancia 1',  scale: 0.01, unit: 'Hz', min: 0,    max: 32000, def: 500,  rw: true  },
  { code: 'P2-03', addr: 0x2003, name: 'Ganancia KP2 anillo velocidad', scale: 1,   unit: '',    min: 1,    max: 100,   def: 20,   rw: true  },
  { code: 'P2-04', addr: 0x2004, name: 'Tiempo integral KI2',           scale: 0.001,unit: 's',  min: 10,   max: 10000, def: 1000, rw: true  },
  { code: 'P2-05', addr: 0x2005, name: 'Frecuencia cambio ganancia 2',  scale: 0.01, unit: 'Hz', min: 0,    max: 32000, def: 1000, rw: true  },
  { code: 'P2-06', addr: 0x2006, name: 'Ganancia diferencial velocidad',scale: 1,   unit: '%',   min: 50,   max: 200,   def: 100,  rw: true  },
  { code: 'P2-07', addr: 0x2007, name: 'Constante filtro bucle veloc.', scale: 0.001,unit: 's',  min: 0,    max: 100,   def: 0,    rw: true  },
  { code: 'P2-09', addr: 0x2009, name: 'Fuente límite superior de par', scale: 1,   unit: '',    min: 0,    max: 7,     def: 0,    rw: true  },
  { code: 'P2-10', addr: 0x200A, name: 'Límite superior de par',        scale: 0.1, unit: '%',   min: 0,    max: 2000,  def: 1500, rw: true  },
];

// ─── Grupo P3: Control V/F ────────────────────────────────────────────────────
const GROUP_P3 = [
  { code: 'P3-00', addr: 0x3000, name: 'Modo curva V/F',               scale: 1,    unit: '',    min: 0,    max: 1,     def: 0,    rw: true  },
  { code: 'P3-01', addr: 0x3001, name: 'Boost de par',                 scale: 0.1,  unit: '%',   min: 0,    max: 300,   def: 50,   rw: true  },
  { code: 'P3-02', addr: 0x3002, name: 'Frecuencia boost de par',      scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 500,  rw: true  },
  { code: 'P3-03', addr: 0x3003, name: 'Voltaje punto V/F 1',          scale: 0.1,  unit: 'V',   min: 0,    max: 3800,  def: 0,    rw: true  },
  { code: 'P3-04', addr: 0x3004, name: 'Frecuencia punto V/F 1',       scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 0,    rw: true  },
  { code: 'P3-05', addr: 0x3005, name: 'Voltaje punto V/F 2',          scale: 0.1,  unit: 'V',   min: 0,    max: 3800,  def: 0,    rw: true  },
  { code: 'P3-06', addr: 0x3006, name: 'Frecuencia punto V/F 2',       scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 2500, rw: true  },
  { code: 'P3-07', addr: 0x3007, name: 'Voltaje punto V/F 3 (máx)',    scale: 0.1,  unit: 'V',   min: 0,    max: 3800,  def: 3800, rw: true  },
  { code: 'P3-08', addr: 0x3008, name: 'Frecuencia punto V/F 3 (máx)', scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 5000, rw: true  },
  { code: 'P3-10', addr: 0x300A, name: 'Compensación de deslizamiento',scale: 0.1,  unit: '%',   min: 0,    max: 2000,  def: 1000, rw: true  },
];

// ─── Grupo P4: Terminales de entrada ─────────────────────────────────────────
const GROUP_P4 = [
  { code: 'P4-00', addr: 0x4000, name: 'Función terminal X1',          scale: 1,    unit: '',    min: 0,    max: 50,    def: 1,    rw: true  },
  { code: 'P4-01', addr: 0x4001, name: 'Función terminal X2',          scale: 1,    unit: '',    min: 0,    max: 50,    def: 2,    rw: true  },
  { code: 'P4-02', addr: 0x4002, name: 'Función terminal X3',          scale: 1,    unit: '',    min: 0,    max: 50,    def: 9,    rw: true  },
  { code: 'P4-03', addr: 0x4003, name: 'Función terminal X4',          scale: 1,    unit: '',    min: 0,    max: 50,    def: 0,    rw: true  },
  { code: 'P4-04', addr: 0x4004, name: 'Función terminal HDI (X5)',    scale: 1,    unit: '',    min: 0,    max: 50,    def: 0,    rw: true  },
  { code: 'P4-09', addr: 0x4009, name: 'Tiempo filtro terminales X',   scale: 0.001,unit: 's',   min: 0,    max: 1000,  def: 10,   rw: true  },
  { code: 'P4-10', addr: 0x400A, name: 'Modo comando terminal',        scale: 1,    unit: '',    min: 0,    max: 3,     def: 0,    rw: true  },
  { code: 'P4-11', addr: 0x400B, name: 'Tasa cambio arriba/abajo',     scale: 0.001,unit: 'Hz/s',min: 1,    max: 65535, def: 1000, rw: true  },
  { code: 'P4-13', addr: 0x400D, name: 'Voltaje mín. AI1',             scale: 0.01, unit: 'V',   min: 0,    max: 1000,  def: 0,    rw: true  },
  { code: 'P4-14', addr: 0x400E, name: 'Config. mín. AI1 (corresponde)',scale: 0.1, unit: '%',   min:-1000, max: 1000,  def: 0,    rw: true  },
  { code: 'P4-15', addr: 0x400F, name: 'Voltaje máx. AI1',             scale: 0.01, unit: 'V',   min: 0,    max: 1000,  def: 1000, rw: true  },
  { code: 'P4-16', addr: 0x4010, name: 'Config. máx. AI1 (corresponde)',scale: 0.1, unit: '%',   min:-1000, max: 1000,  def: 1000, rw: true  },
  { code: 'P4-17', addr: 0x4011, name: 'Tiempo filtro AI1',            scale: 0.01, unit: 's',   min: 0,    max: 1000,  def: 10,   rw: true  },
  { code: 'P4-18', addr: 0x4012, name: 'Voltaje mín. AI2',             scale: 0.01, unit: 'V',   min: 0,    max: 1000,  def: 0,    rw: true  },
  { code: 'P4-19', addr: 0x4013, name: 'Config. mín. AI2 (corresponde)',scale: 0.1, unit: '%',   min:-1000, max: 1000,  def: 0,    rw: true  },
  { code: 'P4-20', addr: 0x4014, name: 'Voltaje máx. AI2',             scale: 0.01, unit: 'V',   min: 0,    max: 1000,  def: 1000, rw: true  },
  { code: 'P4-21', addr: 0x4015, name: 'Config. máx. AI2 (corresponde)',scale: 0.1, unit: '%',   min:-1000, max: 1000,  def: 1000, rw: true  },
  { code: 'P4-33', addr: 0x4021, name: 'Selección curva AI',           scale: 1,    unit: '',    min: 1,    max: 3,     def: 1,    rw: true  },
  { code: 'P4-38', addr: 0x4026, name: 'Modo válido terminales X',     scale: 1,    unit: '',    min: 0,    max: 1,     def: 0,    rw: true  },
];

// ─── Grupo P5: Terminales de salida ──────────────────────────────────────────
const GROUP_P5 = [
  { code: 'P5-00', addr: 0x5000, name: 'Función salida DO1',           scale: 1,    unit: '',    min: 0,    max: 40,    def: 1,    rw: true  },
  { code: 'P5-01', addr: 0x5001, name: 'Función salida DO2',           scale: 1,    unit: '',    min: 0,    max: 40,    def: 5,    rw: true  },
  { code: 'P5-02', addr: 0x5002, name: 'Función salida DO3',           scale: 1,    unit: '',    min: 0,    max: 40,    def: 0,    rw: true  },
  { code: 'P5-03', addr: 0x5003, name: 'Función salida Relé 1 (TA-TC)',scale: 1,    unit: '',    min: 0,    max: 40,    def: 5,    rw: true  },
  { code: 'P5-04', addr: 0x5004, name: 'Función salida Relé 2 (TB-TC)',scale: 1,    unit: '',    min: 0,    max: 40,    def: 0,    rw: true  },
  { code: 'P5-07', addr: 0x5007, name: 'Función salida AO1 (0-10V)',   scale: 1,    unit: '',    min: 0,    max: 15,    def: 0,    rw: true  },
  { code: 'P5-08', addr: 0x5008, name: 'Función salida AO2 (0-20mA)',  scale: 1,    unit: '',    min: 0,    max: 15,    def: 1,    rw: true  },
  { code: 'P5-09', addr: 0x5009, name: 'Función salida FMP (pulso)',   scale: 1,    unit: '',    min: 0,    max: 15,    def: 0,    rw: true  },
  { code: 'P5-10', addr: 0x500A, name: 'Salida AO1 mín. (corr. 0%)',  scale: 0.1,  unit: '%',   min: 0,    max: 1000,  def: 0,    rw: true  },
  { code: 'P5-11', addr: 0x500B, name: 'Salida AO1 máx. (corr. 100%)',scale: 0.1,  unit: '%',   min: 0,    max: 1000,  def: 1000, rw: true  },
  { code: 'P5-18', addr: 0x5012, name: 'Umbral de detección frec.',    scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 5000, rw: true  },
  { code: 'P5-19', addr: 0x5013, name: 'Histéresis detección frec.',   scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 100,  rw: true  },
];

// ─── Grupo P6: Arranque y parada ─────────────────────────────────────────────
const GROUP_P6 = [
  { code: 'P6-00', addr: 0x6000, name: 'Modo de arranque',             scale: 1,    unit: '',    min: 0,    max: 2,     def: 0,    rw: true  },
  { code: 'P6-01', addr: 0x6001, name: 'Frecuencia de arranque',       scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 0,    rw: true  },
  { code: 'P6-02', addr: 0x6002, name: 'Tiempo hold frec. arranque',   scale: 0.01, unit: 's',   min: 0,    max: 10000, def: 0,    rw: true  },
  { code: 'P6-03', addr: 0x6003, name: 'Tiempo freno DC al arranque',  scale: 0.1,  unit: 's',   min: 0,    max: 1000,  def: 0,    rw: true  },
  { code: 'P6-04', addr: 0x6004, name: 'Corriente freno DC arranque',  scale: 0.1,  unit: '%',   min: 0,    max: 1000,  def: 0,    rw: true  },
  { code: 'P6-05', addr: 0x6005, name: 'Modo de parada',               scale: 1,    unit: '',    min: 0,    max: 1,     def: 0,    rw: true  },
  { code: 'P6-07', addr: 0x6007, name: 'Frec. inicio freno DC parada', scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 0,    rw: true  },
  { code: 'P6-08', addr: 0x6008, name: 'Tiempo espera freno DC parada',scale: 0.1,  unit: 's',   min: 0,    max: 1000,  def: 0,    rw: true  },
  { code: 'P6-09', addr: 0x6009, name: 'Corriente freno DC parada',    scale: 0.1,  unit: '%',   min: 0,    max: 1000,  def: 0,    rw: true  },
  { code: 'P6-10', addr: 0x600A, name: 'Tiempo freno DC parada',       scale: 0.1,  unit: 's',   min: 0,    max: 1000,  def: 0,    rw: true  },
  { code: 'P6-11', addr: 0x600B, name: 'Frec. arranque marcha en giro',scale: 0.01, unit: 'Hz',  min: 0,    max: 32000, def: 0,    rw: true  },
  { code: 'P6-12', addr: 0x600C, name: 'Corriente parada marcha giro', scale: 0.1,  unit: '%',   min: 0,    max: 2000,  def: 1000, rw: true  },
];

// ─── Grupo P7: Teclado y monitor ─────────────────────────────────────────────
const GROUP_P7 = [
  { code: 'P7-00', addr: 0x7000, name: 'Selección visualización 1',    scale: 1,    unit: '',    min: 0,    max: 0xFFFF,def: 0x003F,rw: true },
  { code: 'P7-01', addr: 0x7001, name: 'Selección visualización 2',    scale: 1,    unit: '',    min: 0,    max: 0xFFFF,def: 0,    rw: true  },
  { code: 'P7-06', addr: 0x7006, name: 'Modo de visualización teclado',scale: 1,    unit: '',    min: 0,    max: 2,     def: 0,    rw: true  },
];

// ─── Grupo P9: Falla y protección ────────────────────────────────────────────
const GROUP_P9 = [
  { code: 'P9-00', addr: 0x9000, name: 'Protección sobrecarga motor',  scale: 1,    unit: '',    min: 0,    max: 2,     def: 1,    rw: true  },
  { code: 'P9-01', addr: 0x9001, name: 'Umbral sobrecarga motor',      scale: 0.1,  unit: '%',   min: 200,  max: 2000,  def: 1600, rw: true  },
  { code: 'P9-02', addr: 0x9002, name: 'Tiempo sobrecarga motor',      scale: 0.1,  unit: 'min', min: 1,    max: 3600,  def: 600,  rw: true  },
  { code: 'P9-06', addr: 0x9006, name: 'Protección pérdida de fase',   scale: 1,    unit: '',    min: 0,    max: 1,     def: 1,    rw: true  },
  { code: 'P9-07', addr: 0x9007, name: 'Protección sobretensión bus',  scale: 1,    unit: '',    min: 0,    max: 1,     def: 1,    rw: true  },
  { code: 'P9-14', addr: 0x900E, name: 'Código de falla actual',       scale: 1,    unit: '',    min: 0,    max: 0xFFFF,def: 0,    rw: false },
  { code: 'P9-15', addr: 0x900F, name: 'Código de falla anterior 1',   scale: 1,    unit: '',    min: 0,    max: 0xFFFF,def: 0,    rw: false },
  { code: 'P9-16', addr: 0x9010, name: 'Código de falla anterior 2',   scale: 1,    unit: '',    min: 0,    max: 0xFFFF,def: 0,    rw: false },
];

// ─── Grupo PD: Comunicación Modbus ───────────────────────────────────────────
const GROUP_PD = [
  { code: 'Pd-00', addr: 0xD000, name: 'Velocidad en baudios',         scale: 1,    unit: '',    min: 0,    max: 9,     def: 5,    rw: true  },
  { code: 'Pd-01', addr: 0xD001, name: 'Formato de datos',             scale: 1,    unit: '',    min: 0,    max: 3,     def: 0,    rw: true  },
  { code: 'Pd-02', addr: 0xD002, name: 'Dirección esclavo',            scale: 1,    unit: '',    min: 0,    max: 247,   def: 1,    rw: true  },
  { code: 'Pd-03', addr: 0xD003, name: 'Retraso de respuesta',         scale: 1,    unit: 'ms',  min: 0,    max: 20,    def: 2,    rw: true  },
  { code: 'Pd-04', addr: 0xD004, name: 'Timeout de comunicación',      scale: 0.1,  unit: 's',   min: 0,    max: 600,   def: 0,    rw: true  },
  { code: 'Pd-05', addr: 0xD005, name: 'Selección protocolo Modbus',   scale: 1,    unit: '',    min: 0,    max: 1,     def: 1,    rw: true  },
  { code: 'Pd-06', addr: 0xD006, name: 'Resolución lectura corriente', scale: 1,    unit: '',    min: 0,    max: 1,     def: 0,    rw: true  },
];

// ─── Registros de monitor en tiempo real (grupo U0 / bloque 0x1000) ──────────
const MONITOR_REGISTERS = [
  { code: 'U0-00', addr: 0x1001, name: 'Frecuencia de salida',         scale: 0.01, unit: 'Hz'   },
  { code: 'U0-01', addr: 0x1002, name: 'Tensión bus DC',               scale: 1,    unit: 'V'    },
  { code: 'U0-02', addr: 0x1003, name: 'Tensión de salida',            scale: 1,    unit: 'V'    },
  { code: 'U0-03', addr: 0x1004, name: 'Corriente de salida',          scale: 0.1,  unit: 'A'    },
  { code: 'U0-04', addr: 0x1005, name: 'Potencia de salida',           scale: 0.1,  unit: 'kW'   },
  { code: 'U0-05', addr: 0x1006, name: 'Par de salida',                scale: 0.1,  unit: '%'    },
  { code: 'U0-06', addr: 0x1007, name: 'Velocidad de funcionamiento',  scale: 1,    unit: 'rpm'  },
  { code: 'U0-07', addr: 0x1008, name: 'Estado entradas digitales DI', scale: 1,    unit: ''     },
  { code: 'U0-08', addr: 0x1009, name: 'Estado salidas digitales DO',  scale: 1,    unit: ''     },
  { code: 'U0-09', addr: 0x100A, name: 'Voltaje AI1',                  scale: 0.01, unit: 'V'    },
  { code: 'U0-10', addr: 0x100B, name: 'Voltaje AI2',                  scale: 0.01, unit: 'V'    },
  { code: 'U0-11', addr: 0x100C, name: 'Voltaje AI3',                  scale: 0.01, unit: 'V'    },
  { code: 'U0-16', addr: 0x1010, name: 'Consigna PID',                 scale: 0.01, unit: '%'    },
  { code: 'U0-17', addr: 0x1011, name: 'Retroalimentación PID',        scale: 0.01, unit: '%'    },
  { code: 'U0-19', addr: 0x101B, name: 'Velocidad real motor',         scale: 1,    unit: 'rpm'  },
  { code: 'U0-31', addr: 0x1020, name: 'Frecuencia auxiliar Y',        scale: 0.01, unit: 'Hz'   },
];

// ─── Registros de control (escritura) ────────────────────────────────────────
const CONTROL_REGISTERS = {
  COMMAND:       { addr: 0x2000, name: 'Comando de control' },
  DO_CONTROL:    { addr: 0x2001, name: 'Control salidas DO' },
  AO1_CONTROL:   { addr: 0x2002, name: 'Control salida AO1' },
  AO2_CONTROL:   { addr: 0x2003, name: 'Control salida AO2' },
  FMP_CONTROL:   { addr: 0x2004, name: 'Control salida FMP' },
  RUN_STATUS:    { addr: 0x3000, name: 'Estado de funcionamiento' },
  FAULT_CODE:    { addr: 0x8000, name: 'Código de falla activa' },
  FREQ_SETPOINT: { addr: 0x1000, name: 'Consigna de frecuencia por comms' },
  USER_PASSWORD: { addr: 0x1F00, name: 'Contraseña usuario' },
  PARAM_INIT:    { addr: 0x1F01, name: 'Inicialización parámetros' },
};

// Valores de comando (dirección 0x2000)
const COMMAND_VALUES = {
  RUN_FORWARD:  0x0001,
  RUN_REVERSE:  0x0002,
  JOG_FORWARD:  0x0003,
  JOG_REVERSE:  0x0004,
  FREE_STOP:    0x0005,
  RAMP_STOP:    0x0006,
  FAULT_RESET:  0x0007,
};

// ─── Mapa de fallas ───────────────────────────────────────────────────────────
const FAULT_MAP = {
  0x0001: { name: 'Reservado',                            severity: 'low'  },
  0x0002: { name: 'Sobrecorriente en aceleración',        severity: 'high' },
  0x0003: { name: 'Sobrecorriente en desaceleración',     severity: 'high' },
  0x0004: { name: 'Sobrecorriente a velocidad constante', severity: 'high' },
  0x0005: { name: 'Sobretensión en aceleración',          severity: 'high' },
  0x0006: { name: 'Sobretensión en desaceleración',       severity: 'high' },
  0x0007: { name: 'Sobretensión a velocidad constante',   severity: 'high' },
  0x0008: { name: 'Error sobrecarga buffer',              severity: 'med'  },
  0x0009: { name: 'Sin tensión (bajo voltaje)',            severity: 'med'  },
  0x000A: { name: 'Sobrecalentamiento inverter',          severity: 'high' },
  0x000B: { name: 'Sobrecarga motor',                     severity: 'med'  },
  0x000C: { name: 'Falta de fase en entrada',             severity: 'high' },
  0x000D: { name: 'Falta de fase en salida',              severity: 'high' },
  0x000E: { name: 'Sobrecalentamiento módulo',            severity: 'high' },
  0x000F: { name: 'Falla externa',                        severity: 'med'  },
  0x0010: { name: 'Anomalía de comunicación',             severity: 'med'  },
  0x0011: { name: 'Contactor anormal',                    severity: 'med'  },
  0x0012: { name: 'Falla detección de corriente',         severity: 'high' },
  0x0013: { name: 'Falla sintonización motor',            severity: 'med'  },
  0x0014: { name: 'Falla encoder/tarjeta PG',             severity: 'med'  },
  0x0015: { name: 'Anomalía lectura/escritura EEPROM',    severity: 'med'  },
  0x0016: { name: 'Falla hardware convertidor',           severity: 'high' },
  0x0017: { name: 'Cortocircuito motor a tierra',         severity: 'high' },
  0x001A: { name: 'Error en tiempo de ejecución',         severity: 'med'  },
  0x001B: { name: 'Error definido por usuario 1',         severity: 'med'  },
  0x001C: { name: 'Error definido por usuario 2',         severity: 'med'  },
  0x001D: { name: 'Tiempo de encendido alcanzado',        severity: 'low'  },
  0x001F: { name: 'PID sin retroalimentación (timeout)',  severity: 'med'  },
  0x0028: { name: 'Límite de corriente rápida (timeout)', severity: 'high' },
  0x0029: { name: 'Falla motor en conmutación',           severity: 'med'  },
  0x002A: { name: 'Desviación de velocidad excesiva',     severity: 'med'  },
  0x002B: { name: 'Motor acelarando anormalmente',        severity: 'med'  },
  0x005A: { name: 'Error número de líneas encoder',       severity: 'med'  },
  0x005B: { name: 'Sin encoder',                          severity: 'high' },
  0x005C: { name: 'Error de posición inicial',            severity: 'med'  },
  0x005E: { name: 'Error de retroalimentación velocidad', severity: 'med'  },
};

// ─── Exportaciones ────────────────────────────────────────────────────────────
const ALL_GROUPS = {
  P0: GROUP_P0,
  P1: GROUP_P1,
  P2: GROUP_P2,
  P3: GROUP_P3,
  P4: GROUP_P4,
  P5: GROUP_P5,
  P6: GROUP_P6,
  P7: GROUP_P7,
  P9: GROUP_P9,
  PD: GROUP_PD,
};

/** Busca un parámetro por código (ej: 'P0-08') */
function findByCode(code) {
  for (const group of Object.values(ALL_GROUPS)) {
    const found = group.find(p => p.code === code);
    if (found) return found;
  }
  return null;
}

/** Busca un parámetro por dirección Modbus */
function findByAddress(addr) {
  for (const group of Object.values(ALL_GROUPS)) {
    const found = group.find(p => p.addr === addr);
    if (found) return found;
  }
  return MONITOR_REGISTERS.find(p => p.addr === addr) || null;
}

/** Convierte valor crudo Modbus → valor real */
function rawToReal(param, rawValue) {
  // Registros de 16-bit con signo
  if (rawValue > 32767) rawValue -= 65536;
  return +(rawValue * param.scale).toFixed(4);
}

/** Convierte valor real → valor crudo Modbus */
function realToRaw(param, realValue) {
  return Math.round(realValue / param.scale) & 0xFFFF;
}

module.exports = {
  ALL_GROUPS,
  GROUP_P0, GROUP_P1, GROUP_P2, GROUP_P3, GROUP_P4,
  GROUP_P5, GROUP_P6, GROUP_P7, GROUP_P9, GROUP_PD,
  MONITOR_REGISTERS,
  CONTROL_REGISTERS,
  COMMAND_VALUES,
  FAULT_MAP,
  findByCode,
  findByAddress,
  rawToReal,
  realToRaw,
};