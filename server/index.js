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
const fs       = require('fs');
const logger   = require('../modules/logger');

const DeviceController = require('../modules/device-controller');
const ModbusRTUTransport = require('../modules/modbus-rtu');
const ModbusTCPTransport = require('../modules/modbus-tcp');
const { parseProfile, loadProfileById, listProfiles, saveProfile } = require('../modules/device-profile');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

/* ══════════════════════════════════════════════════════
   AUTENTICACIÓN HTTP Basic
   ══════════════════════════════════════════════════════ */

// Estado en memoria — se carga desde .env al arrancar
const authState = {
  enabled:  process.env.AUTH_ENABLED === 'true',
  username: process.env.AUTH_USERNAME || '',
  password: process.env.AUTH_PASSWORD || '',
};

logger.info(`[Auth] ${authState.enabled
  ? `ACTIVA — usuario: ${authState.username}`
  : 'DESACTIVADA'}`);

// Persiste el estado de auth de vuelta en el archivo .env
function authPersist() {
  const envPath = path.join(__dirname, '..', '.env');
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

    const set = (key, value) => {
      const re = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      content = re.test(content) ? content.replace(re, line) : content + `\n${line}`;
    };

    set('AUTH_ENABLED',  authState.enabled  ? 'true' : 'false');
    set('AUTH_USERNAME', authState.username);
    set('AUTH_PASSWORD', authState.password);

    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err) {
    logger.error(`[Auth] No se pudo persistir .env: ${err.message}`);
  }
}

// Verifica credenciales de la petición entrante.
// Retorna true si la petición está autorizada.
function authCheck(req) {
  if (!authState.enabled) return true;
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const [user, ...rest] = decoded.split(':');
  const pass = rest.join(':');   // contraseñas con ":" son válidas
  return user === authState.username && pass === authState.password;
}

// Middleware que aplica la verificación a las rutas protegidas
function requireAuth(req, res, next) {
  if (!authCheck(req)) {
    res.set('WWW-Authenticate', 'Basic realm="SU900 Configurador"');
    return res.status(401).json({ error: 'No autorizado. Ingresá las credenciales en Seguridad / Auth.' });
  }
  next();
}

/* ─── Middleware ─────────────────────────────────────────────────────────── */
app.use(cors());
app.use(express.json());

// Servir la UI estática desde la raíz del proyecto
app.use(express.static(path.join(__dirname, '..')));
console.log('Sirviendo estáticos desde:', path.join(__dirname, '..'));

/* ══════════════════════════════════════════════════════
   PERFILES DE DISPOSITIVO
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/device-profiles
 * Lista todos los perfiles disponibles en profiles/.
 */
