const { app, BrowserWindow, ipcMain, Notification, shell, safeStorage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { SerialPort } = require('serialport');

// Paste the Gemini API key here before building the app. This key is extractable from distributed desktop apps.
const GEMINI_API_KEY = "#####################################################"; 
//API 마스킹됨
const GEMINI_MODEL = 'gemini-3.8-flash';
let aiClient;

app.setName('Roomly');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.ohroha.roomly');
  app.setToastActivatorCLSID('{A8C6FEA4-7E55-4C7B-9BA2-30E9A0B4F21D}');
}
let mainWindow;
const serialPorts = new Map();
const deviceRuntime = new Map();
let sensorHistory = [];
let historyTruncated = false;
let alertHistory = [];
let monitoringEvents = [];
let appStartedAt = new Date().toISOString();
let latestReading = null;
const DEFAULT_THRESHOLDS = Object.freeze({ temperatureMin: 18, temperatureMax: 28, humidityMin: 30, humidityMax: 65, gasRawMax: 700, lightLuxLimit: 100, lightLuxDirection: 'below' });
let thresholds = { ...DEFAULT_THRESHOLDS };
let lightCalibration = { fixedResistorOhms: 10000, resistanceAt10LuxOhms: 15000, gamma: 0.7, wiring: 'ldr-high' };
const DEFAULT_KMA_SERVICE_KEY = '4f8111d6fc0a9521e2b4f2efd81791cb3863e54c52c01bc279a1c2fffe851404';
let weatherSettings = { nx: 60, ny: 127, stnId: 108, region: '?쒖슱', apiKey: DEFAULT_KMA_SERVICE_KEY };
let weatherSnapshot = { weather: null, advisories: [], error: '湲곗긽泥?API ?ㅻ? ?ㅼ젙??二쇱꽭??' };
let savedReports = [];
let lastDailyReportDate = '';
let lastDailyReviewStatus = null;
let saveTimer;
let invalidSensorLines = 0;
let lastSensorAt = null;
let notificationRepeatMinutes = 30;
let pendingReadings = [];
let readingFlushTimer;
let readingWriteQueue = Promise.resolve();
let readingLogRows = 0;
let quitAfterReadingFlush = false;
let systemSettings = { sampleIntervalSeconds: 30, retentionDays: 30, temperatureOffset: 0, humidityOffset: 0, alertHoldSeconds: 60, autoReconnect: true, notifyRecovery: false, notifyDataGap: false, dataGapMinutes: 5, deviceName: 'Sensor profile', temperatureSensor: 'unspecified', gasSensor: 'unspecified', lightSensor: 'ldr' };
let lastSerialConnection = null;
let lastPersistedAt = 0;
let lastQualityPersistedAt = 0;

const dataPath = () => path.join(app.getPath('userData'), 'room-data.json');
const readingLogPath = () => path.join(app.getPath('userData'), 'room-readings.jsonl');
const maxStoredRows = () => Math.max(1, Math.min(300000, Math.floor(Number(systemSettings.retentionDays || 30) * 86400 / Number(systemSettings.sampleIntervalSeconds || 30))));
const LEGACY_DEVICE_ID = 'legacy';

function normalizeDeviceRecord(item) {
  const deviceId = item.deviceId && item.deviceId !== 'default' ? item.deviceId : LEGACY_DEVICE_ID;
  const fallbackName = deviceId === LEGACY_DEVICE_ID ? '?댁쟾 湲곕줉' : (systemSettings.deviceName && systemSettings.deviceName !== 'Roomly' ? systemSettings.deviceName : deviceId);
  const deviceName = !item.deviceName || item.deviceName === 'Roomly' ? fallbackName : item.deviceName;
  return { ...item, deviceId, deviceName };
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    const legacyHistory = Array.isArray(parsed.sensorHistory) ? parsed.sensorHistory : [];
    sensorHistory = legacyHistory;
    historyTruncated = Boolean(parsed.historyTruncated) || legacyHistory.length >= 300000;
    alertHistory = Array.isArray(parsed.alertHistory) ? parsed.alertHistory.slice(-2000) : [];
    monitoringEvents = Array.isArray(parsed.monitoringEvents) ? parsed.monitoringEvents.slice(-1000) : [];
    thresholds = { ...thresholds, ...(parsed.thresholds || {}) };
    lightCalibration = { ...lightCalibration, ...(parsed.lightCalibration || {}) };
    savedReports = Array.isArray(parsed.savedReports) ? parsed.savedReports : [];
    lastDailyReportDate = parsed.lastDailyReportDate || '';
    lastDailyReviewStatus = parsed.lastDailyReviewStatus || null;
    notificationRepeatMinutes = Math.max(5, Math.min(1440, Number(parsed.notificationRepeatMinutes) || 30));
    systemSettings = { ...systemSettings, ...(parsed.systemSettings || {}) };
    lastSerialConnection = parsed.lastSerialConnection || null;
    if (!systemSettings.deviceName || systemSettings.deviceName === 'Roomly') systemSettings.deviceName = 'Sensor profile';
    weatherSettings = { ...weatherSettings, ...(parsed.weatherSettings || {}) };
    if (parsed.weatherKey && safeStorage.isEncryptionAvailable()) weatherSettings.apiKey = safeStorage.decryptString(Buffer.from(parsed.weatherKey, 'base64'));
    sensorHistory = sensorHistory.map(item => ({ ...normalizeDeviceRecord(item), ...(item.lightRaw == null ? {} : { lightLux: estimateLux(item.lightRaw) }) }));
    alertHistory = alertHistory.map(item => ({ ...item, deviceId: item.deviceId && item.deviceId !== 'default' ? item.deviceId : LEGACY_DEVICE_ID, deviceName: item.deviceName && item.deviceName !== 'Roomly' ? item.deviceName : '?댁쟾 湲곕줉' }));
  } catch { /* First launch or an empty local store. */ }
  try {
    const logFile = readingLogPath();
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
      readingLogRows = lines.length;
      if (readingLogRows >= 300000) historyTruncated = true;
      const recent = lines.slice(-300000).flatMap(line => { try { const item = JSON.parse(line); return item && Date.parse(item.timestamp) ? [item] : []; } catch { return []; } });
      const merged = new Map(sensorHistory.map(item => [`${item.deviceId}:${item.timestamp}`, item]));
      for (const rawItem of recent) { const item = normalizeDeviceRecord(rawItem); merged.set(`${item.deviceId}:${item.timestamp}`, item); }
      sensorHistory = [...merged.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-300000).map(normalizeDeviceRecord);
      const beforeRetention = sensorHistory.length;
      const retentionStart = Date.now() - Math.max(1, Number(systemSettings.retentionDays) || 30) * 86400000;
      sensorHistory = sensorHistory.filter(item => Date.parse(item.timestamp) >= retentionStart);
      if (sensorHistory.length < beforeRetention) historyTruncated = true;
      const rowLimit = maxStoredRows();
      if (readingLogRows > rowLimit + 1000 || readingLogRows > sensorHistory.length + 1000) {
        sensorHistory = sensorHistory.slice(-rowLimit);
        historyTruncated = true;
        fs.writeFileSync(logFile, sensorHistory.map(item => JSON.stringify(item)).join('\n') + (sensorHistory.length ? '\n' : ''), 'utf8');
        readingLogRows = sensorHistory.length;
      }
    } else if (sensorHistory.length) {
      const retentionStart = Date.now() - Math.max(1, Number(systemSettings.retentionDays) || 30) * 86400000;
      sensorHistory = sensorHistory.filter(item => Date.parse(item.timestamp) >= retentionStart).slice(-maxStoredRows());
      fs.writeFileSync(logFile, sensorHistory.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
      readingLogRows = sensorHistory.length;
    }
    latestReading = sensorHistory.at(-1) || null;
    lastSensorAt = latestReading?.timestamp || null;
    lastPersistedAt = latestReading ? Date.parse(latestReading.timestamp) : 0;
    for (const item of sensorHistory) {
      let runtime = deviceRuntime.get(item.deviceId);
      if (!runtime) { runtime = { breachStartedAt: new Map(), lastNotifiedAt: new Map(), activeAlertKeys: new Set(), lastQualityPersistedAt: 0 }; deviceRuntime.set(item.deviceId, runtime); }
      runtime.lastReading = item;
      runtime.lastPersistedAt = Math.max(runtime.lastPersistedAt || 0, Date.parse(item.timestamp));
    }
    for (const item of alertHistory) {
      const alertDeviceId = item.deviceId || LEGACY_DEVICE_ID;
      if (item.endedAt) continue;
      let runtime = deviceRuntime.get(alertDeviceId);
      if (!runtime) { runtime = { breachStartedAt: new Map(), lastNotifiedAt: new Map(), activeAlertKeys: new Set(), lastQualityPersistedAt: 0 }; deviceRuntime.set(alertDeviceId, runtime); }
      runtime.activeAlertKeys.add(item.key);
      runtime.breachStartedAt.set(item.key, Date.parse(item.startedAt) || Date.now());
      if (item.lastNotifiedAt) runtime.lastNotifiedAt.set(item.key, Date.parse(item.lastNotifiedAt));
    }
  } catch (error) { console.error('Could not load sensor history log:', error.message); }
}

