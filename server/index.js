/**
 * server/index.js
 * Servidor Express — API REST para el configurador SUSWE SU800/900
 *
 * Expone endpoints que la UI HTML consume via fetch().
 * Usa DeviceController + transporte RTU o TCP según configuración.
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const path     = require('path');
const logger   = require('../modules/logger');

const DeviceController      = require('../modules/device-controller');
const ModbusRTUTransport    = require('../modules/modbus-rtu');
const ModbusTCPTransport    = require('../modules/modbus-tcp');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

/* ─── Middleware ─────────────────────────────────────────────────────────── */
app.use(cors());
app.use(express.json());

// Servir la UI estática desde la raíz del proyecto
app.use(express.static(path.join(__dirname, '..')));

/* ─── Estado global de la conexión ──────────────────────────────────────── */
let transport  = null;
let controller = null;

function requireConnection(req, res, next) {
  if (!transport || !controller) {
    return res.status(400).json({ error: 'No hay conexión activa. POST /api/connect primero.' });
  }
  next();
}

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE CONEXIÓN
   ══════════════════════════════════════════════════════ */

/**
 * POST /api/connect
 * Body: { type: 'rtu'|'tcp', ...config }
 */
app.post('/api/connect', async (req, res) => {
  // Desconectar si ya había una conexión previa
  if (transport) {
    try { await transport.disconnect(); } catch (_) {}
    transport = null; controller = null;
  }

  const { type, ...config } = req.body;

  try {
    if (type === 'tcp') {
      transport = new ModbusTCPTransport(config);
    } else {
      transport = new ModbusRTUTransport(config);
    }

    const result = await transport.connect();
    controller   = new DeviceController(transport);

    logger.info(`[API] Conexión establecida: ${type.toUpperCase()}`);
    res.json({ ok: true, message: result.message, type: transport.type });
  } catch (err) {
    transport = null; controller = null;
    logger.error(`[API] Error en connect: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/disconnect
 */
app.post('/api/disconnect', async (req, res) => {
  if (transport) {
    try { await transport.disconnect(); } catch (_) {}
    transport  = null;
    controller = null;
  }
  res.json({ ok: true });
});

/**
 * GET /api/status-conn
 * Estado de la conexión (sin leer el variador)
 */
app.get('/api/status-conn', (req, res) => {
  if (!transport) return res.json({ connected: false });
  res.json({ connected: true, ...transport.getStatus() });
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE PARÁMETROS
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/param/:code
 * Lee un parámetro por código (ej: P0-08)
 */
app.get('/api/param/:code', requireConnection, async (req, res) => {
  try {
    const result = await controller.readParam(req.params.code);
    res.json(result);
  } catch (err) {
    logger.warn(`[API] readParam ${req.params.code}: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /api/param/:code
 * Escribe un parámetro
 * Body: { value: number }
 */
app.put('/api/param/:code', requireConnection, async (req, res) => {
  const { value } = req.body;
  if (value === undefined || isNaN(value)) {
    return res.status(400).json({ error: 'Body debe incluir { value: number }' });
  }
  try {
    const result = await controller.writeParam(req.params.code, parseFloat(value));
    res.json(result);
  } catch (err) {
    logger.warn(`[API] writeParam ${req.params.code}: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/group/:group
 * Lee todos los parámetros de un grupo (P0, P1, PD, etc.)
 */
app.get('/api/group/:group', requireConnection, async (req, res) => {
  try {
    const results = await controller.readGroup(req.params.group);
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/params/write-multiple
 * Escribe múltiples parámetros de una vez
 * Body: { items: [{ code, value }, ...] }
 */
app.post('/api/params/write-multiple', requireConnection, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Body debe incluir { items: [{code, value}] }' });
  }
  try {
    const results = await controller.writeMultipleParams(items);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE CONTROL
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/status
 * Lee el estado de funcionamiento (0x3000)
 */
app.get('/api/status', requireConnection, async (req, res) => {
  try {
    const result = await controller.readRunStatus();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/command
 * Envía un comando de control (0x2000)
 * Body: { command: 'RUN_FORWARD' | 'RUN_REVERSE' | ... }
 */
app.post('/api/command', requireConnection, async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Body debe incluir { command }' });
  try {
    const result = await controller.sendCommand(command);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/frequency
 * Establece la consigna de frecuencia (0x1000)
 * Body: { freqHz: number, maxFreq?: number }
 */
app.post('/api/frequency', requireConnection, async (req, res) => {
  const { freqHz, maxFreq = 50 } = req.body;
  if (freqHz === undefined) return res.status(400).json({ error: 'Body debe incluir { freqHz }' });
  try {
    const result = await controller.setFrequency(parseFloat(freqHz), parseFloat(maxFreq));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/digital-outputs
 * Controla salidas DO (0x2001)
 * Body: { bits: { DO1: bool, DO2: bool, RELAY1: bool, ... } }
 */
app.post('/api/digital-outputs', requireConnection, async (req, res) => {
  const { bits } = req.body;
  if (!bits) return res.status(400).json({ error: 'Body debe incluir { bits }' });
  try {
    const result = await controller.setDigitalOutputs(bits);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/analog-output
 * Controla salida AO (0x2002~0x2004)
 * Body: { channel: 'AO1'|'AO2'|'FMP', percent: number }
 */
app.post('/api/analog-output', requireConnection, async (req, res) => {
  const { channel, percent } = req.body;
  if (!channel || percent === undefined)
    return res.status(400).json({ error: 'Body debe incluir { channel, percent }' });
  try {
    const result = await controller.setAnalogOutput(channel, parseFloat(percent));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE MONITOREO
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/monitor
 * Lee todos los registros U0 de una vez (bloque 0x1001~0x1020)
 */
app.get('/api/monitor', requireConnection, async (req, res) => {
  try {
    const result = await controller.readMonitor();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE FALLAS
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/fault
 * Lee la falla activa (0x8000)
 */
app.get('/api/fault', requireConnection, async (req, res) => {
  try {
    const result = await controller.readFaultCode();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/fault-history
 * Lee el historial de fallas (P9-14, P9-15, P9-16)
 */
app.get('/api/fault-history', requireConnection, async (req, res) => {
  try {
    const result = await controller.readFaultHistory();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/fault-reset
 * Alias conveniente para resetear fallas
 */
app.post('/api/fault-reset', requireConnection, async (req, res) => {
  try {
    const result = await controller.resetFault();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE PERFILES
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/profile/read
 * Lee el perfil completo del variador (todos los grupos)
 */
app.get('/api/profile/read', requireConnection, async (req, res) => {
  try {
    const profile = await controller.readFullProfile();
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/profile/write
 * Escribe un perfil completo al variador
 * Body: { profile: { groups: { P0: [...], P1: [...], ... } } }
 */
app.post('/api/profile/write', requireConnection, async (req, res) => {
  const { profile } = req.body;
  if (!profile) return res.status(400).json({ error: 'Body debe incluir { profile }' });
  try {
    const result = await controller.writeFullProfile(profile);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Manejo de errores global ───────────────────────────────────────────── */
app.use((err, req, res, _next) => {
  logger.error(`[API] Unhandled error: ${err.message}`);
  res.status(500).json({ error: err.message });
});

/* ─── Start ──────────────────────────────────────────────────────────────── */
server.listen(PORT, () => {
  logger.info(`═══════════════════════════════════════════════`);
  logger.info(` SUSWE SU800/900 — Servidor Modbus`);
  logger.info(` Puerto: http://localhost:${PORT}`);
  logger.info(` UI:     http://localhost:${PORT}/suswe_su900_configurator.html`);
  logger.info(`═══════════════════════════════════════════════`);
});

module.exports = { app, server };