app.get('/api/device-profiles', requireAuth, (req, res) => {
  try {
    res.json({ profiles: listProfiles() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rutas específicas primero — deben preceder a las rutas con :id para que
// Express no capture "assign" o "active" como valor del parámetro :id.

/**
 * POST /api/device-profiles/assign
 * Asigna un perfil de dispositivo a un variador conectado.
 * Body: { deviceId: string, profileId: string }
 */
app.post('/api/device-profiles/assign', requireAuth, async (req, res) => {
  const { deviceId, profileId } = req.body;
  if (!deviceId || !profileId)
    return res.status(400).json({ error: 'Body debe incluir { deviceId, profileId }' });

  const dev = devices.get(deviceId);
  if (!dev) return res.status(404).json({ error: `Dispositivo ${deviceId} no encontrado.` });

  try {
    const profile   = loadProfileById(profileId);
    dev.controller  = new DeviceController(dev.transport, profile);
    dev.profileId   = profileId;
    dev.profileName = profile.name;
    logger.info(`[Profiles] Perfil "${profileId}" asignado a dispositivo ${deviceId}`);
    res.json({ ok: true, deviceId, profileId, profileName: profile.name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/device-profiles/active/:deviceId
 * Retorna el perfil actualmente cargado en un dispositivo.
 */
app.get('/api/device-profiles/active/:deviceId', requireAuth, (req, res) => {
  const dev = devices.get(req.params.deviceId);
  if (!dev) return res.status(404).json({ error: `Dispositivo ${req.params.deviceId} no encontrado.` });
  res.json(dev.controller.getProfileInfo());
});

// Rutas genéricas con :id — deben ir DESPUÉS de las rutas específicas.

/**
 * GET /api/device-profiles/:id
 * Retorna el contenido completo de un perfil por su id.
 */
app.get('/api/device-profiles/:id', requireAuth, (req, res) => {
  try {
    const profile = loadProfileById(req.params.id);
    const { _paramIndex, ...clean } = profile;
    res.json(clean);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /api/device-profiles
 * Sube y guarda un nuevo perfil JSON.
 * Body: el objeto JSON del perfil completo.
 */
app.post('/api/device-profiles', requireAuth, (req, res) => {
  try {
    const profile  = parseProfile(req.body);
    const filePath = saveProfile(profile);
    logger.info(`[Profiles] Perfil guardado: ${profile.id} → ${filePath}`);
    res.json({ ok: true, id: profile.id, name: profile.name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/device-profiles/:id
 * Elimina un perfil del directorio profiles/.
 */
app.delete('/api/device-profiles/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const filePath = path.join(__dirname, '..', 'profiles', `${id}.json`);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: `Perfil "${id}" no encontrado.` });
  fs.unlinkSync(filePath);
  logger.info(`[Profiles] Perfil eliminado: ${id}`);
  res.json({ ok: true, id });
});

/* ══════════════════════════════════════════════════════
   GESTIÓN DE MÚLTIPLES DISPOSITIVOS
   ══════════════════════════════════════════════════════ */

/**
 * Cada entrada del Map representa un variador conectado:
 *   devices.get(id) → { transport, controller, cfg, id, label }
 *
 * El bus RS-485 es half-duplex: solo un maestro puede hablar a la vez.
 * busMutex serializa todas las operaciones Modbus independientemente del
 * dispositivo destino — evita colisiones cuando dos peticiones HTTP
 * concurrentes intentan acceder al bus simultáneamente.
 */
const devices = new Map();   // id (string) → { transport, controller, cfg, label }
let   busLock = false;       // mutex simple: true = bus ocupado
const busQueue = [];         // cola de funciones esperando el bus

// Adquiere el mutex del bus y ejecuta fn(); libera al terminar.
// Garantiza que nunca haya dos operaciones Modbus simultáneas.
async function withBus(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      busLock = true;
      try   { resolve(await fn()); }
      catch (err) { reject(err); }
      finally {
        busLock = false;
        if (busQueue.length) busQueue.shift()();
      }
    };
    if (!busLock) task();
    else busQueue.push(task);
  });
}

// Genera un ID único para cada dispositivo
let _nextId = 1;
function nextDeviceId() { return String(_nextId++); }

// Middleware: verifica que el dispositivo pedido exista y está conectado.
// Espera ?deviceId=N o header X-Device-Id. Si no se especifica usa el
// primer dispositivo conectado (retrocompatibilidad con sesión de 1 variador).
function requireDevice(req, res, next) {
  const id = req.query.deviceId || req.headers['x-device-id'];
  if (id) {
    const dev = devices.get(id);
    if (!dev) return res.status(404).json({ error: `Dispositivo ${id} no encontrado.` });
    req.device = dev;
  } else {
    // Sin ID → usar el primero disponible
    const first = [...devices.values()][0];
    if (!first) return res.status(400).json({ error: 'No hay dispositivos conectados. POST /api/devices primero.' });
    req.device = first;
  }
  next();
}

// Alias de compatibilidad — algunos endpoints internos solo necesitan saber
// si existe al menos un dispositivo
function requireConnection(req, res, next) { return requireDevice(req, res, next); }

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE AUTENTICACIÓN
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/auth-status
 * Devuelve si la autenticación está activa y el usuario configurado.
 * No requiere auth para que la UI pueda consultarlo sin credenciales.
 */
app.get('/api/auth-status', (req, res) => {
  res.json({
    authEnabled: authState.enabled,
    username:    authState.enabled ? authState.username : undefined,
  });
});

/**
 * POST /api/auth-config
 * Activa/desactiva la autenticación y guarda las credenciales.
 * Body: { enabled: bool, username?: string, password?: string }
 * Requiere auth solo si ya hay credenciales activas (para no bloquearse).
 */
app.post('/api/auth-config', (req, res) => {
  // Si ya hay auth activa, verificar credenciales antes de cambiarlas
  if (authState.enabled && !authCheck(req)) {
    res.set('WWW-Authenticate', 'Basic realm="SU900 Configurador"');
    return res.status(401).json({ error: 'No autorizado.' });
  }

  const { enabled, username, password } = req.body;

  if (enabled) {
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(400).json({ error: 'El campo username no puede estar vacío.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }
    authState.enabled  = true;
    authState.username = username.trim();
    authState.password = password;
    logger.info(`[Auth] Activada — usuario: ${authState.username}`);
  } else {
    authState.enabled  = false;
    authState.username = '';
    authState.password = '';
    logger.info('[Auth] Desactivada.');
  }

  authPersist();
  res.json({ ok: true, authEnabled: authState.enabled });
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE DISPOSITIVOS (multi-variador)
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/devices
 * Lista todos los dispositivos conectados.
 */
app.get('/api/devices', requireAuth, (req, res) => {
  const list = [...devices.values()].map(d => ({
    id:        d.id,
    label:     d.label,
    connected: true,
    ...d.transport.getStatus(),
    ...d.cfg,
  }));
  res.json({ devices: list, count: list.length });
});

/**
 * POST /api/devices
 * Conecta un nuevo dispositivo al bus.
 * Body: { type: 'rtu'|'tcp', label?: string, ...transportConfig }
 * Retorna: { id, label, message, type }
 */
app.post('/api/devices', requireAuth, async (req, res) => {
  const { type, label, ...config } = req.body;

  let transport;
  try {
    transport = type === 'tcp'
      ? new ModbusTCPTransport(config)
      : new ModbusRTUTransport(config);

    const result = await transport.connect();
    const id     = nextDeviceId();
    const slaveId = config.slaveId || config.unitId || 1;
    const devLabel = label ||
      (type === 'tcp'
        ? `TCP ${config.host}:${config.port || 502} ID:${slaveId}`
        : `RTU ${config.port} ID:${slaveId}`);

    const controller = new DeviceController(transport);
    devices.set(id, { id, label: devLabel, transport, controller, cfg: { type, ...config } });

    logger.info(`[Devices] Conectado: id=${id} label="${devLabel}"`);
    res.json({ ok: true, id, label: devLabel, message: result.message, type: transport.type });
  } catch (err) {
    if (transport) { try { await transport.disconnect(); } catch (_) {} }
    logger.error(`[Devices] Error conectando: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/devices/:id
 * Desconecta y elimina un dispositivo.
 */
app.delete('/api/devices/:id', requireAuth, async (req, res) => {
  const dev = devices.get(req.params.id);
  if (!dev) return res.status(404).json({ error: `Dispositivo ${req.params.id} no encontrado.` });

  try { await dev.transport.disconnect(); } catch (_) {}
  devices.delete(req.params.id);
  logger.info(`[Devices] Desconectado: id=${req.params.id} label="${dev.label}"`);
  res.json({ ok: true, id: req.params.id });
});

/**
 * PATCH /api/devices/:id
 * Actualiza la etiqueta de un dispositivo.
 * Body: { label: string }
 */
app.patch('/api/devices/:id', requireAuth, (req, res) => {
  const dev = devices.get(req.params.id);
  if (!dev) return res.status(404).json({ error: `Dispositivo ${req.params.id} no encontrado.` });
  if (req.body.label) dev.label = req.body.label;
  res.json({ ok: true, id: req.params.id, label: dev.label });
});

/* ── Endpoints legacy de conexión (compatibilidad con sesión de 1 variador) ── */

/**
 * POST /api/connect  — conecta un dispositivo (wrapper de POST /api/devices)
 * Body: { type: 'rtu'|'tcp', ...config }
 */
app.post('/api/connect', requireAuth, async (req, res) => {
  const { type, ...config } = req.body;

  // Si ya hay exactamente UN dispositivo del mismo tipo y config, desconectarlo
  // para evitar duplicados al reconectar desde el panel de Conexión.
  if (devices.size === 1) {
    const [onlyDev] = [...devices.values()];
    if (onlyDev.cfg.type === type) {
      try { await onlyDev.transport.disconnect(); } catch (_) {}
      devices.delete(onlyDev.id);
    }
  }

  let transport;
  try {
    transport = type === 'tcp'
      ? new ModbusTCPTransport(config)
      : new ModbusRTUTransport(config);

    const result     = await transport.connect();
    const id         = nextDeviceId();
    const slaveId    = config.slaveId || config.unitId || 1;
    const label      = type === 'tcp'
      ? `TCP ${config.host}:${config.port || 502} ID:${slaveId}`
      : `RTU ${config.port} ID:${slaveId}`;
    const controller = new DeviceController(transport);
    devices.set(id, { id, label, transport, controller, cfg: { type, ...config } });

    logger.info(`[API] Conexión establecida: id=${id} ${type.toUpperCase()}`);
    res.json({ ok: true, id, message: result.message, type: transport.type, connected: true });
  } catch (err) {
    if (transport) { try { await transport.disconnect(); } catch (_) {} }
    logger.error(`[API] Error en connect: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/disconnect  — desconecta todos los dispositivos
 */
app.post('/api/disconnect', requireAuth, async (req, res) => {
  for (const dev of devices.values()) {
    try { await dev.transport.disconnect(); } catch (_) {}
  }
  devices.clear();
  res.json({ ok: true });
});

/**
 * GET /api/status-conn
 * Retorna el estado del primer dispositivo conectado (compatibilidad con polling de la UI).
 */
app.get('/api/status-conn', (req, res) => {
  if (devices.size === 0) return res.json({ connected: false });
  const first = [...devices.values()][0];
  res.json({
    connected: true,
    deviceCount: devices.size,
    ...first.transport.getStatus(),
    ...first.cfg,
  });
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE PARÁMETROS
   Todos aceptan ?deviceId=N para elegir el variador.
   Sin deviceId usan el primer dispositivo conectado.
   ══════════════════════════════════════════════════════ */

app.get('/api/param/:code', requireAuth, requireDevice, async (req, res) => {
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.readParam(req.params.code));
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    logger.warn(`[API] readParam ${req.params.code}: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/param/:code', requireAuth, requireDevice, async (req, res) => {
  const { value } = req.body;
  if (value === undefined || isNaN(value))
    return res.status(400).json({ error: 'Body debe incluir { value: number }' });
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.writeParam(req.params.code, parseFloat(value)));
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    logger.warn(`[API] writeParam ${req.params.code}: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/group/:group', requireAuth, requireDevice, async (req, res) => {
  const { controller } = req.device;
  try {
    const results = await withBus(() => controller.readGroup(req.params.group));
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/params/write-multiple', requireAuth, requireDevice, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items))
    return res.status(400).json({ error: 'Body debe incluir { items: [{code, value}] }' });
  const { controller } = req.device;
  try {
    const results = await withBus(() => controller.writeMultipleParams(items));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE CONTROL
   ══════════════════════════════════════════════════════ */

app.get('/api/status', requireAuth, requireDevice, async (req, res) => {
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.readRunStatus());
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/command', requireAuth, requireDevice, async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Body debe incluir { command }' });
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.sendCommand(command));
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/frequency', requireAuth, requireDevice, async (req, res) => {
  const { freqHz, maxFreq = 50 } = req.body;
  if (freqHz === undefined) return res.status(400).json({ error: 'Body debe incluir { freqHz }' });
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.setFrequency(parseFloat(freqHz), parseFloat(maxFreq)));
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/digital-outputs', requireAuth, requireDevice, async (req, res) => {
  const { bits } = req.body;
  if (!bits) return res.status(400).json({ error: 'Body debe incluir { bits }' });
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.setDigitalOutputs(bits));
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/analog-output', requireAuth, requireDevice, async (req, res) => {
  const { channel, percent } = req.body;
  if (!channel || percent === undefined)
    return res.status(400).json({ error: 'Body debe incluir { channel, percent }' });
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.setAnalogOutput(channel, parseFloat(percent)));
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE MONITOREO
   ══════════════════════════════════════════════════════ */

app.get('/api/monitor', requireAuth, requireDevice, async (req, res) => {
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.readMonitor());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE FALLAS
   ══════════════════════════════════════════════════════ */

app.get('/api/fault', requireAuth, requireDevice, async (req, res) => {
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.readFaultCode());
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fault-history', requireAuth, requireDevice, async (req, res) => {
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.readFaultHistory());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fault-reset', requireAuth, requireDevice, async (req, res) => {
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.resetFault());
    res.json({ ...result, deviceId: req.device.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINTS DE PERFILES
   ══════════════════════════════════════════════════════ */

app.get('/api/profile/read', requireAuth, requireDevice, async (req, res) => {
  const { controller } = req.device;
  try {
    const profile = await withBus(() => controller.readFullProfile());
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profile/write', requireAuth, requireDevice, async (req, res) => {
  const { profile } = req.body;
  if (!profile) return res.status(400).json({ error: 'Body debe incluir { profile }' });
  const { controller } = req.device;
  try {
    const result = await withBus(() => controller.writeFullProfile(profile));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════
   ENDPOINT DE DETECCIÓN ESP32
   ══════════════════════════════════════════════════════ */

/**
 * GET /api/probe-esp32?ip=192.168.1.x
 * Proxy de escaneo: el browser no puede hacer fetch a IPs locales por CORS.
 */
app.get('/api/probe-esp32', (req, res) => {
  const { ip } = req.query;
  if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return res.status(400).json({ error: 'IP inválida' });
  }

  const http2 = require('http');
  let responded = false;

  function reply(data) {
    if (responded) return;
    responded = true;
    res.json(data);
  }

  const probeReq = http2.request(
    { hostname: ip, port: 80, path: '/', method: 'GET', timeout: 600 },
    (probeRes) => {
      const server = probeRes.headers['server'] || 'HTTP OK';
      reply({ found: true, info: server });
      probeRes.destroy();
    }
  );

  probeReq.on('timeout', () => { probeReq.destroy(); reply({ found: false }); });
  probeReq.on('error',   () => { reply({ found: false }); });
  probeReq.end();
});

/**
 * GET /api/serial-ports
 * Lista los puertos seriales disponibles en el sistema (adaptadores USB-RS485, etc.).
 * Retorna: { ports: [{ path, manufacturer, vendorId, productId, friendlyName }] }
 * No requiere conexión activa ni auth — es solo una consulta al SO.
 */
app.get('/api/serial-ports', async (req, res) => {
  try {
    const { SerialPort } = require('serialport');
    const raw = await SerialPort.list();

    // Tabla de VID:PID comunes para adaptadores RS-485/RS-232
    const KNOWN = {
      '0403:6001': 'FTDI FT232',
      '0403:6015': 'FTDI FT231X',
      '0403:6010': 'FTDI FT2232',
      '0403:6011': 'FTDI FT4232',
      '10c4:ea60': 'Silicon Labs CP210x',
      '10c4:ea70': 'Silicon Labs CP2105',
      '1a86:7523': 'WCH CH340',
      '1a86:55d4': 'WCH CH9102',
      '067b:2303': 'Prolific PL2303',
      '2341:0043': 'Arduino Uno',
      '2341:0001': 'Arduino Mega',
    };

    const ports = raw.map(p => {
      const vid = (p.vendorId  || '').toLowerCase().padStart(4, '0');
      const pid = (p.productId || '').toLowerCase().padStart(4, '0');
      const key = `${vid}:${pid}`;
      const known = KNOWN[key] || null;
      return {
        path:         p.path,
        manufacturer: p.manufacturer || null,
        vendorId:     p.vendorId     || null,
        productId:    p.productId    || null,
        serialNumber: p.serialNumber || null,
        friendlyName: known || p.friendlyName || p.manufacturer || p.path,
      };
    });

    logger.debug(`[SerialPorts] ${ports.length} puerto(s) encontrado(s)`);
    res.json({ ports });
  } catch (err) {
    logger.error(`[SerialPorts] Error listando puertos: ${err.message}`);
    res.status(500).json({ error: err.message, ports: [] });
  }
});

/**
 * GET /favicon.ico — evitar 404 en el log del servidor
 */
app.get('/favicon.ico', (req, res) => res.status(204).end());

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