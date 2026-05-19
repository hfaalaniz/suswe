/*
 * ============================================================
 *  SUSWE SU800/SU900 — Pasarela ESP32 WiFi ↔ Modbus RTU
 *  Firmware completo listo para copiar y subir
 * ============================================================
 *
 *  HARDWARE:
 *    ESP32 + módulo MAX485 (o similar RS-485)
 *
 *  CONEXIONES:
 *    Variador A+  → MAX485 A
 *    Variador B−  → MAX485 B
 *    MAX485 RO    → GPIO 16 (RX2 del ESP32)
 *    MAX485 DI    → GPIO 17 (TX2 del ESP32)
 *    MAX485 DE+RE → GPIO  4 (control de dirección)
 *    MAX485 VCC   → 3.3V (o 5V si el módulo lo permite)
 *    MAX485 GND   → GND
 *
 *  LIBRERÍAS REQUERIDAS (instalar desde el gestor de librerías de Arduino):
 *    - ModbusMaster  (4-20ma / Doc Walker, versión 2.x)
 *    - ArduinoJson   (Benoit Blanchon, versión 7.x)
 *
 *  CONFIGURACIÓN DEL VARIADOR (antes de conectar):
 *    Pd-00 = 5  → Baudrate 9600 bps
 *    Pd-01 = 0  → 8-N-2 (sin paridad, 2 stop bits)
 *    Pd-02 = 1  → Dirección esclavo = 1
 *    Pd-05 = 0  → Modbus RTU
 *
 *  PRIMER USO (sin WiFi configurado):
 *    1. Subir este firmware al ESP32
 *    2. El ESP32 levanta la red WiFi "SUSWE-Config" (contraseña: suswe1234)
 *    3. Conectarse a esa red desde PC o celular
 *    4. Abrir http://192.168.4.1 en el navegador
 *    5. Ir al panel "📡 Configuración WiFi" e ingresar SSID + contraseña
 *    6. El ESP32 se reinicia y se conecta a la red configurada
 *    7. Ver la IP asignada por el router en el monitor serial (115200 bps)
 *
 *  USOS SIGUIENTES:
 *    - La IP se mantiene mientras el router no cambie la asignación DHCP
 *    - Para reconfigurar el WiFi: mantener presionado el botón BOOT del ESP32
 *      durante 3 segundos al arrancar → vuelve al modo AP
 * ============================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <uri/UriBraces.h>
#include <ArduinoJson.h>
#include <ModbusMaster.h>
#include <Preferences.h>
#include <Update.h>               // OTA — actualización de firmware por WiFi

// ─── Versión de firmware ──────────────────────────────────
#define FIRMWARE_VERSION  "1.3.0"
#define FIRMWARE_DATE     __DATE__   // fecha de compilación inyectada por el compilador

// ─── Modo AP — red de configuración inicial ───────────────
#define AP_SSID      "SUSWE-Config"
#define AP_PASSWORD  "suswe1234"
#define AP_IP        "192.168.4.1"
#define BOOT_PIN     0              // GPIO0 = botón BOOT del ESP32

// ─── Configuración Modbus RTU ─────────────────────────────
#define RS485_RX_PIN    16
#define RS485_TX_PIN    17
#define RS485_DIR_PIN    4
#define MODBUS_BAUD   9600
#define MODBUS_SLAVE_ID  1

// ─── Registros del SU900 (según manual Cap.5) ────────────
// Registros de control (escritura)
#define REG_FREQ_SETPOINT  0x1000   // consigna de frecuencia por comunicación
#define REG_CONTROL_CMD    0x2000   // comando de marcha/paro
#define REG_DIGITAL_OUT    0x2001   // control salidas digitales DO
#define REG_AO1            0x2002   // control salida analógica AO1
#define REG_AO2            0x2003   // control salida analógica AO2
#define REG_FMP            0x2004   // control salida pulso FMP

// Registro de estado (lectura)
#define REG_RUN_STATUS     0x3000   // estado de funcionamiento del variador

// Bloque de monitoreo U0 (lectura, 0x1001~0x1020)
// Nota: 0x1000 es la consigna de frecuencia (W), los datos U0 empiezan en 0x1001
#define REG_U0_START       0x1001   // inicio del bloque U0
#define REG_U0_COUNT         32     // registros 0x1001..0x1020

// Fallas
#define REG_FAULT_ACTIVE   0x8000   // código de falla activa
#define REG_FAULT_H1       0x900E   // P9-14: historial falla más reciente
#define REG_FAULT_H2       0x900F   // P9-15: historial falla anterior 1
#define REG_FAULT_H3       0x9010   // P9-16: historial falla anterior 2

// ─── Comandos de control (valores para REG_CONTROL_CMD) ──
// Según manual Cap.5, tabla de comandos dirección 0x2000:
#define CMD_RUN_FORWARD   0x0001   // marcha adelante
#define CMD_RUN_REVERSE   0x0002   // marcha inversa
#define CMD_JOG_FORWARD   0x0003   // jog adelante
#define CMD_JOG_REVERSE   0x0004   // jog inverso
#define CMD_FREE_STOP     0x0005   // paro libre (inercia)
#define CMD_RAMP_STOP     0x0006   // paro con rampa de desaceleración
#define CMD_FAULT_RESET   0x0007   // reset de falla

// ─── Mapa de parámetros (grupos P0~P6, Pd) ───────────────
struct ParamEntry { const char* code; uint16_t addr; float scale; };
const ParamEntry PARAM_MAP[] = {
  // Grupo P0 — Operativos básicos
  {"P0-00", 0x0000, 1.0f   },
  {"P0-01", 0x0001, 1.0f   },
  {"P0-02", 0x0002, 1.0f   },
  {"P0-03", 0x0003, 1.0f   },
  {"P0-04", 0x0004, 1.0f   },
  {"P0-06", 0x0006, 0.1f   },  // % cobertura frec. Y
  {"P0-07", 0x0007, 1.0f   },
  {"P0-08", 0x0008, 0.01f  },  // Hz
  {"P0-10", 0x000A, 0.01f  },  // Hz
  {"P0-11", 0x000B, 1.0f   },
  {"P0-12", 0x000C, 0.01f  },  // Hz
  {"P0-14", 0x000E, 0.01f  },  // Hz
  {"P0-15", 0x000F, 0.1f   },  // kHz portadora
  {"P0-17", 0x0011, 0.1f   },  // s aceleración
  {"P0-18", 0x0012, 0.1f   },  // s desaceleración
  {"P0-19", 0x0013, 1.0f   },
  {"P0-22", 0x0016, 1.0f   },
  {"P0-25", 0x0019, 1.0f   },
  {"P0-29", 0x001D, 1.0f   },
  // Grupo P1 — Motor (0x10xx — colisión con U0 monitor, leer individualmente)
  {"P1-00", 0x1000, 1.0f   },
  {"P1-01", 0x1001, 0.1f   },  // kW
  {"P1-02", 0x1002, 1.0f   },  // V
  {"P1-03", 0x1003, 0.01f  },  // A
  {"P1-04", 0x1004, 0.01f  },  // Hz
  {"P1-05", 0x1005, 1.0f   },  // rpm
  {"P1-06", 0x1006, 0.001f },  // factor de potencia
  {"P1-07", 0x1007, 0.01f  },  // A corriente descarga
  {"P1-37", 0x1025, 1.0f   },
  // Grupo P2 — Control vectorial (0x20xx — colisión con registros de control)
  {"P2-00", 0x2000, 1.0f   },
  {"P2-01", 0x2001, 0.001f },  // s
  {"P2-02", 0x2002, 0.01f  },  // Hz
  {"P2-03", 0x2003, 1.0f   },
  {"P2-04", 0x2004, 0.001f },  // s
  {"P2-05", 0x2005, 0.01f  },  // Hz
  {"P2-06", 0x2006, 1.0f   },  // %
  {"P2-07", 0x2007, 0.001f },  // s
  {"P2-09", 0x2009, 1.0f   },
  {"P2-10", 0x200A, 0.1f   },  // %
  // Grupo P3 — Control V/F (0x30xx — colisión con REG_RUN_STATUS)
  {"P3-00", 0x3000, 1.0f   },
  {"P3-01", 0x3001, 0.1f   },  // % boost par
  {"P3-02", 0x3002, 0.01f  },  // Hz
  {"P3-03", 0x3003, 0.1f   },  // V
  {"P3-04", 0x3004, 0.01f  },  // Hz
  {"P3-05", 0x3005, 0.1f   },  // V
  {"P3-06", 0x3006, 0.01f  },  // Hz
  {"P3-07", 0x3007, 0.1f   },  // V
  {"P3-08", 0x3008, 0.01f  },  // Hz
  {"P3-10", 0x300A, 0.1f   },  // % compensación deslizamiento
  // Grupo P4 — Entradas digitales
  {"P4-00", 0x4000, 1.0f   },
  {"P4-01", 0x4001, 1.0f   },
  {"P4-02", 0x4002, 1.0f   },
  {"P4-03", 0x4003, 1.0f   },
  {"P4-04", 0x4004, 1.0f   },
  {"P4-09", 0x4009, 0.001f },  // s filtro
  {"P4-10", 0x400A, 1.0f   },
  {"P4-11", 0x400B, 0.001f },  // Hz/s
  {"P4-13", 0x400D, 0.01f  },  // V AI1 min
  {"P4-14", 0x400E, 0.1f   },  // % AI1 min corresponde
  {"P4-15", 0x400F, 0.01f  },  // V AI1 max
  {"P4-16", 0x4010, 0.1f   },  // % AI1 max corresponde
  {"P4-17", 0x4011, 0.01f  },  // s filtro AI1
  {"P4-18", 0x4012, 0.01f  },  // V AI2 min
  {"P4-19", 0x4013, 0.1f   },  // % AI2 min corresponde
  {"P4-20", 0x4014, 0.01f  },  // V AI2 max
  {"P4-21", 0x4015, 0.1f   },  // % AI2 max corresponde
  {"P4-33", 0x4021, 1.0f   },
  {"P4-38", 0x4026, 1.0f   },
  // Grupo P5 — Salidas digitales
  {"P5-00", 0x5000, 1.0f   },
  {"P5-01", 0x5001, 1.0f   },
  {"P5-02", 0x5002, 1.0f   },
  {"P5-03", 0x5003, 1.0f   },
  {"P5-04", 0x5004, 1.0f   },
  {"P5-07", 0x5007, 1.0f   },
  {"P5-08", 0x5008, 1.0f   },
  {"P5-09", 0x5009, 1.0f   },
  {"P5-10", 0x500A, 0.1f   },  // % AO1 min
  {"P5-11", 0x500B, 0.1f   },  // % AO1 max
  {"P5-18", 0x5012, 0.01f  },  // Hz umbral detección
  {"P5-19", 0x5013, 0.01f  },  // Hz histéresis
  // Grupo P6 — Arranque y parada
  {"P6-00", 0x6000, 1.0f   },
  {"P6-01", 0x6001, 0.01f  },  // Hz arranque
  {"P6-02", 0x6002, 0.01f  },  // s hold arranque
  {"P6-03", 0x6003, 0.1f   },  // s freno DC arranque
  {"P6-04", 0x6004, 0.1f   },  // % corriente freno
  {"P6-05", 0x6005, 1.0f   },
  {"P6-07", 0x6007, 0.01f  },  // Hz inicio freno DC parada
  {"P6-08", 0x6008, 0.1f   },  // s espera freno DC parada
  {"P6-09", 0x6009, 0.1f   },  // % corriente freno DC parada
  {"P6-10", 0x600A, 0.1f   },  // s tiempo freno DC parada
  {"P6-11", 0x600B, 0.01f  },  // Hz arranque marcha en giro
  {"P6-12", 0x600C, 0.1f   },  // % corriente parada marcha giro
  // Grupo Pd — Comunicación Modbus
  {"Pd-00", 0xD000, 1.0f   },
  {"Pd-01", 0xD001, 1.0f   },
  {"Pd-02", 0xD002, 1.0f   },
  {"Pd-03", 0xD003, 1.0f   },
  {"Pd-04", 0xD004, 0.1f   },  // s timeout
  {"Pd-05", 0xD005, 1.0f   },
  {"Pd-06", 0xD006, 1.0f   },
};
const int PARAM_MAP_SIZE = sizeof(PARAM_MAP) / sizeof(ParamEntry);

// ─── Objetos globales ──────────────────────────────────────
ModbusMaster node;
WebServer     server(80);
Preferences   prefs;

// ─── Estado WiFi ──────────────────────────────────────────
struct WifiConfig {
  String ssid     = "";
  String password = "";
} wifiCfg;

bool apMode = false;   // true = ESP32 está en modo AP de configuración

void wifiLoad() {
  prefs.begin("su900wifi", true);
  wifiCfg.ssid     = prefs.getString("ssid", "");
  wifiCfg.password = prefs.getString("pass", "");
  prefs.end();
}

void wifiSave(const String& ssid, const String& pass) {
  prefs.begin("su900wifi", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
  wifiCfg.ssid     = ssid;
  wifiCfg.password = pass;
}

// Arranca en modo AP de configuración con IP fija 192.168.4.1
void startAP() {
  apMode = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.println("Modo AP activo: " + String(AP_SSID));
  Serial.println("Contraseña AP:  " + String(AP_PASSWORD));
  Serial.println("URL de config:  http://" + String(AP_IP));
}

// Intenta conectar como cliente STA. Retorna true si lo logra en el timeout.
bool startSTA(const String& ssid, const String& pass, uint32_t timeoutMs = 15000) {
  apMode = false;
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.print("Conectando a '" + ssid + "'");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - t0) < timeoutMs) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi conectado! IP: " + WiFi.localIP().toString());
    return true;
  }
  Serial.println("No se pudo conectar a '" + ssid + "'");
  return false;
}

// ─── Estado de autenticación HTTP Basic ───────────────────
struct AuthConfig {
  bool    enabled  = false;
  String  username = "";
  String  password = "";
} authCfg;

// Tabla Base64
static const char b64chars[] =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

String base64Encode(const String& input) {
  String out = "";
  int i = 0, len = input.length();
  uint8_t c3[3];
  int idx = 0;
  while (len--) {
    c3[idx++] = (uint8_t)input[i++];
    if (idx == 3) {
      out += b64chars[(c3[0] & 0xfc) >> 2];
      out += b64chars[((c3[0] & 0x03) << 4) + ((c3[1] & 0xf0) >> 4)];
      out += b64chars[((c3[1] & 0x0f) << 2) + ((c3[2] & 0xc0) >> 6)];
      out += b64chars[c3[2] & 0x3f];
      idx = 0;
    }
  }
  if (idx) {
    for (int j = idx; j < 3; j++) c3[j] = 0;
    out += b64chars[(c3[0] & 0xfc) >> 2];
    out += b64chars[((c3[0] & 0x03) << 4) + ((c3[1] & 0xf0) >> 4)];
    if (idx > 1) out += b64chars[((c3[1] & 0x0f) << 2)];
    else         out += '=';
    out += '=';
  }
  return out;
}

void authLoad() {
  prefs.begin("su900auth", true);
  authCfg.enabled  = prefs.getBool("enabled",  false);
  authCfg.username = prefs.getString("user",   "");
  authCfg.password = prefs.getString("pass",   "");
  prefs.end();
}

void authSaveNVS() {
  prefs.begin("su900auth", false);
  prefs.putBool("enabled",  authCfg.enabled);
  prefs.putString("user",   authCfg.username);
  prefs.putString("pass",   authCfg.password);
  prefs.end();
}

bool authCheck() {
  if (!authCfg.enabled) return true;
  if (!server.hasHeader("Authorization")) return false;
  String hdr = server.header("Authorization");
  if (!hdr.startsWith("Basic ")) return false;
  String token    = hdr.substring(6);
  String expected = base64Encode(authCfg.username + ":" + authCfg.password);
  return (token == expected);
}

void sendUnauthorized() {
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  server.sendHeader("WWW-Authenticate", "Basic realm=\"SU900 Gateway\"");
  server.send(401, "application/json", "{\"error\":\"unauthorized\"}");
}

// ─── Control de dirección RS-485 (half-duplex) ────────────
void preTransmission()  { digitalWrite(RS485_DIR_PIN, HIGH); }
void postTransmission() { digitalWrite(RS485_DIR_PIN, LOW);  }

// ─── Helpers HTTP ─────────────────────────────────────────
void setCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

void sendJSON(int code, const String& json) {
  setCORSHeaders();
  server.send(code, "application/json", json);
}

// Busca un parámetro en PARAM_MAP por código (ej: "P0-08")
// Retorna índice o -1 si no se encuentra.
int findParamIdx(const String& code) {
  for (int i = 0; i < PARAM_MAP_SIZE; i++) {
    if (code.equalsIgnoreCase(PARAM_MAP[i].code)) return i;
  }
  return -1;
}

// Convierte raw Modbus → valor real usando la escala del PARAM_MAP.
// Para valores con signo (16-bit complemento a 2) ajusta el rango.
float rawToReal(int idx, uint16_t raw) {
  float scale = PARAM_MAP[idx].scale;
  // Registros con posible signo (frecuencia auxiliar, AI, par, etc.)
  int32_t signed_raw = (raw > 32767) ? (int32_t)raw - 65536 : (int32_t)raw;
  return signed_raw * scale;
}

// Convierte valor real → raw para escritura Modbus
uint16_t realToRaw(int idx, float real) {
  float scale = PARAM_MAP[idx].scale;
  if (scale == 0.0f) return 0;
  int32_t raw = (int32_t)roundf(real / scale);
  return (uint16_t)(raw & 0xFFFF);
}

// ─── MANEJADORES HTTP ──────────────────────────────────────

void handleOptions() {
  setCORSHeaders();
  server.send(204);
}

// GET|POST /api/connect — el ESP32 siempre está "conectado"
void handleConnect() {
  if (!authCheck()) { sendUnauthorized(); return; }
  sendJSON(200, "{\"ok\":true,\"message\":\"ESP32 conectado via WiFi\",\"type\":\"TCP\"}");
}

// POST /api/disconnect
void handleDisconnect() {
  if (!authCheck()) { sendUnauthorized(); return; }
  sendJSON(200, "{\"ok\":true}");
}

// GET /api/status-conn — estado de la conexión (sin leer el variador)
void handleStatusConn() {
  String ip   = WiFi.localIP().toString();
  String json = "{\"connected\":true,\"type\":\"TCP\",\"host\":\"" + ip + "\",\"port\":80,\"unitId\":" + String(MODBUS_SLAVE_ID) + "}";
  sendJSON(200, json);
}

// GET /api/status — estado de funcionamiento del variador (registro 0x3000)
void handleStatus() {
  if (!authCheck()) { sendUnauthorized(); return; }
  uint8_t res = node.readHoldingRegisters(REG_RUN_STATUS, 1);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  uint16_t sw  = node.getResponseBuffer(0);
  // Bits según manual: 0=marcha adelante, 1=marcha inversa, 2=parada
  bool running = (sw & 0x03) != 0;
  bool reverse = (sw & 0x02) != 0;
  // status string legible para la UI
  String status;
  if      (sw == 0x0001) status = "forward";
  else if (sw == 0x0002) status = "reverse";
  else if (sw == 0x0003) status = "stopped";
  else                   status = "unknown";

  String json = "{";
  json += "\"raw\":"       + String(sw) + ",";
  json += "\"running\":"   + String(running ? "true" : "false") + ",";
  json += "\"direction\":\"" + String(reverse ? "reverse" : "forward") + "\",";
  json += "\"status\":\""  + status + "\"";
  json += "}";
  sendJSON(200, json);
}

// GET /api/monitor — bloque U0 completo (0x1001~0x1020 = 32 registros)
void handleMonitor() {
  if (!authCheck()) { sendUnauthorized(); return; }

  uint8_t res = node.readHoldingRegisters(REG_U0_START, REG_U0_COUNT);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }

  // Mapa de registros U0 con sus escalas (según manual Cap.5, tabla 0x1001~0x1020)
  struct U0Reg { const char* code; int offset; float scale; const char* unit; };
  const U0Reg U0[] = {
    {"U0-00",  0, 0.01f,  "Hz" },  // 0x1001 frecuencia de salida
    {"U0-01",  1, 1.0f,   "V"  },  // 0x1002 tensión bus DC
    {"U0-02",  2, 1.0f,   "V"  },  // 0x1003 tensión de salida
    {"U0-03",  3, 0.1f,   "A"  },  // 0x1004 corriente de salida
    {"U0-04",  4, 0.1f,   "kW" },  // 0x1005 potencia de salida
    {"U0-05",  5, 0.1f,   "%"  },  // 0x1006 par de salida
    {"U0-06",  6, 1.0f,   "rpm"},  // 0x1007 velocidad de funcionamiento
    {"U0-07",  7, 1.0f,   ""   },  // 0x1008 estado entradas DI
    {"U0-08",  8, 1.0f,   ""   },  // 0x1009 estado salidas DO
    {"U0-09",  9, 0.01f,  "V"  },  // 0x100A voltaje AI1
    {"U0-10", 10, 0.01f,  "V"  },  // 0x100B voltaje AI2
    {"U0-11", 11, 0.01f,  "V"  },  // 0x100C voltaje AI3
    {"U0-16", 15, 0.01f,  "%"  },  // 0x1010 consigna PID
    {"U0-17", 16, 0.01f,  "%"  },  // 0x1011 retroalimentación PID
    {"U0-19", 26, 1.0f,   "rpm"},  // 0x101B velocidad real motor
    {"U0-31", 31, 0.01f,  "Hz" },  // 0x1020 frecuencia auxiliar Y
  };
  const int U0_COUNT = sizeof(U0) / sizeof(U0Reg);

  String json = "{";
  bool first = true;
  for (int i = 0; i < U0_COUNT; i++) {
    if (U0[i].offset >= REG_U0_COUNT) continue;
    uint16_t raw = node.getResponseBuffer(U0[i].offset);
    // Par de salida puede ser negativo (complemento a 2)
    int32_t signed_raw = (raw > 32767) ? (int32_t)raw - 65536 : (int32_t)raw;
    float   val        = signed_raw * U0[i].scale;
    if (!first) json += ",";
    first = false;
    json += "\"" + String(U0[i].code) + "\":{";
    json += "\"code\":\""      + String(U0[i].code) + "\",";
    json += "\"name\":\""      + String(U0[i].code) + "\",";
    json += "\"realValue\":"   + String(val, 2) + ",";
    json += "\"unit\":\""      + String(U0[i].unit) + "\"";
    json += "}";
  }
  json += "}";
  sendJSON(200, json);
}

// GET /api/param/{code}
void handleParamRead() {
  if (!authCheck()) { sendUnauthorized(); return; }
  String code = server.pathArg(0);
  code.replace("%2D", "-");
  int idx = findParamIdx(code);
  if (idx < 0) { sendJSON(404, "{\"error\":\"param_not_found\"}"); return; }

  uint8_t res = node.readHoldingRegisters(PARAM_MAP[idx].addr, 1);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  uint16_t raw  = node.getResponseBuffer(0);
  float    real = rawToReal(idx, raw);
  String json = "{\"code\":\"" + code + "\",\"addr\":" + String(PARAM_MAP[idx].addr) +
                ",\"raw\":" + String(raw) + ",\"realValue\":" + String(real, 4) +
                ",\"unit\":\"\",\"ok\":true}";
  sendJSON(200, json);
}

// PUT /api/param/{code}   body: { "value": N }
void handleParamWrite() {
  if (!authCheck()) { sendUnauthorized(); return; }
  String code = server.pathArg(0);
  code.replace("%2D", "-");
  int idx = findParamIdx(code);
  if (idx < 0) { sendJSON(404, "{\"error\":\"param_not_found\"}"); return; }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) { sendJSON(400, "{\"error\":\"bad_json\"}"); return; }

  float    real = doc["value"].as<float>();
  uint16_t raw  = realToRaw(idx, real);

  uint8_t res = node.writeSingleRegister(PARAM_MAP[idx].addr, raw);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  sendJSON(200, "{\"ok\":true,\"code\":\"" + code + "\",\"rawValue\":" + String(raw) +
               ",\"realValue\":" + String(real, 4) + "}");
}

// GET /api/group/{key} — lee todos los parámetros de un grupo
void handleGroupRead() {
  if (!authCheck()) { sendUnauthorized(); return; }
  String gk = server.pathArg(0);
  gk.toLowerCase();

  String json = "[";
  bool first = true;
  for (int i = 0; i < PARAM_MAP_SIZE; i++) {
    String codeStr = String(PARAM_MAP[i].code);
    String codeLC  = codeStr;
    codeLC.toLowerCase();

    // Determinar prefijo del grupo
    String prefix = "p" + gk.substring(1);   // p0, p1, pd…
    if (gk == "pd") prefix = "pd";
    bool match = codeLC.startsWith(prefix);
    if (!match) continue;

    uint8_t res = node.readHoldingRegisters(PARAM_MAP[i].addr, 1);
    if (!first) json += ",";
    first = false;
    if (res == node.ku8MBSuccess) {
      uint16_t raw  = node.getResponseBuffer(0);
      float    real = rawToReal(i, raw);
      json += "{\"code\":\"" + codeStr + "\",\"ok\":true,\"rawValue\":" +
              String(raw) + ",\"realValue\":" + String(real, 4) + "}";
    } else {
      json += "{\"code\":\"" + codeStr + "\",\"ok\":false,\"error\":\"modbus_fail\"}";
    }
    delay(20);
  }
  json += "]";
  sendJSON(200, json);
}

// POST /api/command   body: { "command": "RUN_FORWARD" }
void handleCommand() {
  if (!authCheck()) { sendUnauthorized(); return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) { sendJSON(400, "{\"error\":\"bad_json\"}"); return; }

  String   cmd    = doc["command"].as<String>();
  uint16_t regVal = 0;

  if      (cmd == "RUN_FORWARD")  regVal = CMD_RUN_FORWARD;
  else if (cmd == "RUN_REVERSE")  regVal = CMD_RUN_REVERSE;
  else if (cmd == "JOG_FORWARD")  regVal = CMD_JOG_FORWARD;
  else if (cmd == "JOG_REVERSE")  regVal = CMD_JOG_REVERSE;
  else if (cmd == "FREE_STOP")    regVal = CMD_FREE_STOP;
  else if (cmd == "RAMP_STOP")    regVal = CMD_RAMP_STOP;
  else if (cmd == "FAULT_RESET")  regVal = CMD_FAULT_RESET;
  else { sendJSON(400, "{\"error\":\"unknown_command\"}"); return; }

  uint8_t res = node.writeSingleRegister(REG_CONTROL_CMD, regVal);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  sendJSON(200, "{\"ok\":true,\"command\":\"" + cmd + "\",\"value\":" + String(regVal) + "}");
}

// POST /api/frequency   body: { "freqHz": 30.0, "maxFreq": 50.0 }
// Registro 0x1000: rango -10000~+10000 = -100.00%~+100.00% de frecuencia máxima
void handleFrequency() {
  if (!authCheck()) { sendUnauthorized(); return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) { sendJSON(400, "{\"error\":\"bad_json\"}"); return; }

  float    hz     = doc["freqHz"].as<float>();
  float    maxF   = doc["maxFreq"].as<float>();
  if (maxF <= 0.0f) maxF = 50.0f;
  float    pct    = hz / maxF;
  int32_t  raw32  = (int32_t)roundf(pct * 10000.0f);
  if (raw32 < -10000) raw32 = -10000;
  if (raw32 >  10000) raw32 =  10000;
  uint16_t raw = (raw32 < 0) ? (uint16_t)(raw32 + 65536) : (uint16_t)raw32;

  uint8_t res = node.writeSingleRegister(REG_FREQ_SETPOINT, raw);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  sendJSON(200, "{\"ok\":true,\"freqHz\":" + String(hz, 2) + ",\"raw\":" + String(raw) + "}");
}

// GET /api/fault — código de falla activa (0x8000)
void handleFaultRead() {
  if (!authCheck()) { sendUnauthorized(); return; }
  uint8_t res = node.readHoldingRegisters(REG_FAULT_ACTIVE, 1);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  uint16_t fc = node.getResponseBuffer(0);
  char buf[12]; sprintf(buf, "0x%04X", fc);
  String json = "{\"raw\":" + String(fc) + ",\"code\":\"" + String(buf) + "\",\"hasFault\":" +
                String(fc != 0 ? "true" : "false") + "}";
  sendJSON(200, json);
}

// POST /api/fault-reset — reset de falla
void handleFaultReset() {
  if (!authCheck()) { sendUnauthorized(); return; }
  uint8_t res = node.writeSingleRegister(REG_CONTROL_CMD, CMD_FAULT_RESET);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  sendJSON(200, "{\"ok\":true,\"command\":\"FAULT_RESET\",\"value\":" + String(CMD_FAULT_RESET) + "}");
}

// GET /api/fault-history — historial P9-14, P9-15, P9-16 (0x900E~0x9010)
void handleFaultHistory() {
  if (!authCheck()) { sendUnauthorized(); return; }
  // Leer los 3 registros de historial en bloque (son contiguos)
  uint8_t res = node.readHoldingRegisters(REG_FAULT_H1, 3);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  // Direcciones de historial según manual
  const uint16_t addrs[] = { REG_FAULT_H1, REG_FAULT_H2, REG_FAULT_H3 };
  String json = "[";
  for (int i = 0; i < 3; i++) {
    uint16_t raw = node.getResponseBuffer(i);
    char buf[12]; sprintf(buf, "0x%04X", addrs[i]);
    char fbuf[12]; sprintf(fbuf, "0x%04X", raw);
    if (i > 0) json += ",";
    json += "{\"addr\":\"" + String(buf) + "\",\"raw\":" + String(raw) +
            ",\"hasFault\":" + String(raw != 0 ? "true" : "false") +
            ",\"name\":\"" + (raw == 0 ? "Sin falla registrada" : "Ver codigo") + "\"}";
  }
  json += "]";
  sendJSON(200, json);
}

// POST /api/digital-outputs
// Body del frontend: { "bits": { "DO1": bool, "DO2": bool, "RELAY1": bool, ... } }
// El frontend construye el word de bits; también acepta { "bits": N } para compatibilidad.
void handleDigitalOutputs() {
  if (!authCheck()) { sendUnauthorized(); return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) { sendJSON(400, "{\"error\":\"bad_json\"}"); return; }

  uint16_t word = 0;
  JsonVariant bitsVar = doc["bits"];

  if (bitsVar.is<JsonObject>()) {
    // Formato objeto: { DO1: true, DO2: false, RELAY1: true, ... }
    // Mapa bit por nombre según manual (registro 0x2001):
    // Mapa de bits según manual Cap.5, registro 0x2001:
    // bit0=DO1, bit1=DO2, bit2=RELAY1, bit3=RELAY2, bit4=FMR,
    // bit5=VDO1, bit6=VDO2, bit7=VDO3, bit8=VDO4, bit9=VDO5
    struct BitEntry { const char* name; uint8_t bit; };
    const BitEntry BIT_MAP[] = {
      {"DO1",0},{"DO2",1},{"RELAY1",2},{"RELAY2",3},
      {"FMR",4},{"VDO1",5},{"VDO2",6},{"VDO3",7},{"VDO4",8},{"VDO5",9}
    };
    const int BIT_MAP_SIZE = sizeof(BIT_MAP) / sizeof(BitEntry);
    JsonObject obj = bitsVar.as<JsonObject>();
    for (JsonPair kv : obj) {
      for (int i = 0; i < BIT_MAP_SIZE; i++) {
        if (String(kv.key().c_str()).equalsIgnoreCase(BIT_MAP[i].name)) {
          if (kv.value().as<bool>()) word |= (1 << BIT_MAP[i].bit);
          break;
        }
      }
    }
  } else {
    // Formato entero directo
    word = (uint16_t)bitsVar.as<int>();
  }

  uint8_t res = node.writeSingleRegister(REG_DIGITAL_OUT, word);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  sendJSON(200, "{\"ok\":true,\"word\":" + String(word) + "}");
}

// POST /api/analog-output   body: { "channel": "AO1"|"AO2"|"FMP", "percent": N }
void handleAnalogOutput() {
  if (!authCheck()) { sendUnauthorized(); return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) { sendJSON(400, "{\"error\":\"bad_json\"}"); return; }

  String  channel = doc["channel"].as<String>();
  float   pct     = doc["percent"].as<float>();
  uint16_t addr   = 0;

  if      (channel == "AO1") addr = REG_AO1;
  else if (channel == "AO2") addr = REG_AO2;
  else if (channel == "FMP") addr = REG_FMP;
  else { sendJSON(400, "{\"error\":\"canal_desconocido\"}"); return; }

  // 0~0x7FFF = 0%~100%
  int32_t  raw32 = (int32_t)roundf((pct / 100.0f) * 0x7FFF);
  if (raw32 < 0)      raw32 = 0;
  if (raw32 > 0x7FFF) raw32 = 0x7FFF;
  uint16_t raw = (uint16_t)raw32;

  uint8_t res = node.writeSingleRegister(addr, raw);
  if (res != node.ku8MBSuccess) {
    sendJSON(500, "{\"error\":\"modbus_fail\",\"code\":" + String(res) + "}");
    return;
  }
  sendJSON(200, "{\"ok\":true,\"channel\":\"" + channel + "\",\"percent\":" +
               String(pct, 1) + ",\"raw\":" + String(raw) + "}");
}

// GET /api/profile/read — lee todos los parámetros conocidos
void handleProfileRead() {
  if (!authCheck()) { sendUnauthorized(); return; }
  // Respuesta en formato compatible con DeviceController.readFullProfile()
  String json = "{\"groups\":{";
  // Agrupar por prefijo
  const char* groups[] = {"P0","P1","P2","P3","P4","P5","P6","Pd"};
  const int   N_GROUPS = 8;
  bool firstGroup = true;
  for (int g = 0; g < N_GROUPS; g++) {
    String grp = String(groups[g]);
    String json_params = "[";
    bool firstParam = true;
    for (int i = 0; i < PARAM_MAP_SIZE; i++) {
      if (!String(PARAM_MAP[i].code).startsWith(grp)) continue;
      uint8_t res = node.readHoldingRegisters(PARAM_MAP[i].addr, 1);
      if (!firstParam) json_params += ",";
      firstParam = false;
      if (res == node.ku8MBSuccess) {
        uint16_t raw  = node.getResponseBuffer(0);
        float    real = rawToReal(i, raw);
        json_params += "{\"code\":\"" + String(PARAM_MAP[i].code) + "\",\"ok\":true,\"rw\":true," +
                       "\"rawValue\":" + String(raw) + ",\"realValue\":" + String(real, 4) + "}";
      } else {
        json_params += "{\"code\":\"" + String(PARAM_MAP[i].code) + "\",\"ok\":false}";
      }
      delay(20);
    }
    json_params += "]";
    if (!firstGroup) json += ",";
    firstGroup = false;
    json += "\"" + grp + "\":" + json_params;
  }
  json += "}}";
  sendJSON(200, json);
}

// POST /api/profile/write — escribe un perfil completo
// Body: { "profile": { "groups": { "P0": [ {code, realValue, ok, rw}, ... ], ... } } }
void handleProfileWrite() {
  if (!authCheck()) { sendUnauthorized(); return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) { sendJSON(400, "{\"error\":\"bad_json\"}"); return; }

  int ok_count = 0, err_count = 0;
  JsonObject groups = doc["profile"]["groups"].as<JsonObject>();
  for (JsonPair gPair : groups) {
    JsonArray params = gPair.value().as<JsonArray>();
    for (JsonObject param : params) {
      if (!param["ok"].as<bool>() || !param["rw"].as<bool>()) continue;
      String  code = param["code"].as<String>();
      float   real = param["realValue"].as<float>();
      int     idx  = findParamIdx(code);
      if (idx < 0) continue;
      uint16_t raw = realToRaw(idx, real);
      uint8_t  res = node.writeSingleRegister(PARAM_MAP[idx].addr, raw);
      if (res == node.ku8MBSuccess) ok_count++; else err_count++;
      delay(20);
    }
  }
  sendJSON(200, "{\"ok\":true,\"ok_count\":" + String(ok_count) +
               ",\"errors\":" + String(err_count) + "}");
}

// GET /api/probe-esp32 — responde con info del dispositivo (para detección desde Node.js)
void handleProbeESP32() {
  String json = "{\"found\":true,\"info\":\"ESP32 SU900 Gateway\",\"ip\":\"" +
                WiFi.localIP().toString() + "\"}";
  sendJSON(200, json);
}

// ─── OTA ENDPOINTS ────────────────────────────────────────

// GET /api/ota/version — versión de firmware y espacio disponible
void handleOtaVersion() {
  size_t freeSketch = ESP.getFreeSketchSpace();
  size_t sketchSize = ESP.getSketchSize();
  String json = "{";
  json += "\"version\":\""  + String(FIRMWARE_VERSION) + "\",";
  json += "\"date\":\""     + String(FIRMWARE_DATE)    + "\",";
  json += "\"sketchSize\":" + String(sketchSize)        + ",";
  json += "\"freeSpace\":"  + String(freeSketch);
  json += "}";
  sendJSON(200, json);
}

// POST /api/ota/upload — recibe el binario .bin y realiza la actualización
// El archivo llega como body de la petición (Content-Type: application/octet-stream).
// El frontend envía el archivo completo en un solo POST con XMLHttpRequest
// para poder reportar progreso via onprogress.
void handleOtaUpload() {
  if (!authCheck()) { sendUnauthorized(); return; }

  // El WebServer del ESP32 procesa el body del upload en el handler de upload,
  // no en el handler normal. Usamos ambos hooks.
  // Este handler se llama al FINALIZAR la carga.
  if (Update.hasError()) {
    String err = String(Update.errorString());
    sendJSON(500, "{\"ok\":false,\"error\":\"" + err + "\"}");
    Update.clearError();
  } else {
    sendJSON(200, "{\"ok\":true,\"message\":\"Firmware actualizado. El ESP32 se reiniciara.\"}");
    delay(500);
    ESP.restart();
  }
}

// Handler de datos del upload (llamado por el WebServer mientras llegan los chunks)
void handleOtaUploadData() {
  HTTPUpload& upload = server.upload();

  if (upload.status == UPLOAD_FILE_START) {
    Serial.println("[OTA] Inicio: " + upload.filename +
                   " (" + String(upload.totalSize) + " bytes)");
    // Iniciar la actualización con el tamaño total del sketch
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      Serial.println("[OTA] Error begin: " + String(Update.errorString()));
    }

  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      Serial.println("[OTA] Error write: " + String(Update.errorString()));
    }

  } else if (upload.status == UPLOAD_FILE_END) {
    if (Update.end(true)) {
      Serial.println("[OTA] Completado: " + String(upload.totalSize) + " bytes");
    } else {
      Serial.println("[OTA] Error end: " + String(Update.errorString()));
    }
  }
}

// ─── WIFI ENDPOINTS ───────────────────────────────────────

// GET /api/wifi-status — estado actual de la conexión WiFi
void handleWifiStatus() {
  String mode    = apMode ? "AP" : "STA";
  String ip      = apMode ? AP_IP : WiFi.localIP().toString();
  bool   hasCfg  = wifiCfg.ssid.length() > 0;

  String json = "{";
  json += "\"mode\":\"" + mode + "\",";
  json += "\"ip\":\"" + ip + "\",";
  json += "\"ssid\":\"" + (apMode ? String(AP_SSID) : wifiCfg.ssid) + "\",";
  json += "\"configured\":" + String(hasCfg ? "true" : "false") + ",";
  json += "\"rssi\":" + String(apMode ? 0 : WiFi.RSSI());
  json += "}";
  sendJSON(200, json);
}

// POST /api/wifi-config — guarda nuevas credenciales y reinicia en modo STA
// Body: { "ssid": "MiRed", "password": "clave123" }
void handleWifiConfig() {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) { sendJSON(400, "{\"error\":\"bad_json\"}"); return; }

  String ssid = doc["ssid"].as<String>();
  String pass = doc["password"].as<String>();

  if (ssid.length() == 0) {
    sendJSON(400, "{\"error\":\"El campo ssid no puede estar vacio\"}");
    return;
  }

  wifiSave(ssid, pass);
  sendJSON(200, "{\"ok\":true,\"message\":\"Credenciales guardadas. El ESP32 se reiniciara en modo STA.\"}");

  // Pequeña pausa para que la respuesta HTTP llegue al cliente antes del reinicio
  delay(500);
  ESP.restart();
}

// POST /api/wifi-reset — borra las credenciales WiFi y reinicia en modo AP
void handleWifiReset() {
  wifiSave("", "");
  sendJSON(200, "{\"ok\":true,\"message\":\"Credenciales borradas. El ESP32 se reiniciara en modo AP.\"}");
  delay(500);
  ESP.restart();
}

// ─── AUTH ENDPOINTS ───────────────────────────────────────

// GET /api/auth-status
void handleAuthStatus() {
  String json = "{\"authEnabled\":";
  json += authCfg.enabled ? "true" : "false";
  if (authCfg.enabled && authCfg.username.length() > 0)
    json += ",\"username\":\"" + authCfg.username + "\"";
  json += "}";
  sendJSON(200, json);
}

// POST /api/auth-config   body: { "enabled": bool, "username": "...", "password": "..." }
void handleAuthConfig() {
  if (authCfg.enabled && !authCheck()) { sendUnauthorized(); return; }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) { sendJSON(400, "{\"error\":\"bad_json\"}"); return; }

  bool wantEnabled = doc["enabled"].as<bool>();
  authCfg.enabled  = wantEnabled;
  if (wantEnabled) {
    String u = doc["username"].as<String>();
    String p = doc["password"].as<String>();
    if (u.length() == 0 || p.length() < 6) {
      sendJSON(400, "{\"error\":\"invalid_credentials\"}");
      return;
    }
    authCfg.username = u;
    authCfg.password = p;
  }
  authSaveNVS();
  sendJSON(200, "{\"ok\":true,\"authEnabled\":" +
               String(authCfg.enabled ? "true" : "false") + "}");
}

// ─── SETUP ────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== SUSWE SU900 ESP32 Gateway ===");

  // Cargar configuraciones persistidas
  authLoad();
  wifiLoad();

  Serial.println("Auth: " + String(authCfg.enabled
    ? "ACTIVA (usuario: " + authCfg.username + ")"
    : "DESACTIVADA"));

  // Inicializar RS-485
  pinMode(RS485_DIR_PIN, OUTPUT);
  digitalWrite(RS485_DIR_PIN, LOW);
  Serial2.begin(MODBUS_BAUD, SERIAL_8N2, RS485_RX_PIN, RS485_TX_PIN);

  // Inicializar Modbus
  node.begin(MODBUS_SLAVE_ID, Serial2);
  node.preTransmission(preTransmission);
  node.postTransmission(postTransmission);
  Serial.println("Modbus RTU: 9600 bps, 8-N-2, esclavo ID=" + String(MODBUS_SLAVE_ID));

  // ─── Lógica WiFi: AP vs STA ──────────────────────────────
  // Forzar modo AP si:
  //   a) No hay credenciales WiFi guardadas, O
  //   b) El botón BOOT está presionado al arrancar (reset de configuración)
  pinMode(BOOT_PIN, INPUT_PULLUP);
  bool bootPressed = (digitalRead(BOOT_PIN) == LOW);

  if (bootPressed) {
    Serial.println("Botón BOOT presionado → forzando modo AP de configuración");
    wifiSave("", "");   // borra las credenciales almacenadas
  }

  if (wifiCfg.ssid.length() == 0) {
    // Sin credenciales → modo AP
    startAP();
    Serial.println("============================================");
    Serial.println("  MODO AP DE CONFIGURACION");
    Serial.println("  Red WiFi:    " + String(AP_SSID));
    Serial.println("  Contraseña:  " + String(AP_PASSWORD));
    Serial.println("  URL config:  http://" + String(AP_IP));
    Serial.println("  Panel en el configurador: 📡 Config WiFi");
    Serial.println("============================================");
  } else {
    // Hay credenciales → intentar STA
    bool connected = startSTA(wifiCfg.ssid, wifiCfg.password, 15000);
    if (!connected) {
      // No se pudo conectar → caer a AP como fallback
      Serial.println("Fallo STA → iniciando modo AP como fallback");
      startAP();
    } else {
      Serial.println("============================================");
      Serial.println("  IP del ESP32: " + WiFi.localIP().toString());
      Serial.println("  Configurador: Conexión → TCP/IP");
      Serial.println("  IP: " + WiFi.localIP().toString() + "  Puerto: 80");
      Serial.println("============================================");
    }
  }

  // ─── Registro de rutas ──────────────────────────────────

  // Pre-flight CORS para todas las rutas
  const char* optRoutes[] = {
    "/api/connect",       "/api/disconnect",    "/api/status-conn",
    "/api/status",        "/api/monitor",        "/api/command",
    "/api/frequency",     "/api/fault",          "/api/fault-reset",
    "/api/fault-history", "/api/digital-outputs","/api/analog-output",
    "/api/profile/read",  "/api/profile/write",
    "/api/auth-status",   "/api/auth-config",    "/api/probe-esp32",
    "/api/wifi-status",   "/api/wifi-config",    "/api/wifi-reset",
    "/api/ota/version",   "/api/ota/upload"
  };
  for (const char* r : optRoutes)
    server.on(r, HTTP_OPTIONS, handleOptions);

  // Endpoints operativos
  server.on("/api/connect",          HTTP_GET,  handleConnect);
  server.on("/api/connect",          HTTP_POST, handleConnect);
  server.on("/api/disconnect",       HTTP_POST, handleDisconnect);
  server.on("/api/status-conn",      HTTP_GET,  handleStatusConn);
  server.on("/api/status",           HTTP_GET,  handleStatus);
  server.on("/api/monitor",          HTTP_GET,  handleMonitor);
  server.on("/api/command",          HTTP_POST, handleCommand);
  server.on("/api/frequency",        HTTP_POST, handleFrequency);
  server.on("/api/fault",            HTTP_GET,  handleFaultRead);
  server.on("/api/fault-reset",      HTTP_POST, handleFaultReset);
  server.on("/api/fault-history",    HTTP_GET,  handleFaultHistory);
  server.on("/api/digital-outputs",  HTTP_POST, handleDigitalOutputs);
  server.on("/api/analog-output",    HTTP_POST, handleAnalogOutput);
  server.on("/api/profile/read",     HTTP_GET,  handleProfileRead);
  server.on("/api/profile/write",    HTTP_POST, handleProfileWrite);
  server.on("/api/probe-esp32",      HTTP_GET,  handleProbeESP32);

  // Auth
  server.on("/api/auth-status",      HTTP_GET,  handleAuthStatus);
  server.on("/api/auth-config",      HTTP_POST, handleAuthConfig);

  // WiFi
  server.on("/api/wifi-status",      HTTP_GET,  handleWifiStatus);
  server.on("/api/wifi-config",      HTTP_POST, handleWifiConfig);
  server.on("/api/wifi-reset",       HTTP_POST, handleWifiReset);

  // OTA
  server.on("/api/ota/version",      HTTP_GET,  handleOtaVersion);
  server.on("/api/ota/upload",       HTTP_POST, handleOtaUpload, handleOtaUploadData);

  // Rutas con parámetro de path
  server.on(UriBraces("/api/param/{}"), HTTP_GET, handleParamRead);
  server.on(UriBraces("/api/param/{}"), HTTP_PUT, handleParamWrite);
  server.on(UriBraces("/api/group/{}"), HTTP_GET, handleGroupRead);

  // Ruta raíz → página de info/bienvenida
  server.on("/", []() {
    String ip   = apMode ? AP_IP : WiFi.localIP().toString();
    String mode = apMode ? "AP (configuración)" : "STA (operativo)";
    String html =
      "<html><head><meta charset='utf-8'>"
      "<style>body{font-family:sans-serif;padding:24px;background:#0d1117;color:#e6edf3}"
      "h2{color:#58a6ff}p{margin:6px 0}code{background:#161b22;padding:2px 6px;border-radius:4px}"
      ".ok{color:#3fb950}.warn{color:#f0883e}</style></head><body>"
      "<h2>ESP32 SU900 Gateway</h2>"
      "<p>Modo: <strong class='" + String(apMode ? "warn" : "ok") + "'>" + mode + "</strong></p>"
      "<p>IP: <code>" + ip + "</code></p>"
      "<p>SSID: <code>" + (apMode ? String(AP_SSID) : wifiCfg.ssid) + "</code></p>"
      + (apMode ?
        "<p class='warn'>Conectate al configurador en <code>http://192.168.4.1</code> "
        "e ingresá las credenciales WiFi en el panel 📡 Configuración WiFi.</p>" :
        "<p class='ok'>Firmware operativo. Abrí el configurador HTML y conectá con esta IP.</p>")
      + "</body></html>";
    server.send(200, "text/html", html);
  });

  server.begin();
  Serial.println("Servidor HTTP activo en puerto 80");
}

// ─── LOOP ─────────────────────────────────────────────────
void loop() {
  server.handleClient();
}