function writeStore() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const storedWeather = { ...weatherSettings, apiKey: undefined };
    const weatherKey = weatherSettings.apiKey && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(weatherSettings.apiKey).toString('base64') : '';
    fs.writeFileSync(dataPath(), JSON.stringify({ thresholds, savedReports, lastDailyReportDate, lastDailyReviewStatus, lastSerialConnection, weatherSettings: storedWeather, weatherKey, lightCalibration, notificationRepeatMinutes, historyTruncated, systemSettings, alertHistory, monitoringEvents }, null, 2));
  } catch (error) { console.error('Could not save local sensor data:', error.message); }
}

function recordMonitoringEvent(type, details = {}) {
  monitoringEvents.push({ timestamp: new Date().toISOString(), type, ...details });
  monitoringEvents = monitoringEvents.slice(-1000);
  saveStore();
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStore, 300);
}

function queueReadingWrite(reading) {
  pendingReadings.push(reading);
  if (readingFlushTimer) return;
  readingFlushTimer = setTimeout(flushReadingWrites, 500);
}

function flushReadingWrites() {
  clearTimeout(readingFlushTimer);
  readingFlushTimer = null;
  if (!pendingReadings.length) return readingWriteQueue;
  const batch = pendingReadings;
  pendingReadings = [];
  const contents = batch.map(item => JSON.stringify(item)).join('\n') + '\n';
  readingWriteQueue = readingWriteQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(readingLogPath()), { recursive: true });
    await fs.promises.appendFile(readingLogPath(), contents, 'utf8');
    readingLogRows += batch.length;
    if (readingLogRows > maxStoredRows() + 1000) {
      const cutoff = Date.parse(batch.at(-1).timestamp);
      const retentionStart = Date.now() - Math.max(1, Number(systemSettings.retentionDays) || 30) * 86400000;
      const retained = sensorHistory.filter(item => Date.parse(item.timestamp) <= cutoff && Date.parse(item.timestamp) >= retentionStart).slice(-maxStoredRows());
      const temporary = `${readingLogPath()}.tmp`;
      await fs.promises.writeFile(temporary, retained.map(item => JSON.stringify(item)).join('\n') + (retained.length ? '\n' : ''), 'utf8');
      await fs.promises.rename(temporary, readingLogPath());
      historyTruncated = true;
      readingLogRows = retained.length;
    }
  }).catch(error => {
    console.error('Could not append sensor history:', error.message);
    send('storage:error', error.message);
  });
  return readingWriteQueue;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function estimateLux(adc) {
  const value = Math.max(1, Math.min(1022, Number(adc)));
  const fixed = Number(lightCalibration.fixedResistorOhms) || 10000;
  const ldrResistance = lightCalibration.wiring === 'ldr-low'
    ? fixed * value / (1023 - value)
    : fixed * (1023 - value) / value;
  const r10 = Number(lightCalibration.resistanceAt10LuxOhms) || 15000;
  const gamma = Math.max(0.3, Math.min(1.2, Number(lightCalibration.gamma) || 0.7));
  const lux = 10 * Math.pow(ldrResistance / r10, -1 / gamma);
  return Number.isFinite(lux) ? Math.max(0, Math.min(200000, lux)) : null;
}

function parseSensorLine(line) {
  const clean = line.trim();
  if (!clean) return null;
  let data;
  try { data = JSON.parse(clean); } catch { data = null; }
  let temperature = data && (data.temperature ?? data.temp ?? data.t);
  let humidity = data && (data.humidity ?? data.hum ?? data.h);
  let gas = data && (data.gasRaw ?? data.gas ?? data.gasValue ?? data.gas_raw);
  let light = data && (data.lightRaw ?? data.light ?? data.lightLevel ?? data.lightValue ?? data.cdsValue ?? data.ldr ?? data.ldrValue ?? data.brightness ?? data.illuminanceRaw);
  if (temperature == null || humidity == null) {
    const match = clean.match(/(?:T(?:EMP(?:ERATURE)?)?\s*[:=]\s*)?(-?\d+(?:\.\d+)?)\s*[,;\s]+(?:H(?:UM(?:IDITY)?)?\s*[:=]\s*)?(\d+(?:\.\d+)?)/i);
    if (match) [, temperature, humidity] = match;
    const parts = clean.split(/[,;\s]+/);
    if (gas == null && parts.length >= 3 && Number.isFinite(Number(parts[2]))) gas = parts[2];
    if (light == null && parts.length >= 4 && Number.isFinite(Number(parts[3]))) light = parts[3];
  }
  temperature = Number(temperature) + Number(systemSettings.temperatureOffset || 0);
  humidity = Number(humidity) + Number(systemSettings.humidityOffset || 0);
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity) || temperature < -50 || temperature > 100 || humidity < 0 || humidity > 100) return null;
  const reading = { timestamp: new Date().toISOString(), temperature, humidity };
  if (gas != null && Number.isFinite(Number(gas)) && Number(gas) >= 0 && Number(gas) <= 1023) reading.gasRaw = Number(gas);
  if (light != null && Number.isFinite(Number(light)) && Number(light) >= 0 && Number(light) <= 1023) {
    reading.lightRaw = Number(light);
    reading.lightLux = estimateLux(reading.lightRaw);
  }
  return reading;
}

async function requestKma(url, key, params = {}) {
  const parsed = new URL(url);
  parsed.searchParams.set('serviceKey', key);
  parsed.searchParams.set('dataType', 'JSON');
  for (const [name, value] of Object.entries(params)) parsed.searchParams.set(name, String(value));
  const response = await fetch(parsed, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`湲곗긽泥??묐떟 ?ㅻ쪟 (${response.status})`);
  const body = await response.json();
  const result = body.response;
  if (result?.header?.resultCode !== '00') throw new Error(result?.header?.resultMsg || '湲곗긽泥?API ?붿껌???ㅽ뙣?덉뒿?덈떎.');
  return result.body?.items?.item || [];
}

