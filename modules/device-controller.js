/**
 * modules/device-controller.js
 * Controlador de alto nivel para el inverter SUSWE SU900-30R0G3
 *
 * Abstrae las operaciones Modbus de bajo nivel y expone métodos semánticos:
 *  - leer/escribir parámetros por código (ej: 'P0-08')
 *  - leer todos los parámetros de un grupo
 *  - monitoreo en tiempo real
 *  - comandos de control (arrancar, parar, reset)
 *  - gestión de fallas
 */

'use strict';

const logger = require('./logger');
const {
  ALL_GROUPS,
  MONITOR_REGISTERS,
  CONTROL_REGISTERS,
  COMMAND_VALUES,
  FAULT_MAP,
  findByCode,
  rawToReal,
  realToRaw,
} = require('./register-map');

class DeviceController {
  /**
   * @param {ModbusRTUTransport|ModbusTCPTransport} transport
   */
  constructor(transport) {
    this.transport = transport;
  }

  // ─── Parámetros ────────────────────────────────────────────────────────────

  /**
   * Lee el valor actual de un parámetro por su código
   * @param {string} code  Ej: 'P0-08', 'Pd-00'
   * @returns {{ code, addr, name, rawValue, realValue, unit }}
   */
  async readParam(code) {
    const param = findByCode(code);
    if (!param) throw new Error(`Parámetro desconocido: ${code}`);

    const [rawValue] = await this.transport.readRegisters(param.addr, 1);
    const realValue  = rawToReal(param, rawValue);

    logger.info(`Leer ${code} (0x${param.addr.toString(16).padStart(4,'0')}): raw=${rawValue} → ${realValue} ${param.unit}`);

    return { code, addr: param.addr, name: param.name, rawValue, realValue, unit: param.unit };
  }

  /**
   * Escribe el valor de un parámetro por su código
   * @param {string} code       Ej: 'P0-08'
   * @param {number} realValue  Valor en unidades reales (se convierte a crudo internamente)
   */
  async writeParam(code, realValue) {
    const param = findByCode(code);
    if (!param)     throw new Error(`Parámetro desconocido: ${code}`);
    if (!param.rw)  throw new Error(`El parámetro ${code} es de solo lectura.`);

    if (param.min !== undefined && realValue < param.min * param.scale)
      throw new Error(`Valor ${realValue} fuera de rango mínimo (${param.min * param.scale} ${param.unit})`);
    if (param.max !== undefined && realValue > param.max * param.scale)
      throw new Error(`Valor ${realValue} fuera de rango máximo (${param.max * param.scale} ${param.unit})`);

    const rawValue = realToRaw(param, realValue);
    await this.transport.writeRegister(param.addr, rawValue);

    logger.info(`Escribir ${code} (0x${param.addr.toString(16).padStart(4,'0')}): ${realValue} ${param.unit} → raw=${rawValue}`);
    return { code, addr: param.addr, name: param.name, rawValue, realValue, unit: param.unit };
  }

  /**
   * Lee todos los parámetros de un grupo (lectura individual, no en bloque,
   * para no cruzar límites de grupo según restricción del manual)
   * @param {string} groupName  Ej: 'P0', 'PD', 'P1'
   */
  async readGroup(groupName) {
    const group = ALL_GROUPS[groupName.toUpperCase()];
    if (!group) throw new Error(`Grupo desconocido: ${groupName}`);

    const results = [];
    for (const param of group) {
      try {
        const [rawValue] = await this.transport.readRegisters(param.addr, 1);
        results.push({
          code:      param.code,
          addr:      param.addr,
          name:      param.name,
          rawValue,
          realValue: rawToReal(param, rawValue),
          unit:      param.unit,
          rw:        param.rw,
          ok:        true,
        });
      } catch (err) {
        results.push({ code: param.code, addr: param.addr, name: param.name, ok: false, error: err.message });
        logger.warn(`Error leyendo ${param.code}: ${err.message}`);
      }
    }
    return results;
  }

