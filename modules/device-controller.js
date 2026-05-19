'use strict';

const logger = require('./logger');

// Importaciones del mapa estático del SU900 (usadas como fallback cuando no
// se proporciona un perfil JSON externo).
const staticMap = require('./register-map');

/**
 * Adaptador que expone la interfaz de perfil dinámico sobre el register-map
 * estático, de modo que DeviceController funcione igual con ambos.
 */
function _wrapStaticMap() {
  return {
    id: 'suswe-su900',
    name: 'SUSWE SU800/SU900 (built-in)',
    _paramIndex: (() => {
      const idx = {};
      for (const group of Object.values(staticMap.ALL_GROUPS)) {
        for (const p of group) {
          idx[p.code] = { ...p, addrNum: p.addr, groupId: p.code.split('-')[0].toUpperCase() };
        }
      }
      return idx;
    })(),
    groups: Object.entries(staticMap.ALL_GROUPS).map(([id, params]) => ({
      id,
      name: id,
      params: params.map(p => ({ ...p, addrNum: p.addr })),
    })),
    controlRegisters: {
      freqSetpoint: { addrNum: staticMap.CONTROL_REGISTERS.FREQ_SETPOINT.addr },
      command:      { addrNum: staticMap.CONTROL_REGISTERS.COMMAND.addr },
      doControl:    { addrNum: staticMap.CONTROL_REGISTERS.DO_CONTROL.addr },
      ao1Control:   { addrNum: staticMap.CONTROL_REGISTERS.AO1_CONTROL.addr },
      ao2Control:   { addrNum: staticMap.CONTROL_REGISTERS.AO2_CONTROL.addr },
      fmpControl:   { addrNum: staticMap.CONTROL_REGISTERS.FMP_CONTROL.addr },
      runStatus:    { addrNum: staticMap.CONTROL_REGISTERS.RUN_STATUS.addr },
      faultCode:    { addrNum: staticMap.CONTROL_REGISTERS.FAULT_CODE.addr },
    },
    commandValues:      staticMap.COMMAND_VALUES,
    monitorBlock: {
      startAddrNum: 0x1001,
      count:        32,
      registers: staticMap.MONITOR_REGISTERS.map(r => ({
        ...r, addrNum: r.addr, offset: r.addr - 0x1001,
      })),
    },
    faultHistoryAddrsNum: [0x900E, 0x900F, 0x9010],
    faultMapNum: (() => {
      const m = {};
      for (const [k, v] of Object.entries(staticMap.FAULT_MAP)) m[k] = v;
      return m;
    })(),
  };
}

// Conversión raw ↔ real (idéntica a la de register-map, pero operando
// sobre el campo `scale` del objeto param del perfil)
function _rawToReal(param, rawValue) {
  const scale = param.scale !== undefined ? param.scale : 1;
  const signed = rawValue > 32767 ? rawValue - 65536 : rawValue;
  return +(signed * scale).toFixed(4);
}

function _realToRaw(param, realValue) {
  const scale = param.scale !== undefined ? param.scale : 1;
  if (scale === 0) return 0;
  return Math.round(realValue / scale) & 0xFFFF;
}

class DeviceController {
  /**
   * @param {ModbusRTUTransport|ModbusTCPTransport} transport
   * @param {object|null} profile  Perfil JSON normalizado por DeviceProfile.parseProfile().
   *                               Si es null usa el mapa estático del SU900.
   */
  constructor(transport, profile = null) {
    this.transport = transport;
    this.profile   = profile || _wrapStaticMap();
  }

  // ─── Parámetros ────────────────────────────────────────────────────────────

  async readParam(code) {
    const param = this.profile._paramIndex[code];
    if (!param) throw new Error(`Parámetro desconocido: ${code}`);

    const [rawValue] = await this.transport.readRegisters(param.addrNum, 1);
    const realValue  = _rawToReal(param, rawValue);

    logger.info(`Leer ${code} (0x${param.addrNum.toString(16).padStart(4,'0')}): raw=${rawValue} → ${realValue} ${param.unit || ''}`);
    return { code, addr: param.addrNum, name: param.name, rawValue, realValue, unit: param.unit || '' };
  }