async function refreshWeather() {
  if (!weatherSettings.apiKey) return;
  try {
    const now = new Date();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '');
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).format(now));
    const baseHour = Math.floor((hour - 1) / 3) * 3;
    const baseTime = hour < 2 ? '2300' : `${String(baseHour).padStart(2, '0')}00`;
    const baseDate = hour < 2 ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now.getTime() - 86400000)).replaceAll('-', '') : date;
    const items = await requestKma('https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst', weatherSettings.apiKey, {
      base_date: baseDate, base_time: baseTime, nx: weatherSettings.nx, ny: weatherSettings.ny,
    });
    const today = items.filter(item => item.fcstDate === date);
    const byCat = category => today.find(item => item.category === category)?.fcstValue;
    const advisoryItems = await requestKma('https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnStatus', weatherSettings.apiKey).catch(() => []);
    const advisories = advisoryItems.map(item => item).filter(item => JSON.stringify(item).includes(weatherSettings.region));
    const previous = JSON.stringify(weatherSnapshot.advisories);
    weatherSnapshot = { weather: { temperature: byCat('TMP'), min: byCat('TMN'), max: byCat('TMX'), sky: byCat('SKY'), pty: byCat('PTY'), pop: byCat('POP'), date, updatedAt: new Date().toISOString() }, advisories, error: '' };
    send('weather:update', weatherSnapshot);
    const current = JSON.stringify(advisories);
    if (previous !== '[]' && current !== previous && advisories.length && Notification.isSupported()) {
      const message = advisories.slice(0, 2).map(item => item.t1 || item.title || item.t2).filter(Boolean).join('\n');
      new Notification({ title: `Roomly 쨌 ${weatherSettings.region} ?좎뵪 ?뚮┝`, body: message ? `${message.slice(0, 180)}\n湲곗긽?밸낫 ?댁슜???뺤씤??二쇱꽭??` : '?대떦 吏??뿉 湲곗긽?밸낫媛 諛쒗몴?먯뼱?? ?깆뿉???댁슜???뺤씤??二쇱꽭??', icon: path.join(__dirname, 'assets', 'roomly.png') }).show();
    }
  } catch (error) {
    weatherSnapshot = { ...weatherSnapshot, error: error.message };
    send('weather:update', weatherSnapshot);
  }
}

function getAlerts(reading) {
  const alerts = [];
  if (reading.temperature < Number(thresholds.temperatureMin)) alerts.push(`?⑤룄媛 ?섑븳 ${thresholds.temperatureMin}째C蹂대떎 ??뒿?덈떎`);
  if (reading.temperature > Number(thresholds.temperatureMax)) alerts.push(`?⑤룄媛 ?곹븳 ${thresholds.temperatureMax}째C蹂대떎 ?믪뒿?덈떎`);
  if (reading.humidity < Number(thresholds.humidityMin)) alerts.push(`?듬룄媛 ?섑븳 ${thresholds.humidityMin}%蹂대떎 ??뒿?덈떎`);
  if (reading.humidity > Number(thresholds.humidityMax)) alerts.push(`?듬룄媛 ?곹븳 ${thresholds.humidityMax}%蹂대떎 ?믪뒿?덈떎`);
  if (reading.gasRaw != null && reading.gasRaw >= Number(thresholds.gasRawMax)) alerts.push(`媛???쇱꽌 ?먯떆媛?${reading.gasRaw} (湲곗? ${thresholds.gasRawMax})`);
  if (reading.lightLux != null && ((thresholds.lightLuxDirection === 'above' && reading.lightLux > Number(thresholds.lightLuxLimit)) || (thresholds.lightLuxDirection !== 'above' && reading.lightLux < Number(thresholds.lightLuxLimit)))) alerts.push(`議곕룄 湲곗? ?댄깉 (??${Number(reading.lightLux).toFixed(0)} lux)`);
  return alerts;
}

function getAlertEvents(reading) {
  const events = [];
  if (reading.temperature < Number(thresholds.temperatureMin)) events.push({ key: 'temperature-low', message: `?ㅻ궡 ?⑤룄媛 ??븘??쨌 ?꾩옱 ${Number(reading.temperature).toFixed(1)}째C (?ㅼ젙 ${thresholds.temperatureMin}째C 誘몃쭔)\n?ㅻ궡 ?⑤룄瑜??뺤씤??二쇱꽭??` });
  if (reading.temperature > Number(thresholds.temperatureMax)) events.push({ key: 'temperature-high', message: `?ㅻ궡 ?⑤룄媛 ?믪븘??쨌 ?꾩옱 ${Number(reading.temperature).toFixed(1)}째C (?ㅼ젙 ${thresholds.temperatureMax}째C 珥덇낵)\n?ㅻ궡 ?섍린???됰갑 ?곹깭瑜??뺤씤??二쇱꽭??` });
  if (reading.humidity < Number(thresholds.humidityMin)) events.push({ key: 'humidity-low', message: `?ㅻ궡媛 嫄댁“?댁슂 쨌 ?꾩옱 ?듬룄 ${Number(reading.humidity).toFixed(0)}% (?ㅼ젙 ${thresholds.humidityMin}% 誘몃쭔)\n媛?듭씠???섍린 ?곹깭瑜??뺤씤??二쇱꽭??` });
  if (reading.humidity > Number(thresholds.humidityMax)) events.push({ key: 'humidity-high', message: `?ㅻ궡 ?듬룄媛 ?믪븘??쨌 ?꾩옱 ${Number(reading.humidity).toFixed(0)}% (?ㅼ젙 ${thresholds.humidityMax}% 珥덇낵)\n?섍린 ?곹깭瑜??뺤씤??二쇱꽭??` });
  if (reading.gasRaw != null && reading.gasRaw >= Number(thresholds.gasRawMax)) events.push({ key: 'gas-high', message: `媛???쇱꽌 媛믪씠 ?ㅼ젙 湲곗????섏뿀?댁슂 쨌 ${reading.gasRaw} / ${thresholds.gasRawMax} raw\n二쇰? ?곹깭瑜??뺤씤??二쇱꽭??` });
  if (reading.lightLux != null && ((thresholds.lightLuxDirection === 'above' && reading.lightLux > Number(thresholds.lightLuxLimit)) || (thresholds.lightLuxDirection !== 'above' && reading.lightLux < Number(thresholds.lightLuxLimit)))) events.push({ key: 'light-out-of-range', message: `Light is ${thresholds.lightLuxDirection === 'above' ? 'brighter' : 'darker'} than the configured limit: ${Number(reading.lightLux).toFixed(0)} estimated lux (limit ${thresholds.lightLuxLimit}).` });
  return events;
}

