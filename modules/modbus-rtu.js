/**
 * modules/modbus-rtu.js
 * Transporte Modbus RTU sobre RS485 para SU900-30R0G3
 * Protocolo: Modbus-RTU estándar, FC 0x03 (leer) / 0x06 (escribir)
 */

'use strict';

const ModbusRTU = require('modbus-serial');
const logger    = require('./logger');

class ModbusRTUTransport {
  constructor(config = {}) {
    this.config = {
      port:      config.port      || process.env.RTU_PORT      || '/dev/ttyUSB0',
      baudRate:  config.baudRate  || parseInt(process.env.RTU_BAUDRATE) || 9600,
      parity:    config.parity    || process.env.RTU_PARITY    || 'none',
      dataBits:  config.dataBits  || parseInt(process.env.RTU_DATABITS)  || 8,
      stopBits:  config.stopBits  || parseInt(process.env.RTU_STOPBITS)  || 2,
      slaveId:   config.slaveId   || parseInt(process.env.RTU_SLAVE_ID)  || 1,
      timeout:   config.timeout   || parseInt(process.env.MODBUS_TIMEOUT) || 1000,
      retries:   config.retries   || parseInt(process.env.MODBUS_RETRIES) || 3,
    };

    this.client    = new ModbusRTU();
    this.connected = false;
    this.type      = 'RTU';
  }

  /** Abre el puerto serial y establece la conexión */
  async connect() {
    try {
      await this.client.connectRTUBuffered(this.config.port, {
        baudRate: this.config.baudRate,
        parity:   this.config.parity,
        dataBits: this.config.dataBits,
        stopBits: this.config.stopBits,
      });

      this.client.setID(this.config.slaveId);
      this.client.setTimeout(this.config.timeout);
      this.connected = true;

      logger.info(`[RTU] Conectado → ${this.config.port} @ ${this.config.baudRate} bps, esclavo ID=${this.config.slaveId}`);
      return { ok: true, message: `Conectado a ${this.config.port}` };
    } catch (err) {
      this.connected = false;
      logger.error(`[RTU] Error de conexión: ${err.message}`);
      throw err;
    }
  }

  /** Cierra el puerto serial */
  async disconnect() {
    if (this.connected) {
      this.client.close(() => {});
      this.connected = false;
      logger.info('[RTU] Desconectado.');
    }
    return { ok: true };
  }

  /**
   * Lee N registros holding (FC=0x03)
   * @param {number} address  Dirección de inicio (decimal)
   * @param {number} length   Cantidad de registros a leer (máx. 12 por grupo según manual)
   */
  async readRegisters(address, length = 1) {
    this._assertConnected();
    return this._withRetry(async () => {
      const result = await this.client.readHoldingRegisters(address, length);
      logger.debug(`[RTU] FC=0x03 │ addr=0x${address.toString(16).padStart(4,'0')} │ len=${length} │ data=[${result.data}]`);
      return result.data;
    });
  }

  /**
   * Escribe un registro (FC=0x06) – Single Register Write
   * @param {number} address  Dirección del registro
   * @param {number} value    Valor a escribir (entero 16-bit)
   */
  async writeRegister(address, value) {
    this._assertConnected();
    return this._withRetry(async () => {
      await this.client.writeRegister(address, value);
      logger.debug(`[RTU] FC=0x06 │ addr=0x${address.toString(16).padStart(4,'0')} │ val=${value}`);
      return { ok: true, address, value };
    });
  }

  /**
   * Escribe múltiples registros (FC=0x10)
   * @param {number}   address  Dirección de inicio
   * @param {number[]} values   Array de valores
   */
  async writeMultipleRegisters(address, values) {
    this._assertConnected();
    return this._withRetry(async () => {
      await this.client.writeRegisters(address, values);
      logger.debug(`[RTU] FC=0x10 │ addr=0x${address.toString(16).padStart(4,'0')} │ count=${values.length}`);
      return { ok: true, address, count: values.length };
    });
  }

  // ─── internos ──────────────────────────────────────────────────

  _assertConnected() {
    if (!this.connected) throw new Error('Modbus RTU no conectado. Llamá a connect() primero.');
  }

  async _withRetry(fn) {
    let lastErr;
    for (let i = 0; i < this.config.retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        logger.warn(`[RTU] Reintento ${i + 1}/${this.config.retries}: ${err.message}`);
        await new Promise(r => setTimeout(r, 200 * (i + 1)));
      }
    }
    throw lastErr;
  }

  getStatus() {
    return {
      connected: this.connected,
      type:      this.type,
      config: {
        port:     this.config.port,
        baudRate: this.config.baudRate,
        parity:   this.config.parity,
        stopBits: this.config.stopBits,
        slaveId:  this.config.slaveId,
      },
    };
  }
}

module.exports = ModbusRTUTransport;