  /**
   * Escribe múltiples parámetros de una vez
   * @param {Array<{code:string, value:number}>} items
   */
  async writeMultipleParams(items) {
    const results = [];
    for (const { code, value } of items) {
      try {
        const result = await this.writeParam(code, value);
        results.push({ ...result, ok: true });
      } catch (err) {
        results.push({ code, ok: false, error: err.message });
        logger.warn(`Error escribiendo ${code}: ${err.message}`);
      }
    }
    return results;
  }

  // ─── Monitor en tiempo real ────────────────────────────────────────────────

  /**
   * Lee todos los registros de monitoreo de una sola vez (bloque continuo U0)
   * El bloque 0x1001~0x101F es contiguo según manual → lectura eficiente FC=0x03
   */
  async readMonitor() {
    const startAddr = 0x1001;
    const count     = 0x0020;   // 32 registros

    let rawBlock;
    try {
      rawBlock = await this.transport.readRegisters(startAddr, count);
    } catch (err) {
      logger.error(`Error leyendo bloque monitor: ${err.message}`);
      throw err;
    }

    const result = {};
    for (const reg of MONITOR_REGISTERS) {
      const offset = reg.addr - startAddr;
      if (offset >= 0 && offset < rawBlock.length) {
        let raw = rawBlock[offset];
        result[reg.code] = {
          code:      reg.code,
          name:      reg.name,
          rawValue:  raw,
          realValue: rawToReal(reg, raw),
          unit:      reg.unit,
        };
      }
    }
    return result;
  }

  // ─── Estado y control ──────────────────────────────────────────────────────

  /**
   * Lee el estado de funcionamiento del inverter (registro 0x3000)
   * @returns {{ running, direction, status, raw }}
   */
  async readRunStatus() {
    const [raw] = await this.transport.readRegisters(CONTROL_REGISTERS.RUN_STATUS.addr, 1);
    return {
      raw,
      running:   (raw & 0x03) !== 0,
      direction: (raw & 0x02) ? 'reverse' : 'forward',
      status:    raw === 0x0001 ? 'forward' : raw === 0x0002 ? 'reverse' : raw === 0x0003 ? 'stopped' : 'unknown',
    };
  }

  /**
   * Envía un comando de control al inverter (registro 0x2000)
   * @param {'RUN_FORWARD'|'RUN_REVERSE'|'JOG_FORWARD'|'JOG_REVERSE'|'FREE_STOP'|'RAMP_STOP'|'FAULT_RESET'} cmd
   */
  async sendCommand(cmd) {
    const value = COMMAND_VALUES[cmd];
    if (value === undefined) throw new Error(`Comando desconocido: ${cmd}. Opciones: ${Object.keys(COMMAND_VALUES).join(', ')}`);

    await this.transport.writeRegister(CONTROL_REGISTERS.COMMAND.addr, value);
    logger.info(`Comando enviado: ${cmd} (0x${value.toString(16).padStart(4,'0')})`);
    return { ok: true, command: cmd, value };
  }

  /**
   * Establece la frecuencia de consigna vía comunicación
   * Requiere P0-03=9 (fuente de frecuencia = comunicación)
   * Rango: -10000 ~ +10000 → -100.00% ~ +100.00% de la frecuencia máxima
   * @param {number} freqHz  Frecuencia en Hz
   * @param {number} maxFreq Frecuencia máxima configurada (P0-10), por defecto 50 Hz
   */
  async setFrequency(freqHz, maxFreq = 50) {
    const pct   = freqHz / maxFreq;
    const raw   = Math.round(pct * 10000);
    if (raw < -10000 || raw > 10000) throw new Error(`Frecuencia ${freqHz} Hz fuera de rango (máx ${maxFreq} Hz)`);

    await this.transport.writeRegister(CONTROL_REGISTERS.FREQ_SETPOINT.addr, raw < 0 ? raw + 65536 : raw);
    logger.info(`Consigna de frecuencia: ${freqHz} Hz (raw=${raw})`);
    return { ok: true, freqHz, raw };
  }