function addReading(reading, device = { id: LEGACY_DEVICE_ID, name: '?댁쟾 湲곕줉' }) {
  const runtimeEntry = serialPorts.get(device.path);
  if (runtimeEntry) { runtimeEntry.gapNotified = false; runtimeEntry.lastReadingAt = Date.now(); }
  const now = Date.now();
  const deviceId = device.id || LEGACY_DEVICE_ID;
  let runtime = deviceRuntime.get(deviceId);
  if (!runtime) { runtime = { breachStartedAt: new Map(), lastNotifiedAt: new Map(), activeAlertKeys: new Set(), lastQualityPersistedAt: 0 }; deviceRuntime.set(deviceId, runtime); }
  reading.deviceId = deviceId;
  reading.deviceName = device.name || deviceId;
  const previousReading = runtime.lastReading;
  const qualityFlags = [];
  if (previousReading) {
    const elapsedSeconds = Math.max(1, (now - Date.parse(previousReading.timestamp)) / 1000);
    if (elapsedSeconds <= 60 && Math.abs(reading.temperature - previousReading.temperature) > 5) qualityFlags.push('temperature-step');
    if (elapsedSeconds <= 60 && Math.abs(reading.humidity - previousReading.humidity) > 25) qualityFlags.push('humidity-step');
  }
  reading.qualityFlags = qualityFlags;
  runtime.lastReading = reading;
  latestReading = reading;
  lastSensorAt = reading.timestamp;
  const alertEvents = getAlertEvents(reading);
  const alerts = alertEvents.map(event => event.message);
  const activeKeys = alertEvents.map(event => event.key);
  const previousKeys = runtime.activeAlertKeys;
  const activeSet = new Set(activeKeys);
  const stateChanged = activeKeys.length !== previousKeys.size || activeKeys.some(key => !previousKeys.has(key));
  for (const key of activeKeys) if (!runtime.breachStartedAt.has(key)) runtime.breachStartedAt.set(key, now);
  for (const key of previousKeys) if (!activeSet.has(key)) runtime.breachStartedAt.delete(key);
  const holdMs = Math.max(0, Number(systemSettings.alertHoldSeconds) || 0) * 1000;
  const newlyActive = alertEvents.filter(({ key }) => now - runtime.breachStartedAt.get(key) >= holdMs && (!runtime.lastNotifiedAt.has(key) || now - runtime.lastNotifiedAt.get(key) >= notificationRepeatMinutes * 60 * 1000));
  const recovered = [...previousKeys].filter(key => !activeSet.has(key));
  const recoveredNotified = recovered.filter(key => runtime.lastNotifiedAt.has(key));
  let alertHistoryChanged = false;
  for (const { key, message } of alertEvents) {
    if (!alertHistory.some(item => item.deviceId === deviceId && item.key === key && !item.endedAt)) {
      alertHistory.push({ id: `${deviceId}-${reading.timestamp}-${key}`, deviceId, deviceName: reading.deviceName, key, message, startedAt: reading.timestamp, endedAt: null, notificationCount: 0, lastNotifiedAt: null });
      alertHistoryChanged = true;
    }
  }
  for (const key of recovered) {
    const active = [...alertHistory].reverse().find(item => item.deviceId === deviceId && item.key === key && !item.endedAt);
    if (active) { active.endedAt = reading.timestamp; alertHistoryChanged = true; }
  }
  runtime.activeAlertKeys = activeSet;
  const persistQuality = qualityFlags.length > 0 && now - runtime.lastQualityPersistedAt >= 60000;
  const persisted = !runtime.lastPersistedAt || now - runtime.lastPersistedAt >= Number(systemSettings.sampleIntervalSeconds) * 1000 || stateChanged || persistQuality;
  if (persisted) {
    const storedReading = { ...reading };
    delete storedReading.qualityFlags;
    if (qualityFlags.length) storedReading.qualityFlags = qualityFlags;
    sensorHistory.push(storedReading);
    const retentionStart = now - Math.max(1, Number(systemSettings.retentionDays) || 30) * 86400000;
    const retained = sensorHistory.filter(item => Date.parse(item.timestamp) >= retentionStart);
    if (retained.length !== sensorHistory.length) { historyTruncated = true; sensorHistory = retained; }
    if (sensorHistory.length > maxStoredRows()) { historyTruncated = true; sensorHistory = sensorHistory.slice(-maxStoredRows()); }
    queueReadingWrite(storedReading);
    runtime.lastPersistedAt = now;
    lastPersistedAt = now;
    if (persistQuality) runtime.lastQualityPersistedAt = now;
  }
  send('sensor:reading', { ...reading, alerts, persisted });
  if (newlyActive.length && Notification.isSupported()) new Notification({ title: `Roomly 쨌 ${reading.deviceName} ?뚮┝`, body: newlyActive.map(item => item.message).join('\n\n'), icon: path.join(__dirname, 'assets', 'roomly.png') }).show();
  for (const { key } of newlyActive) runtime.lastNotifiedAt.set(key, now);
  for (const { key } of newlyActive) {
    const active = [...alertHistory].reverse().find(item => item.deviceId === deviceId && item.key === key && !item.endedAt);
    if (active) { active.notificationCount = (active.notificationCount || 0) + 1; active.lastNotifiedAt = reading.timestamp; alertHistoryChanged = true; }
  }
  if (alertHistoryChanged) { alertHistory = alertHistory.slice(-2000); saveStore(); }
  if (recoveredNotified.length && systemSettings.notifyRecovery && Notification.isSupported()) new Notification({ title: `Roomly 쨌 ${reading.deviceName} 湲곗? 蹂듦?`, body: `${recoveredNotified.join(', ')} 湲곗? 踰붿쐞濡??뚯븘?붿뒿?덈떎.`, icon: path.join(__dirname, 'assets', 'roomly.png') }).show();
}