  async writeParam(code, realValue) {
    const param = this.profile._paramIndex[code];
    if (!param)    throw new Error(`Parámetro desconocido: ${code}`);
    if (!param.rw) throw new Error(`El parámetro ${code} es de solo lectura.`);

    const minReal = param.min !== undefined ? param.min * (param.scale || 1) : undefined;
    const maxReal = param.max !== undefined ? param.max * (param.scale || 1) : undefined;
    if (minReal !== undefined && realValue < minReal)
      throw new Error(`Valor ${realValue} fuera de rango mínimo (${minReal} ${param.unit || ''})`);
    if (maxReal !== undefined && realValue > maxReal)
      throw new Error(`Valor ${realValue} fuera de rango máximo (${maxReal} ${param.unit || ''})`);

    const rawValue = _realToRaw(param, realValue);
    await this.transport.writeRegister(param.addrNum, rawValue);

    logger.info(`Escribir ${code} (0x${param.addrNum.toString(16).padStart(4,'0')}): ${realValue} → raw=${rawValue}`);
    return { code, addr: param.addrNum, name: param.name, rawValue, realValue, unit: param.unit || '' };
  }

  /**
   * Lee todos los parámetros de un grupo individualmente.
   * ⚠ P1/P2/P3 comparten espacio con registros de control — nunca en bloque.
   */
  async readGroup(groupName) {
    const group = this.profile.groups.find(
      g => g.id.toUpperCase() === groupName.toUpperCase()
    );
    if (!group) throw new Error(`Grupo desconocido: ${groupName}`);

    const results = [];
    for (const param of group.params) {
      try {
        const [rawValue] = await this.transport.readRegisters(param.addrNum, 1);
        results.push({
          code:      param.code,
          addr:      param.addrNum,
          name:      param.name,
          rawValue,
          realValue: _rawToReal(param, rawValue),
          unit:      param.unit || '',
          rw:        param.rw,
          ok:        true,
        });
      } catch (err) {
        results.push({ code: param.code, addr: param.addrNum, name: param.name, ok: false, error: err.message });
        logger.warn(`Error leyendo ${param.code}: ${err.message}`);
      }
    }
    return results;
  }

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

  async readMonitor() {
    const mb     = this.profile.monitorBlock;
    const start  = mb.startAddrNum;
    const count  = mb.count || 32;

    const rawBlock = await this.transport.readRegisters(start, count);

    const result = {};
    for (const reg of mb.registers || []) {
      const offset = reg.offset !== undefined ? reg.offset : (reg.addrNum - start);
      if (offset >= 0 && offset < rawBlock.length) {
        const raw = rawBlock[offset];
        result[reg.code] = {
          code:      reg.code,
          name:      reg.name,
          rawValue:  raw,
          realValue: _rawToReal(reg, raw),
          unit:      reg.unit || '',
        };
      }
    }
    return result;
  }

  // ─── Estado y control ──────────────────────────────────────────────────────

  async readRunStatus() {
    const addr = this.profile.controlRegisters.runStatus.addrNum;
    const [raw] = await this.transport.readRegisters(addr, 1);
    return {
      raw,
      running:   (raw & 0x03) !== 0,
      direction: (raw & 0x02) ? 'reverse' : 'forward',
      status:    raw === 0x0001 ? 'forward' : raw === 0x0002 ? 'reverse' : raw === 0x0003 ? 'stopped' : 'unknown',
    };
  }

  async sendCommand(cmd) {
    const cmdVals = this.profile.commandValues || staticMap.COMMAND_VALUES;
    const value   = cmdVals[cmd];
    if (value === undefined)
      throw new Error(`Comando desconocido: ${cmd}. Opciones: ${Object.keys(cmdVals).join(', ')}`);

    const addr = this.profile.controlRegisters.command.addrNum;
    await this.transport.writeRegister(addr, value);
    logger.info(`Comando enviado: ${cmd} (0x${value.toString(16).padStart(4,'0')})`);
    return { ok: true, command: cmd, value };
  }