  /**
   * Controla las salidas digitales DO (registro 0x2001)
   * @param {object} bits  Ej: { DO1: true, DO2: false, RELAY1: true }
   */
  async setDigitalOutputs(bits) {
    const BIT_MAP = { DO1: 0, DO2: 1, RELAY1: 2, RELAY2: 3, FMR: 4, VDO1: 5, VDO2: 6, VDO3: 7, VDO4: 8, VDO5: 9 };
    let word = 0;
    for (const [key, val] of Object.entries(bits)) {
      const bit = BIT_MAP[key];
      if (bit === undefined) throw new Error(`Salida digital desconocida: ${key}`);
      if (val) word |= (1 << bit);
    }
    await this.transport.writeRegister(CONTROL_REGISTERS.DO_CONTROL.addr, word);
    logger.info(`Salidas DO: 0x${word.toString(16).padStart(4,'0')} → ${JSON.stringify(bits)}`);
    return { ok: true, word, bits };
  }

  /**
   * Controla una salida analógica AO (0x2002 = AO1, 0x2003 = AO2)
   * @param {'AO1'|'AO2'|'FMP'} channel
   * @param {number} percent  0.0 ~ 100.0 %
   */
  async setAnalogOutput(channel, percent) {
    const ADDR_MAP = { AO1: 0x2002, AO2: 0x2003, FMP: 0x2004 };
    const addr = ADDR_MAP[channel];
    if (!addr) throw new Error(`Canal analógico desconocido: ${channel}`);

    const raw = Math.round((percent / 100) * 0x7FFF);
    await this.transport.writeRegister(addr, Math.max(0, Math.min(0x7FFF, raw)));
    logger.info(`Salida analógica ${channel}: ${percent.toFixed(1)}% (raw=${raw})`);
    return { ok: true, channel, percent, raw };
  }

  // ─── Fallas ────────────────────────────────────────────────────────────────

  /** Lee el código de falla activa (registro fijo 0x8000) */
  async readFaultCode() {
    const [raw] = await this.transport.readRegisters(CONTROL_REGISTERS.FAULT_CODE.addr, 1);
    const fault = FAULT_MAP[raw] || null;
    return {
      raw,
      code:     `0x${raw.toString(16).padStart(4,'0')}`,
      hasFault: raw !== 0,
      name:     fault ? fault.name     : raw === 0 ? 'Sin falla' : 'Falla desconocida',
      severity: fault ? fault.severity : raw === 0 ? 'none'      : 'unknown',
    };
  }

  /** Lee el historial de fallas (P9-14, P9-15, P9-16) */
  async readFaultHistory() {
    const codes = [0x900E, 0x900F, 0x9010];
    const history = [];
    for (const addr of codes) {
      try {
        const [raw] = await this.transport.readRegisters(addr, 1);
        const fault = FAULT_MAP[raw];
        history.push({
          addr:  `0x${addr.toString(16).padStart(4,'0')}`,
          raw,
          hasFault: raw !== 0,
          name:     fault ? fault.name     : raw === 0 ? 'Sin falla' : 'Código desconocido',
          severity: fault ? fault.severity : 'unknown',
        });
      } catch (err) {
        history.push({ addr: `0x${addr.toString(16).padStart(4,'0')}`, error: err.message });
      }
    }
    return history;
  }

  /** Envía el comando de reset de fallas */
  async resetFault() {
    return this.sendCommand('FAULT_RESET');
  }

  // ─── Perfiles ──────────────────────────────────────────────────────────────

  /**
   * Lee todos los parámetros de todos los grupos → perfil completo
   * Útil para exportar la configuración del variador.
   */
  async readFullProfile() {
    const profile = { timestamp: new Date().toISOString(), groups: {} };
    for (const [groupName, group] of Object.entries(ALL_GROUPS)) {
      profile.groups[groupName] = await this.readGroup(groupName);
      // Pausa entre grupos para no saturar el bus
      await new Promise(r => setTimeout(r, 50));
    }
    return profile;
  }

  /**
   * Escribe un perfil completo al variador
   * @param {object} profile  Objeto devuelto por readFullProfile()
   */
  async writeFullProfile(profile) {
    const results = { ok: [], errors: [] };
    for (const [, params] of Object.entries(profile.groups || {})) {
      for (const param of params) {
        if (!param.ok || !param.rw) continue;
        try {
          await this.writeParam(param.code, param.realValue);
          results.ok.push(param.code);
        } catch (err) {
          results.errors.push({ code: param.code, error: err.message });
        }
      }
    }
    return results;
  }
}

module.exports = DeviceController;