function summarizePeriod(requestedRange) {
  const now = Date.now();
  const start = requestedRange?.start ? Date.parse(requestedRange.start) : now - 24 * 60 * 60 * 1000;
  const end = requestedRange?.end ? Date.parse(requestedRange.end) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('遺꾩꽍 ?쒖옉?쇨낵 醫낅즺?쇱쓣 ?뺤씤??二쇱꽭??');
  const items = sensorHistory.filter(item => {
    const timestamp = Date.parse(item.timestamp);
    return timestamp >= start && timestamp <= end;
  });
  const aggregate = key => {
    if (!items.length) return { average: null, min: null, max: null };
    let total = 0, minimum = Infinity, maximum = -Infinity;
    for (const item of items) {
      const value = Number(item[key]);
      total += value;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    return { average: +(total / items.length).toFixed(1), min: minimum, max: maximum };
  };
  const temperature = aggregate('temperature');
  const humidity = aggregate('humidity');
  const gasValues = items.filter(item => Number.isFinite(Number(item.gasRaw)));
  const gasRaw = gasValues.length ? {
    average: +(gasValues.reduce((sum, item) => sum + Number(item.gasRaw), 0) / gasValues.length).toFixed(1),
    min: Math.min(...gasValues.map(item => Number(item.gasRaw))),
    max: Math.max(...gasValues.map(item => Number(item.gasRaw))),
  } : null;
  const lightValues = items.filter(item => Number.isFinite(Number(item.lightRaw)));
  const lightRaw = lightValues.length ? {
    average: +(lightValues.reduce((sum, item) => sum + Number(item.lightRaw), 0) / lightValues.length).toFixed(1),
    min: Math.min(...lightValues.map(item => Number(item.lightRaw))),
    max: Math.max(...lightValues.map(item => Number(item.lightRaw))),
  } : null;
  const lightLuxValues = items.filter(item => Number.isFinite(Number(item.lightLux)));
  const lightLux = lightLuxValues.length ? {
    average: +(lightLuxValues.reduce((sum, item) => sum + Number(item.lightLux), 0) / lightLuxValues.length).toFixed(1),
    min: Math.min(...lightLuxValues.map(item => Number(item.lightLux))),
    max: Math.max(...lightLuxValues.map(item => Number(item.lightLux))),
  } : null;
  const outside = items.reduce((counts, item) => {
    if (item.temperature < Number(thresholds.temperatureMin) || item.temperature > Number(thresholds.temperatureMax)) counts.temperature++;
    if (item.humidity < Number(thresholds.humidityMin) || item.humidity > Number(thresholds.humidityMax)) counts.humidity++;
    if (item.gasRaw != null && item.gasRaw >= Number(thresholds.gasRawMax)) counts.gasRaw++;
    if (item.lightLux != null && ((thresholds.lightLuxDirection === 'above' && item.lightLux > Number(thresholds.lightLuxLimit)) || (thresholds.lightLuxDirection !== 'above' && item.lightLux < Number(thresholds.lightLuxLimit)))) counts.lightLux++;
    return counts;
  }, { temperature: 0, humidity: 0, gasRaw: 0, lightLux: 0 });
  return {
    period: requestedRange?.label || '理쒓렐 24?쒓컙', start: new Date(start).toISOString(), end: new Date(end).toISOString(), sampleCount: items.length,
    dataCoverage: { firstSample: items[0]?.timestamp || null, lastSample: items.at(-1)?.timestamp || null, historyTruncated, availableHistoryStartsAt: sensorHistory[0]?.timestamp || null },
    dataQuality: { flaggedSamples: items.filter(item => item.qualityFlags?.length).length, storedSampleIntervalSeconds: systemSettings.sampleIntervalSeconds },
    temperature: { ...temperature, unit: '째C' },
    humidity: { ...humidity, unit: '%' },
    gasRaw: gasRaw ? { ...gasRaw, unit: 'ADC raw (0-1023)', threshold: thresholds.gasRawMax, samples: gasValues.length } : null,
    lightRaw: lightRaw ? { ...lightRaw, unit: 'ADC raw (0-1023)', samples: lightValues.length } : null,
    lightLux: lightLux ? { ...lightLux, unit: 'estimated lux', threshold: thresholds.lightLuxLimit, direction: thresholds.lightLuxDirection, samples: lightLuxValues.length } : null,
    thresholds, readingsOutsideThreshold: outside,
  };
}

async function analyzeEnvironment(kind = 'manual', requestedRange) {
  const summary = summarizePeriod(kind === 'daily' ? undefined : requestedRange);
  if (!summary.sampleCount) throw new Error(`${summary.period}??遺꾩꽍???쇱꽌 湲곕줉???놁뒿?덈떎.`);
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'PASTE_GEMINI_API_KEY_HERE') throw new Error('Set GEMINI_API_KEY in main.js first.');
  const { GoogleGenAI } = await import('@google/genai');
  aiClient ||= new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const result = await aiClient.models.generateContent({
    model: GEMINI_MODEL,
    contents: 'Room temperature, humidity, gas sensor raw readings, and estimated light level summary for ' + summary.period + '. Reply concisely in Korean. Separate observed facts, threshold violations, trends supported by the data, and suggested next steps. State the actual first and last sample times. If the requested period is not fully covered or historyTruncated is true, explicitly say the report only covers available records and do not describe it as a full-period trend. If dataQuality.flaggedSamples is nonzero, mention how many samples had abrupt changes and treat those as readings to review rather than a confirmed trend. Do not make medical diagnoses or guarantee health outcomes; describe this as environmental reference information. Do not describe ADC raw sensor readings as lux or ppm, and clearly describe the CDS lux conversion as an estimate rather than a calibrated measurement.\nAnalysis type: ' + (kind === 'daily' ? 'daily summary' : 'user requested analysis') + '\nData: ' + JSON.stringify(summary),
  });
  const report = { id: `${Date.now()}`, createdAt: new Date().toISOString(), kind, summary, text: result.text || '遺꾩꽍 寃곌낵媛 鍮꾩뼱 ?덉뒿?덈떎.' };
  savedReports.unshift(report);
  savedReports = savedReports.slice(0, 60);
  saveStore();
  send('ai:report', report);
  return report;
}

