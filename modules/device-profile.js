'use strict';

const fs   = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

/**
 * Carga y valida un perfil de dispositivo desde un objeto JSON.
 * Retorna el perfil normalizado (con direcciones parseadas a número) o lanza Error.
 */
function parseProfile(raw) {
  if (!raw || typeof raw !== 'object')
    throw new Error('Perfil inválido: debe ser un objeto JSON.');
  if (raw['$schema'] !== 'suswe-device-profile/v1')
    throw new Error('Perfil inválido: $schema debe ser "suswe-device-profile/v1".');
  if (!raw.id || !raw.name)
    throw new Error('Perfil inválido: faltan campos obligatorios id y name.');
  if (!Array.isArray(raw.groups) || raw.groups.length === 0)
    throw new Error('Perfil inválido: groups debe ser un array no vacío.');

  // Parsear todas las direcciones hexadecimales a número
  const parseAddr = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseInt(v, 16);
    throw new Error(`Dirección inválida: ${v}`);
  };

  const profile = JSON.parse(JSON.stringify(raw));  // deep copy

  // Normalizar registros de control
  if (profile.controlRegisters) {
    for (const [key, reg] of Object.entries(profile.controlRegisters)) {
      reg.addrNum = parseAddr(reg.addr);
    }
  }

  // Normalizar monitorBlock
  if (profile.monitorBlock) {
    profile.monitorBlock.startAddrNum = parseAddr(profile.monitorBlock.startAddr);
    for (const reg of profile.monitorBlock.registers || []) {
      reg.addrNum = profile.monitorBlock.startAddrNum + reg.offset;
    }
  }

  // Normalizar faultHistoryAddrs
  if (Array.isArray(profile.faultHistoryAddrs)) {
    profile.faultHistoryAddrsNum = profile.faultHistoryAddrs.map(parseAddr);
  }

  // Normalizar faultMap con claves numéricas
  if (profile.faultMap) {
    profile.faultMapNum = {};
    for (const [k, v] of Object.entries(profile.faultMap)) {
      profile.faultMapNum[parseInt(k, 16)] = v;
    }
  }

  // Normalizar grupos y parámetros
  profile._paramIndex = {};  // code → param normalizado
  for (const group of profile.groups) {
    if (!group.id || !Array.isArray(group.params))
      throw new Error(`Grupo inválido: ${JSON.stringify(group)}`);
    for (const param of group.params) {
      if (!param.code || param.addr === undefined)
        throw new Error(`Parámetro inválido en grupo ${group.id}: ${JSON.stringify(param)}`);
      param.addrNum = parseAddr(param.addr);
      if (param.scale === undefined) param.scale = 1;
      if (param.rw     === undefined) param.rw    = true;
      profile._paramIndex[param.code] = { ...param, groupId: group.id };
    }
  }

  return profile;
}

/**
 * Carga un perfil desde el directorio profiles/ por su id.
 */
function loadProfileById(id) {
  const filePath = path.join(PROFILES_DIR, `${id}.json`);
  if (!fs.existsSync(filePath))
    throw new Error(`Perfil "${id}" no encontrado en ${PROFILES_DIR}`);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return parseProfile(raw);
}

/**
 * Lista todos los perfiles disponibles en el directorio profiles/.
 */
function listProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs.readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
        return { id: raw.id, name: raw.name, description: raw.description || '', file: f };
      } catch (_) { return null; }
    })
    .filter(Boolean);
}

/**
 * Guarda un perfil en el directorio profiles/.
 * El nombre del archivo es `${profile.id}.json`.
 */
function saveProfile(profile) {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const filePath = path.join(PROFILES_DIR, `${profile.id}.json`);
  const { _paramIndex, ...toSave } = profile;  // no persistir el índice interno
  fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf8');
  return filePath;
}

module.exports = { parseProfile, loadProfileById, listProfiles, saveProfile };