  async setFrequency(freqHz, maxFreq = 50) {
    const pct = freqHz / maxFreq;
    const raw = Math.round(pct * 10000);
    if (raw < -10000 || raw > 10000)
      throw new Error(`Frecuencia ${freqHz} Hz fuera de rango (máx ${maxFreq} Hz)`);

    const addr = this.profile.controlRegisters.freqSetpoint.addrNum;
    await this.transport.writeRegister(addr, raw < 0 ? raw + 65536 : raw);
    logger.info(`Consigna de frecuencia: ${freqHz} Hz (raw=${raw})`);
    return { ok: true, freqHz, raw };
  }

  async setDigitalOutputs(bits) {
    // Mapa según manual Cap.5 registro 0x2001: bit0=DO1, bit1=DO2, bit2=RELAY1, bit3=RELAY2, bit4=FMR, bit5-9=VDO1-5
    const BIT_MAP = { DO1: 0, DO2: 1, RELAY1: 2, RELAY2: 3, FMR: 4, VDO1: 5, VDO2: 6, VDO3: 7, VDO4: 8, VDO5: 9 };
    let word = 0;
    for (const [key, val] of Object.entries(bits)) {
      const bit = BIT_MAP[key];
      if (bit === undefined) throw new Error(`Salida digital desconocida: ${key}`);
      if (val) word |= (1 << bit);
    }
    const addr = this.profile.controlRegisters.doControl.addrNum;
    await this.transport.writeRegister(addr, word);
    logger.info(`Salidas DO: 0x${word.toString(16).padStart(4,'0')}`);
    return { ok: true, word, bits };
  }

  async setAnalogOutput(channel, percent) {
    const aoMap = {
      AO1: this.profile.controlRegisters.ao1Control?.addrNum || 0x2002,
      AO2: this.profile.controlRegisters.ao2Control?.addrNum || 0x2003,
      FMP: this.profile.controlRegisters.fmpControl?.addrNum || 0x2004,
    };
    const addr = aoMap[channel];
    if (!addr) throw new Error(`Canal analógico desconocido: ${channel}`);

    const raw = Math.round((percent / 100) * 0x7FFF);
    await this.transport.writeRegister(addr, Math.max(0, Math.min(0x7FFF, raw)));
    logger.info(`Salida analógica ${channel}: ${percent.toFixed(1)}% (raw=${raw})`);
    return { ok: true, channel, percent, raw };
  }

  // ─── Fallas ────────────────────────────────────────────────────────────────

  async readFaultCode() {
    const addr = this.profile.controlRegisters.faultCode.addrNum;
    const [raw] = await this.transport.readRegisters(addr, 1);
    const faultMap = this.profile.faultMapNum || {};
    const fault    = faultMap[raw] || null;
    return {
      raw,
      code:     `0x${raw.toString(16).padStart(4,'0')}`,
      hasFault: raw !== 0,
      name:     fault ? fault.name     : raw === 0 ? 'Sin falla' : 'Falla desconocida',
      severity: fault ? fault.severity : raw === 0 ? 'none'      : 'unknown',
    };
  }

  async readFaultHistory() {
    const addrs   = this.profile.faultHistoryAddrsNum || [0x900E, 0x900F, 0x9010];
    const faultMap = this.profile.faultMapNum || {};
    const history  = [];
    for (const addr of addrs) {
      try {
        const [raw] = await this.transport.readRegisters(addr, 1);
        const fault = faultMap[raw];
        history.push({
          addr:     `0x${addr.toString(16).padStart(4,'0')}`,
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

  async resetFault() {
    return this.sendCommand('FAULT_RESET');
  }

  // ─── Perfiles completos ────────────────────────────────────────────────────

  async readFullProfile() {
    const snapshot = { timestamp: new Date().toISOString(), groups: {} };
    for (const group of this.profile.groups) {
      snapshot.groups[group.id] = await this.readGroup(group.id);
      await new Promise(r => setTimeout(r, 50));
    }
    return snapshot;
  }

  async writeFullProfile(profile) {
    const results = { ok: [], errors: [] };
    for (const params of Object.values(profile.groups || {})) {
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

  /** Retorna metadata del perfil cargado actualmente */
  getProfileInfo() {
    return {
      id:          this.profile.id,
      name:        this.profile.name,
      description: this.profile.description || '',
      groupCount:  this.profile.groups.length,
      paramCount:  Object.keys(this.profile._paramIndex).length,
    };
  }
}

module.exports = DeviceController;