function checkDataGaps() {
  if (!systemSettings.notifyDataGap || !Notification.isSupported()) return;
  const limitMs = Number(systemSettings.dataGapMinutes || 5) * 60 * 1000;
  for (const entry of serialPorts.values()) {
    if (!entry.port?.isOpen || entry.gapNotified) continue;
    if (Date.now() - Number(entry.lastReadingAt || Date.now()) < limitMs) continue;
    entry.gapNotified = true;
    new Notification({ title: `${entry.name}: sensor data paused`, body: `No new readings for ${systemSettings.dataGapMinutes || 5} minutes. Check Bluetooth and the Arduino output.`, icon: path.join(__dirname, 'assets', 'roomly.png') }).show();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1260, height: 860, minWidth: 920, minHeight: 650, backgroundColor: '#f4f6f8', icon: path.join(__dirname, 'assets', 'roomly.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.loadFile('index.html');
}

ipcMain.handle('ports:list', async () => {
  const ports = await SerialPort.list();
  return ports.map(port => ({ path: port.path, manufacturer: port.manufacturer || '', friendlyName: port.friendlyName || '', vendorId: port.vendorId || '', productId: port.productId || '' }));
});

async function openSerialPort(portPath, baudRate, reconnecting = false) {
  const entry = serialPorts.get(portPath);
  if (!entry) throw new Error(`Device entry for ${portPath} was removed.`);
  const port = new SerialPort({ path: portPath, baudRate: Number(baudRate), autoOpen: false });
  entry.port = port;
  await new Promise((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
  entry.pending = '';
  entry.sessionOpen = true;
  entry.lastReadingAt = Date.now();
  entry.gapNotified = false;
  entry.retries = 0;
  recordMonitoringEvent('serial-connect', { path: portPath, deviceId: entry.id, deviceName: entry.name, baudRate: Number(baudRate) });
  port.on('data', chunk => {
    entry.pending += chunk.toString('utf8');
    const lines = entry.pending.split(/\r?\n/);
    entry.pending = lines.pop().slice(-500);
    for (const line of lines) {
      const reading = parseSensorLine(line);
      if (reading) addReading(reading, entry);
      else if (line.trim()) { invalidSensorLines++; send('serial:diagnostics', { invalidSensorLines }); }
    }
  });
  port.on('error', error => {
    if (entry.port !== port) return;
    publishSerialStatus({ connected: false, path: portPath, error: error.message, reconnecting: Boolean(systemSettings.autoReconnect && entry.autoReconnect) });
    scheduleReconnect(entry, error.message);
  });
  port.on('close', () => {
    if (entry.port === port) entry.port = null;
    if (entry.sessionOpen) {
      entry.sessionOpen = false;
      recordMonitoringEvent('serial-disconnect', { path: portPath, deviceId: entry.id, deviceName: entry.name, reason: entry.manualDisconnect ? 'manual' : 'link-lost' });
    }
    publishSerialStatus({ connected: false, path: portPath });
    if (!entry.manualDisconnect) scheduleReconnect(entry, 'Serial port closed');
  });
  publishSerialStatus({ connected: true, path: portPath, deviceId: entry.id, deviceName: entry.name, baudRate: Number(baudRate), recovered: reconnecting });
  return { connected: true, path: portPath, deviceId: entry.id, deviceName: entry.name, baudRate: Number(baudRate), reconnecting, devices: getConnectedDevices() };
}

function getConnectedDevices() {
  return [...serialPorts.values()].filter(item => item.port?.isOpen).map(({ id, path, name, baudRate }) => ({ id, path, name, baudRate }));
}

function publishSerialStatus(status) {
  send('serial:status', { ...status, devices: getConnectedDevices() });
}

function getKnownDevices() {
  const devices = new Map();
  for (const item of sensorHistory) if (item.deviceId !== LEGACY_DEVICE_ID) devices.set(item.deviceId, { id: item.deviceId, name: item.deviceName || item.deviceId });
  for (const item of getConnectedDevices()) devices.set(item.id, { ...item, connected: true });
  return [...devices.values()];
}

function scheduleReconnect(entry, reason) {
  if (!systemSettings.autoReconnect || !entry.autoReconnect || entry.retryTimer || entry.manualDisconnect || !serialPorts.has(entry.path)) return;
  const attempt = ++entry.retries;
  const delay = Math.min(30000, 1000 * (2 ** Math.min(attempt - 1, 5)));
  publishSerialStatus({ connected: false, path: entry.path, deviceId: entry.id, deviceName: entry.name, error: reason, reconnecting: true, attempt, retryInMs: delay });
  entry.retryTimer = setTimeout(async () => {
    entry.retryTimer = null;
    if (!serialPorts.has(entry.path) || entry.manualDisconnect) return;
    try { await openSerialPort(entry.path, entry.baudRate, true); }
    catch (error) { scheduleReconnect(entry, error.message); }
  }, delay);
}

ipcMain.handle('serial:connect', async (_event, { path: portPath, baudRate = 9600, name }) => {
  if (!portPath) throw new Error('COM ?ы듃瑜??좏깮??二쇱꽭??');
  let entry = serialPorts.get(portPath);
  if (entry?.port?.isOpen) throw new Error(`${portPath} ?ы듃???대? ?곌껐?섏뼱 ?덉뒿?덈떎.`);
  if (!entry) {
    entry = { id: portPath, path: portPath, name: String(name || portPath).trim().slice(0, 40), baudRate: Number(baudRate), port: null, pending: '', retries: 0, retryTimer: null, autoReconnect: Boolean(systemSettings.autoReconnect), manualDisconnect: false, sessionOpen: false };
    serialPorts.set(portPath, entry);
  } else {
    clearTimeout(entry.retryTimer); entry.retryTimer = null; entry.manualDisconnect = false;
    entry.name = String(name || entry.name || portPath).trim().slice(0, 40); entry.baudRate = Number(baudRate);
  }
  try {
    const result = await openSerialPort(portPath, baudRate);
    lastSerialConnection = { path: portPath, baudRate: Number(baudRate), name: entry.name, autoConnect: true };
    saveStore();
    return result;
  }
  catch (error) { scheduleReconnect(entry, error.message); throw error; }
});

ipcMain.handle('serial:disconnect', async (_event, portPath) => {
  const targets = portPath ? [serialPorts.get(portPath)].filter(Boolean) : [...serialPorts.values()];
  for (const entry of targets) {
    entry.manualDisconnect = true;
    clearTimeout(entry.retryTimer); entry.retryTimer = null;
    if (entry.port?.isOpen) await new Promise(resolve => entry.port.close(() => resolve()));
    if (entry.sessionOpen) {
      entry.sessionOpen = false;
      recordMonitoringEvent('serial-disconnect', { path: entry.path, deviceId: entry.id, deviceName: entry.name, reason: 'manual' });
    }
    serialPorts.delete(entry.path);
    if (lastSerialConnection?.path === entry.path) lastSerialConnection.autoConnect = false;
  }
  if (targets.length) saveStore();
  publishSerialStatus({ connected: false, path: portPath || '' });
  return true;
});

ipcMain.handle('data:get', () => ({ history: sensorHistory, historyTruncated, thresholds, reports: savedReports, latest: latestReading || sensorHistory.at(-1) || null, hasAccount: Boolean(GEMINI_API_KEY && GEMINI_API_KEY !== 'PASTE_GEMINI_API_KEY_HERE'), weatherSettings: { ...weatherSettings, apiKey: undefined }, weather: weatherSnapshot, openAtLogin: app.getLoginItemSettings().openAtLogin, lightCalibration, notificationRepeatMinutes, systemSettings, alertHistory, monitoringEvents, lastDailyReviewStatus, appStartedAt, devices: getKnownDevices(), connectedDevices: getConnectedDevices(), diagnostics: { invalidSensorLines, lastSensorAt } }));
ipcMain.handle('system:save', async (_event, next) => {
  const sampleIntervalSeconds = Number(next.sampleIntervalSeconds), retentionDays = Number(next.retentionDays);
  const temperatureOffset = Number(next.temperatureOffset), humidityOffset = Number(next.humidityOffset), alertHoldSeconds = Number(next.alertHoldSeconds), dataGapMinutes = Number(next.dataGapMinutes || 5);
  if (![sampleIntervalSeconds, retentionDays, temperatureOffset, humidityOffset, alertHoldSeconds].every(Number.isFinite)) throw new Error('?쒖뒪???ㅼ젙 媛믪쓣 ?뺤씤?섏꽭??');
  if (![5, 10, 30, 60, 300].includes(sampleIntervalSeconds) || ![7, 30, 90].includes(retentionDays) || temperatureOffset < -10 || temperatureOffset > 10 || humidityOffset < -20 || humidityOffset > 20 || alertHoldSeconds < 0 || alertHoldSeconds > 600) throw new Error('???媛꾧꺽, 蹂닿? 湲곌컙, 蹂댁젙媛??먮뒗 ?뚮┝ ?湲??쒓컙???뺤씤?섏꽭??');
  const temperatureSensors = ['unspecified', 'DHT11', 'DHT22', 'SHT31', 'other'];
  const lightSensors = ['ldr', 'BH1750', 'other'];
  const deviceName = String(next.deviceName || 'Sensor profile').trim().slice(0, 40);
  const gasSensor = String(next.gasSensor || 'unspecified').trim().slice(0, 40);
  if (!temperatureSensors.includes(next.temperatureSensor) || !lightSensors.includes(next.lightSensor) || !deviceName || !gasSensor) throw new Error('?쇱꽌 ?꾨줈??媛믪쓣 ?뺤씤?섏꽭??');
  if (![2, 5, 10].includes(dataGapMinutes)) throw new Error('?곗씠???딄? ?먮떒 ?쒓컙? 2遺? 5遺? 10遺?以묒뿉???좏깮?섏꽭??');
  systemSettings = { sampleIntervalSeconds, retentionDays, temperatureOffset, humidityOffset, alertHoldSeconds, autoReconnect: Boolean(next.autoReconnect), notifyRecovery: Boolean(next.notifyRecovery), notifyDataGap: Boolean(next.notifyDataGap), dataGapMinutes, deviceName, temperatureSensor: next.temperatureSensor, gasSensor, lightSensor: next.lightSensor };
  for (const entry of serialPorts.values()) {
    entry.autoReconnect = Boolean(systemSettings.autoReconnect);
    if (!entry.autoReconnect) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
    else if (!entry.port?.isOpen && !entry.retryTimer) scheduleReconnect(entry, 'Waiting for sensor connection');
  }
  lastPersistedAt = Date.now() - sampleIntervalSeconds * 1000;
  for (const runtime of deviceRuntime.values()) runtime.lastPersistedAt = lastPersistedAt;
  await flushReadingWrites();
  const oldCount = sensorHistory.length;
  const retentionStart = Date.now() - retentionDays * 86400000;
  sensorHistory = sensorHistory.filter(item => Date.parse(item.timestamp) >= retentionStart).slice(-maxStoredRows());
  if (sensorHistory.length < oldCount) historyTruncated = true;
  const temporary = `${readingLogPath()}.tmp`;
  await fs.promises.writeFile(temporary, sensorHistory.map(item => JSON.stringify(item)).join('\n') + (sensorHistory.length ? '\n' : ''), 'utf8');
  await fs.promises.rename(temporary, readingLogPath());
  readingLogRows = sensorHistory.length;
  saveStore();
  return { systemSettings, historyTruncated, history: sensorHistory, latest: latestReading || sensorHistory.at(-1) || null };
});
ipcMain.handle('data:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, { title: '?쇱꽌 湲곕줉 ?대낫?닿린', defaultPath: `roomly-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Roomly JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), sensorHistory, historyTruncated, thresholds, savedReports, lightCalibration, systemSettings, alertHistory, monitoringEvents }, null, 2), 'utf8');
  return true;
});
ipcMain.handle('data:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Roomly 諛깆뾽 蹂듭썝', properties: ['openFile'], filters: [{ name: 'Roomly JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return false;
  const backup = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
  if (!Array.isArray(backup.sensorHistory)) throw new Error('諛깆뾽 ?뚯씪 ?뺤떇???щ컮瑜댁? ?딆뒿?덈떎.');
  if (backup.systemSettings && typeof backup.systemSettings === 'object') {
    const config = backup.systemSettings;
    if ([5, 10, 30, 60, 300].includes(Number(config.sampleIntervalSeconds)) && [7, 30, 90].includes(Number(config.retentionDays))
      && ['unspecified', 'DHT11', 'DHT22', 'SHT31', 'other'].includes(config.temperatureSensor) && ['ldr', 'BH1750', 'other'].includes(config.lightSensor)) {
      systemSettings = { ...systemSettings, ...config, deviceName: String(config.deviceName && config.deviceName !== 'Roomly' ? config.deviceName : 'Sensor profile').slice(0, 40), gasSensor: String(config.gasSensor || 'unspecified').slice(0, 40), temperatureOffset: Math.max(-10, Math.min(10, Number(config.temperatureOffset) || 0)), humidityOffset: Math.max(-20, Math.min(20, Number(config.humidityOffset) || 0)), alertHoldSeconds: Math.max(0, Math.min(600, Number(config.alertHoldSeconds) || 0)) };
    }
  }
  const valid = backup.sensorHistory.filter(item => item && Number.isFinite(Number(item.temperature)) && Number.isFinite(Number(item.humidity)) && Date.parse(item.timestamp));
  const existing = new Map(sensorHistory.map(item => [`${item.deviceId}:${item.timestamp}`, item]));
  for (const rawItem of valid) { const item = normalizeDeviceRecord(rawItem); existing.set(`${item.deviceId}:${item.timestamp}`, item); }
  const retentionStart = Date.now() - Math.max(1, Number(systemSettings.retentionDays) || 30) * 86400000;
  sensorHistory = [...existing.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).filter(item => Date.parse(item.timestamp) >= retentionStart).slice(-maxStoredRows());
  historyTruncated = Boolean(backup.historyTruncated) || backup.sensorHistory.length > 300000 || sensorHistory.length >= 300000;
  if (backup.thresholds && typeof backup.thresholds === 'object') {
    const candidate = { ...thresholds, ...backup.thresholds };
    const valid = [candidate.temperatureMin, candidate.temperatureMax, candidate.humidityMin, candidate.humidityMax].every(value => Number.isFinite(Number(value)))
      && Number(candidate.temperatureMin) >= -50 && Number(candidate.temperatureMax) <= 100 && Number(candidate.temperatureMin) < Number(candidate.temperatureMax)
      && Number(candidate.humidityMin) >= 0 && Number(candidate.humidityMax) <= 100 && Number(candidate.humidityMin) < Number(candidate.humidityMax);
    if (valid) thresholds = { ...candidate, gasRawMax: Math.max(0, Math.min(1023, Number(candidate.gasRawMax) || 700)), lightLuxLimit: Math.max(0, Math.min(200000, Number(candidate.lightLuxLimit) || 100)), lightLuxDirection: candidate.lightLuxDirection === 'above' ? 'above' : 'below' };
  }
  if (backup.lightCalibration && typeof backup.lightCalibration === 'object') lightCalibration = { ...lightCalibration, ...backup.lightCalibration };
  sensorHistory = sensorHistory.map(item => ({ ...normalizeDeviceRecord(item), ...(item.lightRaw == null ? {} : { lightLux: estimateLux(item.lightRaw) }) }));
  if (Array.isArray(backup.savedReports)) savedReports = [...backup.savedReports, ...savedReports].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(0, 60);
  if (Array.isArray(backup.alertHistory)) alertHistory = [...alertHistory, ...backup.alertHistory.filter(item => item && item.key && Date.parse(item.startedAt))].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(-2000);
  if (Array.isArray(backup.monitoringEvents)) monitoringEvents = [...monitoringEvents, ...backup.monitoringEvents.filter(item => item && item.type && Date.parse(item.timestamp))].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-1000);
  latestReading = sensorHistory.at(-1) || null;
  lastSensorAt = latestReading?.timestamp || null;
  lastPersistedAt = latestReading ? Date.parse(latestReading.timestamp) : 0;
  const temporary = `${readingLogPath()}.tmp`;
  fs.writeFileSync(temporary, sensorHistory.map(item => JSON.stringify(item)).join('\n') + (sensorHistory.length ? '\n' : ''), 'utf8');
  fs.renameSync(temporary, readingLogPath());
  readingLogRows = sensorHistory.length;
  saveStore();
  saveStore();
  send('data:restored', { history: sensorHistory, latest: sensorHistory.at(-1) || null, thresholds, reports: savedReports, lightCalibration, historyTruncated, systemSettings, alertHistory, monitoringEvents });
  return { imported: valid.length };
});
ipcMain.handle('notifications:repeat', (_event, minutes) => {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 5 || value > 1440) throw new Error('?뚮┝ 諛섎났 媛꾧꺽? 5遺꾩뿉??24?쒓컙 ?ъ씠濡??ㅼ젙?섏꽭??');
  notificationRepeatMinutes = value;
  saveStore();
  return notificationRepeatMinutes;
});
ipcMain.handle('light:save-calibration', (_event, settings) => {
  lightCalibration = {
    fixedResistorOhms: Math.max(100, Math.min(100000, Number(settings.fixedResistorOhms) || 10000)),
    resistanceAt10LuxOhms: Math.max(100, Math.min(10000000, Number(settings.resistanceAt10LuxOhms) || 15000)),
    gamma: Math.max(0.3, Math.min(1.2, Number(settings.gamma) || 0.7)),
    wiring: settings.wiring === 'ldr-low' ? 'ldr-low' : 'ldr-high',
  };
  sensorHistory = sensorHistory.map(item => ({ ...normalizeDeviceRecord(item), ...(item.lightRaw == null ? {} : { lightLux: estimateLux(item.lightRaw) }) }));
  saveStore();
  return lightCalibration;
});
ipcMain.handle('weather:save', async (_event, settings) => {
  weatherSettings = { ...weatherSettings, region: String(settings.region || '?쒖슱').slice(0, 30), nx: Math.max(1, Math.min(149, Number(settings.nx) || 60)), ny: Math.max(1, Math.min(253, Number(settings.ny) || 127)), stnId: Math.max(1, Number(settings.stnId) || 108), apiKey: String(settings.apiKey || weatherSettings.apiKey || '').trim() };
  saveStore(); await refreshWeather(); return { ...weatherSettings, apiKey: undefined };
});
ipcMain.handle('weather:refresh', refreshWeather);
ipcMain.handle('startup:set', (_event, enabled) => { app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath }); return app.getLoginItemSettings().openAtLogin; });
ipcMain.handle('notifications:settings', async () => { if (process.platform === 'win32') await shell.openExternal('ms-settings:notifications'); return true; });
ipcMain.handle('thresholds:save', (_event, next) => {
  if (![next.temperatureMin, next.temperatureMax, next.humidityMin, next.humidityMax].every(value => Number.isFinite(Number(value)))) throw new Error('?뚮┝ 湲곗?? ?レ옄濡??낅젰?섏꽭??');
  if (Number(next.temperatureMin) < -50 || Number(next.temperatureMax) > 100 || Number(next.temperatureMin) >= Number(next.temperatureMax) || Number(next.humidityMin) < 0 || Number(next.humidityMax) > 100 || Number(next.humidityMin) >= Number(next.humidityMax)) throw new Error('?⑤룄 ?먮뒗 ?듬룄 ?뚮┝ 踰붿쐞瑜??뺤씤?섏꽭??');
  thresholds = { temperatureMin: Number(next.temperatureMin), temperatureMax: Number(next.temperatureMax), humidityMin: Number(next.humidityMin), humidityMax: Number(next.humidityMax), gasRawMax: Math.max(0, Math.min(1023, Number.isFinite(Number(next.gasRawMax)) ? Number(next.gasRawMax) : 700)), lightLuxLimit: Math.max(0, Math.min(200000, Number.isFinite(Number(next.lightLuxLimit)) ? Number(next.lightLuxLimit) : 100)), lightLuxDirection: next.lightLuxDirection === 'above' ? 'above' : 'below' };
  saveStore();
  return thresholds;
});
ipcMain.handle('thresholds:reset', () => {
  thresholds = { ...DEFAULT_THRESHOLDS };
  saveStore();
  return thresholds;
});
ipcMain.handle('ai:analyze', (_event, range) => analyzeEnvironment('manual', range));
ipcMain.handle('notifications:test', () => {
  if (!Notification.isSupported()) throw new Error('Windows notifications are not available on this system.');
  new Notification({ title: 'Roomly notification test', body: 'Windows desktop notifications are working.', icon: path.join(__dirname, 'assets', 'roomly.png') }).show();
  return true;
});
ipcMain.handle('notifications:test-light', () => {
  if (!Notification.isSupported()) throw new Error('Windows ?뚮┝???ъ슜?????놁뒿?덈떎. Windows ?뚮┝ ?ㅼ젙???뺤씤??二쇱꽭??');
  const latest = [...sensorHistory].reverse().find(item => item.lightLux != null);
  if (!latest) throw new Error('?꾩쭅 議곕룄媛믪쓣 諛쏆? 紐삵뻽?듬땲?? ?쇱꽌 JSON??lightRaw ?먮뒗 CSV ??踰덉㎏ 媛믪쓣 ?뺤씤??二쇱꽭??');
  const limit = Number(thresholds.lightLuxLimit);
  const outside = thresholds.lightLuxDirection === 'above' ? latest.lightLux > limit : latest.lightLux < limit;
  new Notification({ title: 'Roomly 쨌 議곕룄 ?뚮┝ 誘몃━蹂닿린', body: `?꾩옱 ??${Number(latest.lightLux).toFixed(0)} lux 쨌 湲곗? ${limit} lux\n${outside ? '?꾩옱 議곕룄 ?뚮┝ 議곌굔???대떦?⑸땲??' : '?꾩옱 ?ㅼ젙 湲곗? 踰붿쐞 ?덉엯?덈떎.'}`, icon: path.join(__dirname, 'assets', 'roomly.png') }).show();
  return { lightLux: latest.lightLux, outside };
});
ipcMain.handle('app:open-external', async (_event, value) => {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol)) return false;
  await shell.openExternal(url.href);
  return true;
});

