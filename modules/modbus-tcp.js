/**
 * modules/modbus-tcp.js
 * Transporte Modbus TCP/IP para SU900-30R0G3
 * Útil cuando se usa una pasarela RS485→TCP (ej: USR-N510, Elfin-EE11)
 */

'use strict';

const ModbusRTU = require('modbus-serial');
const logger    = require('./logger');

class ModbusTCPTransport {
  constructor(config = {}) {
    this.config = {
      host:    config.host    || process.env.TCP_HOST    || '192.168.1.100',
      port:    config.port    || parseInt(process.env.TCP_PORT)    || 502,
      unitId:  config.unitId  || parseInt(process.env.TCP_UNIT_ID) || 1,
      timeout: config.timeout || parseInt(process.env.MODBUS_TIMEOUT) || 1000,
      retries: config.retries || parseInt(process.env.MODBUS_RETRIES) || 3,
    };

    this.client    = new ModbusRTU();
    this.connected = false;
    this.type      = 'TCP';
  }

  async connect() {
    try {
      await this.client.connectTCP(this.config.host, { port: this.config.port });
      this.client.setID(this.config.unitId);
      this.client.setTimeout(this.config.timeout);
      this.connected = true;

      logger.info(`[TCP] Conectado → ${this.config.host}:${this.config.port}, unit ID=${this.config.unitId}`);
      return { ok: true, message: `Conectado a ${this.config.host}:${this.config.port}` };
    } catch (err) {
      this.connected = false;
      logger.error(`[TCP] Error de conexión: ${err.message}`);
      throw err;
    }
  }

  async disconnect() {
    if (this.connected) {
      this.client.close(() => {});
      this.connected = false;
      logger.info('[TCP] Desconectado.');
    }
    return { ok: true };
  }

  async readRegisters(address, length = 1) {
    this._assertConnected();
    return this._withRetry(async () => {
      const result = await this.client.readHoldingRegisters(address, length);
      logger.debug(`[TCP] FC=0x03 │ addr=0x${address.toString(16).padStart(4,'0')} │ len=${length} │ data=[${result.data}]`);
      return result.data;
    });
  }

  async writeRegister(address, value) {
    this._assertConnected();
    return this._withRetry(async () => {
      await this.client.writeRegister(address, value);
      logger.debug(`[TCP] FC=0x06 │ addr=0x${address.toString(16).padStart(4,'0')} │ val=${value}`);
      return { ok: true, address, value };
    });
  }

  async writeMultipleRegisters(address, values) {
    this._assertConnected();
    return this._withRetry(async () => {
      await this.client.writeRegisters(address, values);
      logger.debug(`[TCP] FC=0x10 │ addr=0x${address.toString(16).padStart(4,'0')} │ count=${values.length}`);
      return { ok: true, address, count: values.length };
    });
  }

  _assertConnected() {
    if (!this.connected) throw new Error('Modbus TCP no conectado. Llamá a connect() primero.');
  }

  async _withRetry(fn) {
    let lastErr;
    for (let i = 0; i < this.config.retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        logger.warn(`[TCP] Reintento ${i + 1}/${this.config.retries}: ${err.message}`);
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
        host:   this.config.host,
        port:   this.config.port,
        unitId: this.config.unitId,
      },
    };
  }
}

module.exports = ModbusTCPTransport;