function updateDailyReviewStatus(message) {
  lastDailyReviewStatus = { message, timestamp: new Date().toISOString() };
  saveStore();
  send('ai:daily-status', lastDailyReviewStatus);
}

async function restoreLastSerialConnection() {
  if (!systemSettings.autoReconnect || !lastSerialConnection?.path || lastSerialConnection.autoConnect === false) return;
  const saved = lastSerialConnection;
  const entry = {
    id: saved.path, path: saved.path, name: String(saved.name || saved.path).slice(0, 40),
    baudRate: Number(saved.baudRate) || 9600, port: null, pending: '', retries: 0, retryTimer: null,
    autoReconnect: true, manualDisconnect: false, sessionOpen: false,
  };
  serialPorts.set(entry.path, entry);
  try { await openSerialPort(entry.path, entry.baudRate, true); }
  catch (error) { scheduleReconnect(entry, error.message); }
}

app.whenReady().then(() => {
  readStore();
  const lastLifecycle = [...monitoringEvents].reverse().find(item => item.type === 'app-stop' || item.type === 'app-start');
  if (lastLifecycle?.type === 'app-start') recordMonitoringEvent('app-restart-without-stop-record');
  recordMonitoringEvent('app-start');
  if (weatherSettings.apiKey && safeStorage.isEncryptionAvailable()) saveStore();
  createWindow();
  restoreLastSerialConnection();
  refreshWeather();
  setInterval(refreshWeather, 30 * 60 * 1000);
  setInterval(checkDataGaps, 15 * 1000);
  const dailyReview = async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (now.getHours() < 8 || lastDailyReportDate === today) return;
    const recentCount = sensorHistory.filter(item => Date.now() - Date.parse(item.timestamp) <= 24 * 60 * 60 * 1000).length;
    if (!recentCount) {
      const message = '?ㅻ뒛??AI ?붿빟??嫄대꼫?곗뿀?듬땲?? 理쒓렐 24?쒓컙 ?쇱꽌 湲곕줉???놁뼱 遺꾩꽍???곗씠?곌? ?놁뒿?덈떎. ?쇱꽌 ?곌껐怨??곗씠???섏떊???뺤씤??二쇱꽭??';
      if (lastDailyReviewStatus?.message !== message) updateDailyReviewStatus(message);
      return;
    }
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'PASTE_GEMINI_API_KEY_HERE' || lastDailyReportDate === today || !sensorHistory.length || new Date().getHours() < 8) return;
    try {
      await analyzeEnvironment('daily');
      lastDailyReportDate = today;
      updateDailyReviewStatus('?ㅻ뒛??AI ?쇱씪 ?붿빟??留뚮뱾?덉뒿?덈떎.');
      saveStore();
    } catch (error) {
      const message = `오늘의 AI 일일 요약을 건너뛰었습니다: ${error.message}`;
      updateDailyReviewStatus(message);
      console.error('Daily AI review skipped:', error.message);
    }
  };
  dailyReview();
  setInterval(dailyReview, 30 * 60 * 1000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', event => {
  if (!quitAfterReadingFlush) {
    event.preventDefault();
    quitAfterReadingFlush = true;
    recordMonitoringEvent('app-stop');
    for (const entry of serialPorts.values()) if (entry.sessionOpen) {
      entry.sessionOpen = false;
      recordMonitoringEvent('serial-disconnect', { path: entry.path, deviceId: entry.id, deviceName: entry.name, reason: 'app-closed' });
    }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeStore(); }
    flushReadingWrites().finally(() => app.quit());
    return;
  }
  for (const entry of serialPorts.values()) {
    entry.manualDisconnect = true;
    clearTimeout(entry.retryTimer);
    if (entry.port?.isOpen) entry.port.close();
  }
  if (saveTimer) { clearTimeout(saveTimer); writeStore(); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
