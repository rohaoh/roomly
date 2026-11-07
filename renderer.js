const appApi = window.roomApp;
const state = { history: [], thresholds: {}, reports: [], latest: null, latestByDevice: {}, devices: [], connectedDevices: [], selectedDeviceId: 'all', connected: false, portPath: '', weather: null, weatherSettings: {}, alertHistory: [], monitoringEvents: [], calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1), selectedCalendarDate: '', chartSeries: ['temperature', 'humidity', 'gasRaw', 'lightLux'] };
const $ = id => document.getElementById(id);

function toast(message, isError = false) {
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}

function openSettings() {
  $('settings-modal').classList.add('open');
  $('settings-modal').setAttribute('aria-hidden', 'false');
  refreshPorts();
}

function installNewControls() {
  const examples = document.querySelectorAll('.format-example code');
  if (examples[0]) examples[0].textContent = '{"temperature":24.5,"humidity":48,"gasRaw":700,"lightRaw":420}';
  if (examples[1]) examples[1].textContent = '24.5,48,700,420';
  const lightLimit = document.createElement('label'); lightLimit.textContent = '議곕룄 ?뚮┝ 湲곗?'; lightLimit.innerHTML += '<input type="number" min="0" max="200000" step="1" name="lightLuxLimit" required><span>lux</span>';
  $('threshold-form').insertBefore(lightLimit, $('threshold-form').querySelector('.form-submit'));
  const lightDirection = document.createElement('label'); lightDirection.textContent = '議곕룄 ?뚮┝ 議곌굔'; lightDirection.innerHTML += '<select name="lightLuxDirection"><option value="below">湲곗?蹂대떎 ?대몢????/option><option value="above">湲곗?蹂대떎 諛앹쓣 ??/option></select>';
  $('threshold-form').insertBefore(lightDirection, $('threshold-form').querySelector('.form-submit'));
  const lightTest = document.createElement('button'); lightTest.type = 'button'; lightTest.id = 'light-alert-test'; lightTest.className = 'button button-quiet'; lightTest.textContent = '議곕룄 ?뚮┝ 誘몃━蹂닿린';
  $('threshold-form').insertBefore(lightTest, $('threshold-form').querySelector('.form-submit'));
  const gasLimit = document.createElement('label'); gasLimit.textContent = '媛???쇱꽌 ?먯떆媛?湲곗?'; gasLimit.innerHTML += '<input type="number" min="0" max="1023" step="1" name="gasRawMax" required><span>raw</span>';
  $('threshold-form').insertBefore(gasLimit, $('threshold-form').querySelector('.form-submit'));
  const presetLabel = document.createElement('label');
  presetLabel.className = 'threshold-preset';
  presetLabel.append(document.createTextNode('怨듦컙 ?꾨━??(?⑥뒿??湲곗?) '));
  const preset = document.createElement('select'); preset.id = 'room-preset';
  preset.innerHTML = '<option value="">吏곸젒 ?ㅼ젙 ?좎?</option><option value="bedroom">移⑥떎</option><option value="living">嫄곗떎</option><option value="greenhouse">?⑥떎</option>';
  presetLabel.append(preset, document.createTextNode(' 媛?ㅒ룹“??湲곗?? ?좎??⑸땲??'));
  $('threshold-form').insertBefore(presetLabel, $('threshold-form').firstChild);
  preset.addEventListener('change', () => {
    const values = { bedroom: [18, 26, 40, 60], living: [18, 28, 30, 65], greenhouse: [20, 30, 50, 80] }[preset.value];
    if (!values) return;
    ['temperatureMin', 'temperatureMax', 'humidityMin', 'humidityMax'].forEach((key, index) => { $('threshold-form').elements[key].value = values[index]; });
  });
  const dashboard = $('dashboard-view');
  const weather = document.createElement('article');
  weather.className = 'panel'; weather.id = 'weather-panel';
  weather.innerHTML = '<div class="panel-heading"><div><h2>오늘의 날씨</h2><p id="weather-location">서울 · 기상청</p></div><button class="link-button" id="weather-refresh">새로고침</button></div><div class="weather-content"><strong id="weather-summary">API를 설정하면 날씨를 불러옵니다.</strong><span id="weather-details"></span></div><div id="weather-advisories" class="weather-advisories"></div>';
  dashboard.insertBefore(weather, dashboard.querySelector('.metric-grid'));
  const overview = document.createElement('section'); overview.className = 'device-overview panel'; overview.id = 'device-overview';
  overview.innerHTML = '<div class="panel-heading"><div><h2>기기 현황</h2><p id="device-overview-count">연결 0 · 등록 0</p></div><label class="device-filter-label">표시 기기 <select id="device-filter"><option value="all">모든 기기</option></select></label></div><div id="device-cards" class="device-cards"></div>';
  dashboard.querySelector('.status-banner').insertAdjacentElement('afterend', overview);
  $('device-filter').addEventListener('change', event => { state.selectedDeviceId = event.target.value; renderDashboard(); });
  const gas = document.createElement('article');
  gas.className = 'metric-card gas-card';
  gas.innerHTML = '<div class="metric-top"><div><span class="metric-label">가스 센서 값</span><div class="metric-value" id="current-gas">--<small>raw</small></div></div><div class="metric-icon">◉</div></div><div class="metric-foot"><span class="metric-state" id="gas-state">센서 연결 대기</span><span class="range-label">ADC 0–1023</span></div>';
  dashboard.querySelector('.metric-grid').append(gas);
  const light = document.createElement('article');
  light.className = 'metric-card light-card';
  light.innerHTML = '<div class="metric-top"><div><span class="metric-label">조도 센서 밝기</span><div class="metric-value" id="current-light">--<small>lux*</small></div></div><div class="metric-icon">☼</div></div><div class="metric-foot"><span class="metric-state" id="light-state">센서 연결 대기</span><span class="range-label">ADC 0–1023</span></div>';
  dashboard.querySelector('.metric-grid').append(light);
  const chart = $('history-chart');
  const roomChartList = document.createElement('div'); roomChartList.id = 'room-chart-list'; roomChartList.className = 'room-chart-list hidden';
  chart.insertAdjacentElement('afterend', roomChartList);
  chart.querySelectorAll('.axis-label').forEach(label => { if (Number(label.getAttribute('x')) < 30) label.remove(); });
  for (const series of ['gasRaw', 'lightLux']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.id = series === 'gasRaw' ? 'gas-path' : 'light-path'; path.setAttribute('class', `chart-line ${series === 'gasRaw' ? 'gas-line' : 'light-line'}`); path.setAttribute('d', ''); chart.append(path);
  }
  const legend = document.querySelector('.chart-legend'); legend.replaceChildren();
  const seriesOptions = [
    { key: 'temperature', label: '온도', color: 'temp-legend' },
    { key: 'humidity', label: '습도', color: 'humidity-legend' },
    { key: 'gasRaw', label: 'Gas', color: 'gas-legend' },
    { key: 'lightLux', label: '조도 (lux)', color: 'light-legend' },
  ];
  try {
    const savedSeries = JSON.parse(localStorage.getItem('chart-series') || 'null');
    if (Array.isArray(savedSeries)) state.chartSeries = savedSeries.filter(key => seriesOptions.some(series => series.key === key));
  } catch { /* Use all series by default. */ }
  for (const series of seriesOptions) {
    const label = document.createElement('label'); label.className = 'chart-series-toggle';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.chartSeries.includes(series.key);
    input.addEventListener('change', () => {
      state.chartSeries = [...document.querySelectorAll('.chart-series-toggle input:checked')].map(control => control.value);
      localStorage.setItem('chart-series', JSON.stringify(state.chartSeries)); renderChart(periodHistory());
    });
    input.value = series.key;
    const dot = document.createElement('i'); dot.className = `legend-dot ${series.color}`;
    label.append(input, dot, document.createTextNode(series.label)); legend.append(label);
  }
  const scaleNote = document.createElement('span'); scaleNote.className = 'chart-scale-note'; scaleNote.textContent = '?쇱꽌蹂?蹂??異붿씠'; legend.append(scaleNote);
  document.querySelector('.chart-panel .panel-heading p').textContent = 'Sensor trends by metric';
  const settings = $('settings-modal').querySelector('.modal-footer');
  const section = document.createElement('div'); section.className = 'settings-section';
  section.innerHTML = '<div class="settings-title"><div><h3>湲곗긽泥??좎뵪 諛??밸낫</h3><p>怨듦났?곗씠?고룷?몄뿉???④린?덈낫쨌湲곗긽?밸낫 API瑜??좎껌?섍퀬 ?ㅻ? ?낅젰?섏꽭??</p></div></div><div class="weather-settings"><label>吏??챸<input id="weather-region" value="?쒖슱" maxlength="30"></label><label>?덈낫 寃⑹옄 X<input id="weather-nx" type="number" value="60" min="1" max="149"></label><label>?덈낫 寃⑹옄 Y<input id="weather-ny" type="number" value="127" min="1" max="253"></label><label>?밸낫 吏??肄붾뱶<input id="weather-stn" type="number" value="108"></label><label class="wide">怨듦났?곗씠?고룷???쒕퉬?ㅽ궎<input id="weather-key" type="password" placeholder="諛쒓툒諛쏆? ?쒕퉬?ㅽ궎"></label><button class="button button-dark" id="save-weather">湲곗긽泥??ㅼ젙 ???/button></div><div class="inline-status">API ?ㅻ뒗 Windows ?ъ슜??怨꾩젙??蹂댄샇 湲곕뒫?쇰줈 ?뷀샇?뷀빐 ??ν빀?덈떎.</div></div><div class="settings-section"><div class="settings-title"><div><h3>Windows ?뚮┝ 諛??쒖옉</h3><p>Windows ?뚮┝ 沅뚰븳??爰쇱졇 ?덉쑝硫??쒖뒪???ㅼ젙?먯꽌 Roomly ?뚮┝???덉슜?섏꽭??</p></div></div><label class="startup-toggle"><input id="startup-enabled" type="checkbox"> Windows 濡쒓렇????Roomly ?먮룞 ?ㅽ뻾</label><button class="link-button" id="open-notification-settings">Windows ?뚮┝ ?ㅼ젙 ?닿린</button></div>';
  settings.parentElement.insertBefore(section, settings);
  const lightSection = document.createElement('div'); lightSection.className = 'settings-section';
  lightSection.innerHTML = '<div class="settings-title"><div><h3>CDS 議곕룄 蹂댁젙</h3><p>10k廓 遺꾩븬 湲곗? 異붿젙媛믪엯?덈떎. ?ㅼ젣 CDS 遺?덈퀎 ?몄감媛 ?덉뼱 lux 痢≪젙湲곗? 鍮꾧탳??蹂댁젙?섏꽭??</p></div></div><div class="weather-settings"><label>怨좎젙 ???廓)<input id="ldr-fixed" type="number" min="100" value="10000"></label><label>CDS ???@ 10 lux (廓)<input id="ldr-r10" type="number" min="100" value="15000"></label><label>媛먮쭏(湲곕낯 0.7)<input id="ldr-gamma" type="number" min="0.3" max="1.2" step="0.01" value="0.7"></label><label>遺꾩븬湲?諛곗튂<select id="ldr-wiring"><option value="ldr-high">5V ??CDS ??A0 ??10k廓 ??GND</option><option value="ldr-low">5V ??10k廓 ??A0 ??CDS ??GND</option></select></label><button class="button button-dark" id="save-ldr">議곕룄 蹂댁젙 ???/button></div><div class="inline-status">ADC ?먯떆媛믩룄 ?④퍡 湲곕줉?⑸땲?? 異붿젙 lux???뺣? 怨꾩륫?⑹씠 ?꾨떃?덈떎.</div>';
  settings.parentElement.insertBefore(lightSection, settings);
  $('weather-refresh').addEventListener('click', () => appApi.refreshWeather());
  $('save-weather').addEventListener('click', async () => {
    try {
      state.weatherSettings = await appApi.saveWeather({ region: $('weather-region').value, nx: $('weather-nx').value, ny: $('weather-ny').value, stnId: $('weather-stn').value, apiKey: $('weather-key').value });
      $('weather-key').value = ''; toast('湲곗긽泥??ㅼ젙????ν뻽?듬땲??');
    } catch (error) { toast(error.message, true); }
  });
  $('light-alert-test').addEventListener('click', async () => {
    try {
      const result = await appApi.testLightAlert();
      toast(result.outside ? `?꾩옱 議곕룄 ${Number(result.lightLux).toFixed(0)} lux 쨌 ?뚮┝ 湲곗????대떦?⑸땲??` : `?꾩옱 議곕룄 ${Number(result.lightLux).toFixed(0)} lux 쨌 ?ㅼ젙 踰붿쐞 ?덉엯?덈떎.`);
    } catch (error) { toast(error.message, true); }
  });
  $('save-ldr').addEventListener('click', async () => {
    try {
      state.lightCalibration = await appApi.saveLightCalibration({ fixedResistorOhms: $('ldr-fixed').value, resistanceAt10LuxOhms: $('ldr-r10').value, gamma: $('ldr-gamma').value, wiring: $('ldr-wiring').value });
      state.history = state.history.map(item => item.lightRaw == null ? item : { ...item, lightLux: estimateLux(item.lightRaw, state.lightCalibration) });
      state.latest = state.history.at(-1) || state.latest; renderDashboard(); toast('議곕룄 蹂댁젙媛믪쓣 ??ν뻽?듬땲??');
    } catch (error) { toast(error.message, true); }
  });
  $('startup-enabled').addEventListener('change', async event => { try { event.target.checked = await appApi.setStartup(event.target.checked); toast(event.target.checked ? '濡쒓렇?????먮룞 ?ㅽ뻾??耳곗뒿?덈떎.' : '濡쒓렇?????먮룞 ?ㅽ뻾??猿먯뒿?덈떎.'); } catch (error) { toast(error.message, true); } });
  $('open-notification-settings').addEventListener('click', () => appApi.openNotificationSettings());
}

function installQualityControls() {
  const banner = $('status-banner');
  const freshness = document.createElement('small'); freshness.id = 'sensor-freshness'; freshness.className = 'inline-status';
  banner.insertAdjacentElement('afterend', freshness);
  const historyHead = document.querySelector('#history-view .welcome-row');
  const tools = document.createElement('div'); tools.className = 'data-tools';
  tools.innerHTML = '<label>시작일 <input type="date" id="csv-start"></label><label>종료일 <input type="date" id="csv-end"></label><button class="button button-outline" id="backup-export">백업 내보내기</button><button class="button button-outline" id="backup-import">백업 복원</button>';
  historyHead.insertAdjacentElement('afterend', tools);
  const diagnostics = document.createElement('div'); diagnostics.className = 'panel'; diagnostics.id = 'diagnostics-panel'; diagnostics.style.cssText = 'padding:14px 18px;margin:0 0 14px;font-size:10px;color:#64726c';
  diagnostics.textContent = '센서 진단 정보를 불러오는 중입니다.';
  document.querySelector('#history-view .history-panel').insertAdjacentElement('beforebegin', diagnostics);
  const activity = document.createElement('div'); activity.className = 'activity-grid';
  activity.innerHTML = '<section class="panel activity-panel"><div class="panel-heading"><div><h2>측정 기록 달력</h2><p>측정 데이터와 연결이 끊긴 날짜를 확인합니다.</p></div><div class="calendar-nav"><button class="button button-quiet" id="calendar-prev" aria-label="이전 달">←</button><strong id="calendar-month"></strong><button class="button button-quiet" id="calendar-next" aria-label="다음 달">→</button></div></div><div class="calendar-weekdays"><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span><span>일</span></div><div class="calendar-days" id="calendar-days"></div><div class="calendar-legend"><span class="legend-good"></span>기록 있음 <span class="legend-gap"></span>측정 중단 <span class="legend-none"></span>기록 없음</div><div id="calendar-detail" class="calendar-detail">날짜를 선택하면 측정 및 연결 상태가 표시됩니다.</div></section><section class="panel activity-panel"><div class="panel-heading"><div><h2>알림 기록</h2><p>기준 이탈 알림 기록을 확인합니다.</p></div></div><div id="alarm-history" class="alarm-history"></div></section></div>';
  diagnostics.insertAdjacentElement('afterend', activity);
  $('calendar-prev').addEventListener('click', () => { state.calendarMonth.setMonth(state.calendarMonth.getMonth() - 1); renderDataCalendar(); });
  $('calendar-next').addEventListener('click', () => { state.calendarMonth.setMonth(state.calendarMonth.getMonth() + 1); renderDataCalendar(); });
  const notifySection = document.createElement('div'); notifySection.className = 'settings-section';
  notifySection.innerHTML = '<div class="settings-title"><div><h3>?뚮┝ 諛섎났 媛꾧꺽</h3><p>湲곗? ?댄깉??怨꾩냽?????ㅼ떆 ?뚮━??媛꾧꺽?낅땲??</p></div></div><label>諛섎났 媛꾧꺽 <select id="notification-repeat"><option value="5">5遺?/option><option value="15">15遺?/option><option value="30">30遺?/option><option value="60">1?쒓컙</option><option value="240">4?쒓컙</option><option value="1440">24?쒓컙</option></select></label><button class="button button-quiet" id="save-notification-repeat">媛꾧꺽 ???/button>';
  $('settings-modal').querySelector('.modal-footer').insertAdjacentElement('beforebegin', notifySection);
  const systemSection = document.createElement('div'); systemSection.className = 'settings-section';
  systemSection.innerHTML = '<div class="settings-title"><div><h3>湲곕줉쨌?쇱꽌 ?덉쭏쨌蹂듦뎄</h3><p>湲곕낯 30珥?媛꾧꺽?쇰줈 ??ν븯怨?理쒓렐 30??湲곕줉??蹂닿??⑸땲?? ?뚮┝? 湲곗? ?댄깉???ㅼ젙 ?쒓컙 ?좎??????몃┰?덈떎.</p></div></div><div class="system-settings-grid"><label>湲곌린 ?대쫫<input id="device-name" maxlength="40"></label><label>?⑥뒿???쇱꽌<select id="temperature-sensor"><option value="unspecified">誘몄???/option><option value="DHT11">DHT11</option><option value="DHT22">DHT22 / AM2302</option><option value="SHT31">SHT31</option><option value="other">湲고?</option></select></label><label>媛???쇱꽌 紐⑤뜽<input id="gas-sensor" maxlength="40" placeholder="紐⑤뜽紐??먮뒗 誘몄???></label><label>議곕룄 ?쇱꽌<select id="light-sensor"><option value="ldr">LDR ???遺꾩븬</option><option value="BH1750">BH1750</option><option value="other">湲고?</option></select></label><label>???媛꾧꺽<select id="sample-interval"><option value="5">5珥?/option><option value="10">10珥?/option><option value="30">30珥?/option><option value="60">1遺?/option><option value="300">5遺?/option></select></label><label>蹂닿? 湲곌컙<select id="retention-days"><option value="7">7??/option><option value="30">30??/option><option value="90">90??/option></select></label><label>?⑤룄 蹂댁젙<input id="temperature-offset" type="number" min="-10" max="10" step="0.1"> 째C</label><label>?듬룄 蹂댁젙<input id="humidity-offset" type="number" min="-20" max="20" step="1"> %</label><label>?뚮┝ 吏???쒓컙<select id="alert-hold"><option value="0">利됱떆</option><option value="30">30珥?/option><option value="60">1遺?/option><option value="300">5遺?/option><option value="600">10遺?/option></select></label><label class="system-check"><input id="auto-reconnect" type="checkbox"> ?곌껐 ?딄? ???먮룞 ?ъ뿰寃?/label><label class="system-check"><input id="notify-recovery" type="checkbox"> 湲곗? 踰붿쐞 蹂듦? ?뚮┝</label></div><button class="button button-quiet" id="save-system-settings">?쒖뒪???ㅼ젙 ???/button><div class="inline-status">?쇱꽌 紐⑤뜽 ?쒖떆??湲곕줉???꾨줈?꾩엯?덈떎. Arduino ?怨?異쒕젰 ?뺤떇? ?대떦 蹂대뱶???뚯썾?댁뿉???ㅼ젙?댁빞 ?⑸땲??</div>';
  const gapToggle = document.createElement('label'); gapToggle.className = 'system-check';
  gapToggle.innerHTML = '<input id="notify-data-gap" type="checkbox"> ?쇱꽌 ?곗씠?곌? ?딄린硫??뚮┝';
  const gapDelay = document.createElement('label'); gapDelay.textContent = '?딄? ?먮떒 ?쒓컙 ';
  gapDelay.innerHTML += '<select id="data-gap-minutes"><option value="2">2遺?/option><option value="5">5遺?/option><option value="10">10遺?/option></select>';
  systemSection.querySelector('.system-settings-grid').append(gapToggle, gapDelay);
  const reconnectNote = document.createElement('p'); reconnectNote.className = 'inline-status';
  reconnectNote.textContent = '자동 재연결을 켜면 다음 앱 실행 때 마지막 블루투스 포트도 다시 연결합니다. 앱에서 직접 연결을 해제하면 자동 연결은 멈춥니다.';
  systemSection.querySelector('.system-settings-grid').insertAdjacentElement('afterend', reconnectNote);
  $('settings-modal').querySelector('.modal-footer').insertAdjacentElement('beforebegin', systemSection);
  const trend = document.createElement('select'); trend.id = 'chart-period'; trend.className = 'select-like'; trend.setAttribute('aria-label', '洹몃옒??湲곌컙');
  trend.innerHTML = '<option value="1">理쒓렐 1?쒓컙</option><option value="24">理쒓렐 24?쒓컙</option><option value="168">理쒓렐 7??/option><option value="720">理쒓렐 30??/option>';
  $('chart-range').replaceWith(trend);
  const trendSummary = document.createElement('div'); trendSummary.id = 'trend-summary'; trendSummary.className = 'trend-summary';
  document.querySelector('.chart-panel').append(trendSummary);
  $('chart-period').addEventListener('change', () => { localStorage.setItem('chart-period', $('chart-period').value); updateChartAxisLabels(); renderChart(periodHistory()); renderTrendSummary(); });
  const reviewStatus = document.createElement('div'); reviewStatus.id = 'daily-review-status'; reviewStatus.className = 'inline-status hidden'; reviewStatus.setAttribute('role', 'status');
  $('report-panel').insertAdjacentElement('beforebegin', reviewStatus);
  $('backup-export').addEventListener('click', async () => { try { if (await appApi.exportData()) toast('백업 파일을 저장했습니다.'); } catch (error) { toast(error.message, true); } });
  $('backup-import').addEventListener('click', async () => { try { const result = await appApi.importData(); if (result) toast(`${result.imported}건의 기록을 복원했습니다.`); } catch (error) { toast(error.message, true); } });
  $('save-notification-repeat').addEventListener('click', async () => { try { state.notificationRepeatMinutes = await appApi.setNotificationRepeat($('notification-repeat').value); toast('?뚮┝ 諛섎났 媛꾧꺽????ν뻽?듬땲??'); } catch (error) { toast(error.message, true); } });
  $('save-system-settings').addEventListener('click', async () => {
    try {
      const result = await appApi.saveSystemSettings({ deviceName: $('device-name').value, temperatureSensor: $('temperature-sensor').value, gasSensor: $('gas-sensor').value, lightSensor: $('light-sensor').value, sampleIntervalSeconds: $('sample-interval').value, retentionDays: $('retention-days').value, temperatureOffset: $('temperature-offset').value, humidityOffset: $('humidity-offset').value, alertHoldSeconds: $('alert-hold').value, autoReconnect: $('auto-reconnect').checked, notifyRecovery: $('notify-recovery').checked, notifyDataGap: $('notify-data-gap').checked, dataGapMinutes: $('data-gap-minutes').value });
      state.systemSettings = result.systemSettings; state.history = result.history; state.latest = result.latest; state.historyTruncated = result.historyTruncated;
      toast('?쇱꽌쨌湲곕줉 ?ㅼ젙????ν뻽?듬땲?? ??痢≪젙遺??蹂댁젙媛믪씠 ?곸슜?⑸땲??'); renderDashboard(); renderDiagnostics();
    } catch (error) { toast(error.message, true); }
  });
}

function periodHistory() {
  const hours = Number($('chart-period')?.value || 24);
  const since = Date.now() - hours * 60 * 60 * 1000;
  return currentDeviceHistory().filter(item => Date.parse(item.timestamp) >= since);
}

function updateChartAxisLabels() {
  const hours = Number($('chart-period')?.value || 24);
  const labels = $('history-chart')?.querySelectorAll('.axis-label');
  if (!labels) return;
  const timeLabels = [...labels].filter(label => Number(label.getAttribute('x')) >= 30);
  if (timeLabels.length >= 3) {
    timeLabels[0].textContent = hours >= 24 ? `${hours} hours ago` : `${hours * 60} minutes ago`;
    timeLabels[1].textContent = hours >= 24 ? `${hours / 2} hours ago` : `${hours * 30} minutes ago`;
    timeLabels[2].textContent = '?꾩옱';
  }
}

function renderTrendSummary() {
  const target = $('trend-summary');
  if (!target) return;
  if (state.selectedDeviceId === 'all' && state.devices.length > 1) {
    target.replaceChildren();
    for (const device of state.devices) {
      const rows = periodHistory().filter(item => (item.deviceId || 'legacy') === device.id);
      const summary = document.createElement('div');
      summary.className = 'room-trend-summary';
      const title = document.createElement('strong'); title.textContent = device.name || device.id;
      const text = document.createElement('span');
      const stats = key => {
        const values = rows.map(item => Number(item[key])).filter(Number.isFinite);
        return values.length ? `${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)} ?됯퇏 쨌 ${Math.min(...values).toFixed(1)} 理쒖? 쨌 ${Math.max(...values).toFixed(1)} 理쒓퀬` : '湲곕줉 ?놁쓬';
      };
      text.textContent = `${rows.length.toLocaleString()}??쨌 ?⑤룄 ${stats('temperature')}째C 쨌 ?듬룄 ${stats('humidity')}%`;
      summary.append(title, text); target.append(summary);
    }
    return;
  }
  target.replaceChildren();
  const items = periodHistory();
  const stats = key => {
    if (!items.length) return '--';
    const values = items.map(item => Number(item[key])).filter(Number.isFinite);
    if (!values.length) return '--';
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return `${mean.toFixed(1)} avg 쨌 ${Math.min(...values).toFixed(1)} min 쨌 ${Math.max(...values).toFixed(1)} max`;
  };
  target.textContent = `${items.length.toLocaleString()} samples 쨌 Temperature ${stats('temperature')} 째C 쨌 Humidity ${stats('humidity')} %`;
}

function renderDiagnostics() {
  if (!$('diagnostics-panel')) return;
  const ports = state.portPath ? `${state.portPath} · ${$('baud-select')?.value || 9600} baud` : '선택된 포트 없음';
  const currentReading = currentDeviceLatest();
  const age = currentReading?.timestamp ? Math.max(0, Math.floor((Date.now() - Date.parse(currentReading.timestamp)) / 1000)) : null;
  const freshLimit = Math.max(45, Number(state.systemSettings?.sampleIntervalSeconds || 30) * 2.5);
  const stale = age == null || age >= freshLimit;
  const freshness = age == null ? '측정 기록 없음' : age < freshLimit ? `${age}초 전 측정` : `측정 지연 · 마지막 측정 ${Math.floor(age / 60)}분 전`;
  const profile = state.systemSettings ? `${state.systemSettings.deviceName} · ${state.systemSettings.temperatureSensor}/${state.systemSettings.gasSensor}/${state.systemSettings.lightSensor}` : '센서 프로필 없음';
  $('diagnostics-panel').textContent = `센서 프로필 ${profile} · ${ports} · ${state.connected ? '포트 연결됨' : '포트 연결 끊김'} · ${freshness} · 잘못된 데이터 ${state.diagnostics?.invalidSensorLines || 0}건 · 품질 경고 ${state.qualityEventCount || 0}건${state.historyTruncated ? ' · 보관 기간이 지난 기록이 삭제됨' : ''}${state.lastSerialError ? ` · 마지막 오류: ${state.lastSerialError}` : ''}`;
  $('sensor-freshness').textContent = freshness;
  $('sensor-freshness').classList.toggle('warning-state', stale);
  document.querySelector('.live-pill').classList.toggle('offline', !state.connected || stale);
  if (state.connected && stale) document.querySelector('.live-pill').innerHTML = '<span></span> Sensor data delayed';
  else if (state.connected) document.querySelector('.live-pill').innerHTML = '<span></span> Live monitoring';
}

setInterval(() => { renderDiagnostics(); }, 1000);

function renderWeather(snapshot = state.weather) {
  if (!snapshot) return;
  $('weather-location').textContent = `${state.weatherSettings.region || '서울'} · 기상청`;
  const weather = snapshot.weather;
  if (!weather) { $('weather-summary').textContent = snapshot.error || 'Weather data unavailable'; return; }
  $('weather-summary').textContent = `${weather.temperature ?? '--'}°C · ${weather.sky || '날씨'}${weather.pty && weather.pty !== '0' ? ' · 강수' : ''}`;
  $('weather-details').textContent = `오늘 최저 ${weather.min ?? '--'}° · 최고 ${weather.max ?? '--'}° · 강수 확률 ${weather.pop ?? '--'}%`;
  const list = $('weather-advisories'); list.replaceChildren();
  const advisories = snapshot.advisories || [];
  if (!advisories.length) { list.textContent = snapshot.error || 'No active weather advisories'; return; }
  for (const item of advisories) { const badge = document.createElement('div'); badge.className = 'weather-advisory'; badge.textContent = item.t1 || item.title || item.t2 || JSON.stringify(item); list.append(badge); }
}
function closeSettings() {
  $('settings-modal').classList.remove('open');
  $('settings-modal').setAttribute('aria-hidden', 'true');
}

function estimateLux(adc, calibration = state.lightCalibration || {}) {
  const value = Math.max(1, Math.min(1022, Number(adc)));
  const fixed = Number(calibration.fixedResistorOhms) || 10000;
  const resistance = calibration.wiring === 'ldr-low' ? fixed * value / (1023 - value) : fixed * (1023 - value) / value;
  const r10 = Number(calibration.resistanceAt10LuxOhms) || 15000;
  const gamma = Number(calibration.gamma) || 0.7;
  return Math.max(0, Math.min(200000, 10 * Math.pow(resistance / r10, -1 / gamma)));
}

function showView(viewName) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `${viewName}-view`));
  document.querySelectorAll('.nav-item[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === viewName));
  $('page-name').textContent = ({ dashboard: 'Dashboard', history: 'History', insights: 'AI insights' })[viewName] || 'Dashboard';
}

function setConnection(status) {
  const wasReconnecting = state.reconnecting;
  state.reconnecting = Boolean(status.reconnecting && !status.connected);
  if (Array.isArray(status.devices)) state.connectedDevices = status.devices;
  else if (status.connected && status.path) state.connectedDevices = [...state.connectedDevices.filter(item => item.path !== status.path), { id: status.deviceId || status.path, path: status.path, name: status.deviceName || status.path, baudRate: status.baudRate || 9600 }];
  else if (status.path && !status.connected) state.connectedDevices = state.connectedDevices.filter(item => item.path !== status.path);
  state.connected = state.connectedDevices.length > 0;
  state.devices = [...new Map([...state.devices, ...state.connectedDevices.map(item => ({ id: item.id, name: item.name, path: item.path, connected: true }))].map(item => [item.id, { ...item, ...(state.connectedDevices.find(device => device.id === item.id) || {}) }])).values()];
  state.portPath = status.path || state.portPath;
  $('device-dot').classList.toggle('connected', state.connected);
  document.querySelector('.live-pill').classList.toggle('offline', !state.connected);
  document.querySelector('.live-pill').innerHTML = `<span></span> ${state.connected ? `${state.connectedDevices.length} connected` : 'Waiting for sensor'}`;
  $('device-label').textContent = state.connected ? `${state.connectedDevices.length} device(s) connected` : 'Waiting for connection';
  $('device-sub').textContent = state.connected ? state.connectedDevices.map(item => item.path).join(', ') : 'Arduino + HC-06';
  $('dashboard-connect').innerHTML = 'Connect device <span>?</span>';
  $('connect-button').textContent = 'Add device';
  renderDeviceConnections(); renderDeviceOverview();
  if (status.error) {
    state.lastSerialError = status.error;
    $('connection-message').textContent = status.reconnecting ? `${status.error} ? retry ${status.attempt || ''} in ${Math.ceil((status.retryInMs || 0) / 1000)}s` : status.error;
    if (!status.reconnecting) toast(`Serial connection error: ${status.error}`, true);
  } else if (status.connected) {
    $('connection-message').textContent = `${status.path} connected. Waiting for sensor data.`;
    if (status.recovered || wasReconnecting) toast('Sensor connection restored.');
  } else if (!status.error) {
    $('connection-message').textContent = 'Arduino should send one JSON or comma-separated reading per line.';
  }
  renderDashboard();
}

function renderDeviceConnections() {
  const target = $('connected-devices');
  if (!target) return;
  target.replaceChildren();
  if (!state.connectedDevices.length) { target.textContent = 'No connected devices'; return; }
  for (const device of state.connectedDevices) {
    const row = document.createElement('div'); row.className = 'connected-device-row';
    const label = document.createElement('span'); label.textContent = `${device.name} ? ${device.path} ? ${device.baudRate} baud`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'link-button'; button.textContent = 'Disconnect';
    button.addEventListener('click', async () => { try { await appApi.disconnect(device.path); } catch (error) { toast(error.message, true); } });
    row.append(label, button); target.append(row);
  }
}

function renderDeviceOverview() {
  const cards = $('device-cards');
  if (!cards) return;
  const filter = $('device-filter');
  const previous = filter.value;
  const latestById = {};
  for (const item of state.history) {
    const id = item.deviceId || 'legacy';
    if (!latestById[id] || Date.parse(item.timestamp) > Date.parse(latestById[id].timestamp)) latestById[id] = item;
  }
  const connectedIds = new Set(state.connectedDevices.map(item => item.id));
  filter.replaceChildren(new Option('All devices', 'all'));
  for (const device of state.devices) filter.add(new Option(device.name || device.id, device.id));
  filter.value = [...filter.options].some(option => option.value === previous) ? previous : (state.devices[0]?.id || 'all');
  state.selectedDeviceId = filter.value;
  cards.replaceChildren();
  $('device-overview-count').textContent = `연결 ${state.connectedDevices.length}대 · 등록 ${state.devices.length}대`;
  if (!state.devices.length) { const empty = document.createElement('p'); empty.className = 'device-empty'; empty.textContent = '센서를 연결하면 측정값을 확인할 수 있어요.'; cards.append(empty); return; }
  for (const device of state.devices) {
    const reading = latestById[device.id];
    const card = document.createElement('article'); card.className = `device-reading-card${connectedIds.has(device.id) ? ' device-online' : ''}`;
    const name = document.createElement('strong'); name.textContent = device.name || device.id;
    const port = document.createElement('small'); port.textContent = device.path || device.id;
    const values = document.createElement('div'); values.className = 'device-reading-values';
    values.textContent = reading ? `${Number(reading.temperature).toFixed(1)}°C · ${Number(reading.humidity).toFixed(0)}%` : '측정 대기 중';
    const status = document.createElement('small'); status.textContent = connectedIds.has(device.id) ? '연결됨' : reading ? `마지막 측정 ${formatTime(reading.timestamp)}` : '연결 끊김';
    card.append(name, port, values, status); cards.append(card);
  }
}

function currentDeviceHistory() {
  return state.selectedDeviceId === 'all' ? state.history : state.history.filter(item => (item.deviceId || 'legacy') === state.selectedDeviceId);
}

function currentDeviceConnected() {
  return state.selectedDeviceId === 'all' ? state.connectedDevices.length > 0 : state.connectedDevices.some(item => item.id === state.selectedDeviceId);
}

function currentDeviceLatest() {
  if (state.selectedDeviceId !== 'all' && state.latestByDevice[state.selectedDeviceId]) return state.latestByDevice[state.selectedDeviceId];
  return currentDeviceHistory().at(-1) || state.latest;
}

function currentAlerts(reading) {
  const t = state.thresholds;
  const alerts = [];
  if (reading.temperature < Number(t.temperatureMin)) alerts.push(`?⑤룄 ??쓬 (${reading.temperature.toFixed(1)}째C)`);
  if (reading.temperature > Number(t.temperatureMax)) alerts.push(`?⑤룄 ?믪쓬 (${reading.temperature.toFixed(1)}째C)`);
  if (reading.humidity < Number(t.humidityMin)) alerts.push(`?듬룄 ??쓬 (${reading.humidity.toFixed(0)}%)`);
  if (reading.humidity > Number(t.humidityMax)) alerts.push(`?듬룄 ?믪쓬 (${reading.humidity.toFixed(0)}%)`);
  if (reading.gasRaw != null && reading.gasRaw >= Number(t.gasRawMax ?? 700)) alerts.push(`媛???쇱꽌 ?먯떆媛??믪쓬 (${reading.gasRaw} raw)`);
  if (reading.lightLux != null && ((t.lightLuxDirection === 'above' && reading.lightLux > Number(t.lightLuxLimit ?? 100)) || (t.lightLuxDirection !== 'above' && reading.lightLux < Number(t.lightLuxLimit ?? 100)))) alerts.push(`議곕룄 湲곗? ?댄깉 (${Number(reading.lightLux).toFixed(0)} lux 異붿젙)`);
  return alerts;
}

function lastDay() { return currentDeviceHistory().filter(item => Date.parse(item.timestamp) >= Date.now() - 24 * 60 * 60 * 1000); }
function avg(items, key) { return items.length ? (items.reduce((sum, item) => sum + Number(item[key]), 0) / items.length).toFixed(1) : '--'; }
function formatTime(timestamp) { return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp)); }
function localDateInput(date) {
  const year = date.getFullYear(), month = String(date.getMonth() + 1).padStart(2, '0'), day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function analysisRange() {
  const period = $('analysis-period').value;
  if (period === 'custom') {
    const startValue = $('analysis-start').value, endValue = $('analysis-end').value;
    if (!startValue || !endValue) throw new Error('Choose a start and end date.');
    const start = new Date(`${startValue}T00:00:00`), end = new Date(`${endValue}T23:59:59.999`);
    if (end <= start) throw new Error('End date must be after the start date.');
    return { start: start.toISOString(), end: end.toISOString(), label: `${startValue} to ${endValue}` };
  }
  const durationHours = period === '7d' ? 168 : period === '30d' ? 720 : 24;
  const end = new Date(), start = new Date(end.getTime() - durationHours * 60 * 60 * 1000);
  const label = period === '7d' ? 'Last 7 days' : period === '30d' ? 'Last 30 days' : 'Last 24 hours';
  return { start: start.toISOString(), end: end.toISOString(), label };
}

function renderDashboard() {
  renderDeviceOverview();
  const connected = currentDeviceConnected(), t = state.thresholds, latest = currentDeviceLatest();
  $('threshold-temp-text').textContent = `${t.temperatureMin ?? 18}°C – ${t.temperatureMax ?? 28}°C`;
  $('threshold-humidity-text').textContent = `${t.humidityMin ?? 30}% – ${t.humidityMax ?? 65}%`;
  $('temp-range').textContent = `기준 ${t.temperatureMin ?? 18} ~ ${t.temperatureMax ?? 28}°C`;
  $('humidity-range').textContent = `기준 ${t.humidityMin ?? 30} ~ ${t.humidityMax ?? 65}%`;
  $('current-temp').innerHTML = latest ? `${Number(latest.temperature).toFixed(1)}<small>°C</small>` : '--<small>°C</small>';
  $('current-humidity').innerHTML = latest ? `${Number(latest.humidity).toFixed(0)}<small>%</small>` : '--<small>%</small>';
  $('current-gas').innerHTML = latest?.gasRaw != null ? `${Number(latest.gasRaw)}<small>raw</small>` : '--<small>raw</small>';
  $('current-light').innerHTML = latest?.lightLux != null ? `${Number(latest.lightLux).toFixed(0)}<small>lux*</small>` : '--<small>lux*</small>';
  const todayItems = lastDay();
  $('average-temp').innerHTML = `${avg(todayItems, 'temperature')}<small>°C</small>`;
  $('average-humidity').innerHTML = `${avg(todayItems, 'humidity')}<small>%</small>`;
  $('sample-count').textContent = `측정 ${todayItems.length.toLocaleString()}회`;
  const latestAlerts = latest ? currentAlerts(latest) : [];
  const alerts = connected ? latestAlerts : [];
  $('temp-state').textContent = latest ? (alerts.length ? '설정 범위 벗어남' : '설정 범위 내') : '측정 대기 중';
  $('humidity-state').textContent = latest ? (alerts.length ? '설정 범위 벗어남' : '설정 범위 내') : '측정 대기 중';
  $('temp-state').classList.toggle('warning-state', alerts.length > 0);
  $('humidity-state').classList.toggle('warning-state', alerts.length > 0);
  const outside = todayItems.filter(item => currentAlerts(item).length);
  $('threshold-count').textContent = outside.length ? `기준 이탈 ${outside.length}회` : '오늘 기준 이탈 없음';
  $('threshold-count').classList.toggle('warning-state', outside.length > 0);
  $('status-banner').classList.toggle('warning', alerts.length > 0);
  $('status-title').textContent = alerts.length ? '환경이 설정 범위를 벗어났습니다' : connected ? (latest ? '센서가 연결되어 측정 중입니다' : '센서 데이터 대기 중') : latest ? '센서 연결이 끊겼습니다' : '센서를 연결해 주세요';
  $('status-description').textContent = alerts.length ? alerts.join(' · ') : latest ? `마지막 측정 ${formatTime(latest.timestamp)}${connected ? '' : ' · 저장된 기록을 표시합니다'}` : 'HC-06을 PC와 페어링한 뒤 COM 포트를 연결하세요.';
  renderChart(periodHistory()); renderTrendSummary(); renderDiagnostics(); renderAlertList(outside); renderHistory();
}

function renderChart(items) {
  const chartList = $('room-chart-list'), baseChart = $('history-chart');
  const multiRoom = state.selectedDeviceId === 'all' && state.devices.length > 1;
  chartList?.classList.toggle('hidden', !multiRoom);
  if (baseChart) baseChart.classList.toggle('hidden', multiRoom);
  if (multiRoom && chartList && baseChart) {
    chartList.replaceChildren();
    for (const device of state.devices) {
      const roomItems = items.filter(item => (item.deviceId || 'legacy') === device.id);
      const section = document.createElement('section'); section.className = 'room-chart-card';
      const title = document.createElement('h3'); title.textContent = device.name || device.id;
      const svg = baseChart.cloneNode(true); svg.removeAttribute('id'); svg.setAttribute('aria-label', `${device.name || device.id} environment chart`);
      section.append(title, svg); chartList.append(section);
      if (roomItems.length < 2) {
        const note = document.createElement('small'); note.className = 'room-chart-empty';
        note.textContent = roomItems.length ? 'More readings are needed to draw a trend.' : 'No readings in this period.';
        section.append(note);
      }
      drawChart(roomItems, svg, null);
    }
    $('chart-empty').classList.add('hidden');
    return;
  }
  drawChart(items, baseChart, $('chart-empty'));
}

function drawChart(items, chart, empty) {
  const visible = items.slice(-150);
  const paths = { temperature: chart?.querySelector('#temp-path'), humidity: chart?.querySelector('#humidity-path'), gasRaw: chart?.querySelector('#gas-path'), lightLux: chart?.querySelector('#light-path') };
  empty?.classList.toggle('hidden', visible.length > 1);
  if (visible.length < 2) {
    Object.values(paths).forEach(path => path?.setAttribute('d', ''));
    return;
  }
  const makePath = key => {
    const values = visible.map((item, index) => ({ index, value: Number(item[key]) })).filter(point => Number.isFinite(point.value));
    if (values.length < 2) return '';
    let low = Math.min(...values.map(point => point.value)), high = Math.max(...values.map(point => point.value));
    if (high - low < 0.5) { high += 0.25; low -= 0.25; }
    return values.map(({ index, value }, pointIndex) => {
      const x = 42 + index * (708 / (visible.length - 1));
      const y = 190 - ((value - low) / (high - low)) * 155;
      const previous = values[pointIndex - 1];
      const expectedGap = Number(state.systemSettings?.sampleIntervalSeconds || 30) * 2;
      const gap = previous && (Date.parse(visible[index].timestamp) - Date.parse(visible[previous.index].timestamp)) / 1000 > expectedGap;
      return `${pointIndex && !gap ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };
  for (const [key, path] of Object.entries(paths)) path?.setAttribute('d', state.chartSeries.includes(key) ? makePath(key) : '');
}

function renderAlertList(outside) {
  const list = $('alert-list'); list.replaceChildren();
  const events = outside.slice(-4).reverse();
  if (!events.length) { const empty = document.createElement('div'); empty.className = 'empty-small'; empty.textContent = 'No recent threshold alerts.'; list.append(empty); return; }
  for (const item of events) {
    const row = document.createElement('div'); row.className = 'alert-event';
    const marker = document.createElement('span'); marker.className = 'event-marker';
    const details = document.createElement('div'); details.className = 'event-details';
    const title = document.createElement('strong'); title.textContent = currentAlerts(item).join(' ? ');
    const time = document.createElement('small'); time.textContent = formatTime(item.timestamp);
    details.append(title, time); row.append(marker, details); list.append(row);
  }
}

function renderHistory() {
  const tbody = $('history-table');
  renderDataCalendar(); renderAlarmHistory();
  const items = state.history.slice(-250).reverse();
  $('history-count').textContent = `전체 ${state.history.length.toLocaleString()}건 · 최근 250건 표시`;
  tbody.replaceChildren();
  if (!items.length) { const row = tbody.insertRow(); const cell = row.insertCell(); cell.colSpan = 7; cell.className = 'empty-table'; cell.textContent = '센서가 연결되면 측정 기록이 여기에 표시됩니다.'; return; }
  for (const item of items) {
    const row = tbody.insertRow();
    row.insertCell().textContent = formatTime(item.timestamp);
    row.insertCell().textContent = item.deviceName || item.deviceId || '센서';
    row.insertCell().textContent = `${Number(item.temperature).toFixed(1)} °C`;
    row.insertCell().textContent = `${Number(item.humidity).toFixed(0)}%`;
    row.insertCell().textContent = item.gasRaw == null ? '--' : `${item.gasRaw} raw`;
    row.insertCell().textContent = item.lightLux == null ? '--' : `${Number(item.lightLux).toFixed(0)} lux*`;
    const status = row.insertCell(), warnings = currentAlerts(item);
    status.textContent = warnings.length ? warnings.join(', ') : item.qualityFlags?.length ? '측정값 확인 필요' : '정상';
  }
}

function localDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderDataCalendar() {
  const days = $('calendar-days'); if (!days) return;
  const month = state.calendarMonth, first = new Date(month.getFullYear(), month.getMonth(), 1);
  $('calendar-month').textContent = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long' }).format(month);
  const start = new Date(first); start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const perDay = new Map();
  for (const reading of currentDeviceHistory()) {
    const key = localDayKey(reading.timestamp); if (!perDay.has(key)) perDay.set(key, []); perDay.get(key).push(reading);
  }
  days.replaceChildren();
  for (let index = 0; index < 42; index++) {
    const date = new Date(start); date.setDate(start.getDate() + index);
    const key = localDayKey(date), readings = perDay.get(key) || [];
    const expected = Math.max(120, Number(state.systemSettings?.sampleIntervalSeconds || 30) * 2);
    const hasGap = readings.slice(1).some((item, i) => (Date.parse(item.timestamp) - Date.parse(readings[i].timestamp)) / 1000 > expected);
    const button = document.createElement('button'); button.type = 'button';
    button.className = `calendar-day${date.getMonth() !== month.getMonth() ? ' outside-month' : ''}${readings.length ? (hasGap ? ' has-gap' : ' has-data') : ' no-data'}${key === state.selectedCalendarDate ? ' selected' : ''}`;
    button.innerHTML = `<span>${date.getDate()}</span><small>${readings.length ? readings.length : ''}</small>`;
    button.title = readings.length ? `측정 ${readings.length}건${hasGap ? ' · 측정 중단 구간 있음' : ''}` : '측정 기록 없음';
    button.addEventListener('click', () => { state.selectedCalendarDate = key; renderDataCalendar(); }); days.append(button);
  }
  const selected = state.selectedCalendarDate || localDayKey(new Date()); state.selectedCalendarDate = selected;
  const readings = perDay.get(selected) || [];
  const events = state.monitoringEvents.filter(item => localDayKey(item.timestamp) === selected && (state.selectedDeviceId === 'all' || !item.deviceId || item.deviceId === state.selectedDeviceId));
  const connects = events.filter(item => item.type === 'serial-connect').length, disconnects = events.filter(item => item.type === 'serial-disconnect').length;
  const detail = readings.length ? `측정 ${readings.length}건 · ${formatTime(readings[0].timestamp)} ~ ${formatTime(readings.at(-1).timestamp)}` : '이 날짜의 센서 기록이 없습니다.';
  $('calendar-detail').textContent = `${selected} · ${detail} · 연결 ${connects}회 · 연결 해제 ${disconnects}회`;
}

function renderAlarmHistory() {
  const target = $('alarm-history'); if (!target) return; target.replaceChildren();
  const items = [...(state.alertHistory || [])].filter(item => state.selectedDeviceId === 'all' || !item.deviceId || item.deviceId === state.selectedDeviceId).reverse().slice(0, 30);
  if (!items.length) { const empty = document.createElement('p'); empty.className = 'calendar-detail'; empty.textContent = '기록된 알림이 없습니다.'; target.append(empty); return; }
  for (const item of items) {
    const row = document.createElement('article'); row.className = `alarm-row${item.endedAt ? '' : ' alarm-active'}`;
    const title = document.createElement('strong'); title.textContent = `${item.deviceName ? `${item.deviceName} ? ` : ''}${item.message || item.key}`;
    const times = document.createElement('span');
    const duration = item.endedAt ? Math.max(0, Math.round((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 60000)) : null;
    times.textContent = `${formatTime(item.startedAt)} ? ${item.endedAt ? `${formatTime(item.endedAt)} ? ${duration}m` : 'Active'}`;
    row.append(title, times); target.append(row);
  }
}

function showReport(report) {
  const panel = $('report-panel');
  panel.replaceChildren();
  const head = document.createElement('div'); head.className = 'report-heading';
  const meta = document.createElement('div'); meta.innerHTML = `<span class="eyebrow">${report.kind === 'daily' ? 'DAILY REVIEW' : 'AI REVIEW'}</span><h2>${formatTime(report.createdAt)} 遺꾩꽍</h2>`;
  head.append(meta);
  const text = document.createElement('div'); text.className = 'report-text markdown-body';
  const markdownHtml = window.marked.parse(report.text, { gfm: true, breaks: true });
  text.innerHTML = window.DOMPurify.sanitize(markdownHtml, { FORBID_TAGS: ['img', 'iframe', 'style', 'svg', 'math'] });
  text.querySelectorAll('a').forEach(link => { link.rel = 'noopener noreferrer'; });
  text.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    appApi.openExternal(link.href);
  });
  const data = document.createElement('div'); data.className = 'report-data';
  const summary = report.summary;
  data.textContent = `${summary.period} 쨌 遺꾩꽍 ?먮즺 ${summary.sampleCount.toLocaleString('ko-KR')}媛?쨌 ?⑤룄 ?됯퇏 ${summary.temperature.average ?? '--'}째C 쨌 ?듬룄 ?됯퇏 ${summary.humidity.average ?? '--'}%`;
  panel.append(head, text, data);
}

function renderReports() {
  const list = $('report-list');
  list.replaceChildren();
  if (!state.reports.length) { const empty = document.createElement('div'); empty.className = 'empty-small'; empty.textContent = '??λ맂 由ы룷?멸? ?놁뒿?덈떎.'; list.append(empty); return; }
  for (const report of state.reports.slice(0, 8)) {
    const button = document.createElement('button'); button.className = 'report-list-item';
    const heading = document.createElement('strong'); heading.textContent = `${report.kind === 'daily' ? '?섎（ ?붿빟' : '吏곸젒 遺꾩꽍'} 쨌 ${formatTime(report.createdAt)}`;
    const summary = document.createElement('span'); summary.textContent = report.text.slice(0, 130).replace(/\s+/g, ' ');
    button.append(heading, summary);
    button.addEventListener('click', () => showReport(report));
    list.append(button);
  }
}

async function refreshPorts() {
  const select = $('port-select'), previous = select.value, savedPort = localStorage.getItem('roomly.lastSerialPort');
  select.replaceChildren(new Option('Select a port', ''));
  try {
    const ports = await appApi.listPorts();
    if (!ports.length) select.add(new Option('No COM ports found', ''));
    for (const port of ports) {
      const description = [port.friendlyName, port.manufacturer, port.vendorId && `VID ${port.vendorId}`].filter(Boolean).join(' ? ');
      select.add(new Option(description ? `${port.path} ? ${description}` : port.path, port.path));
    }
    if (ports.some(port => port.path === previous)) select.value = previous;
    else if (savedPort && ports.some(port => port.path === savedPort)) select.value = savedPort;
    if (ports.length && !select.value) select.value = ports[0].path;
  } catch (error) { select.replaceChildren(new Option('Could not list COM ports', '')); $('connection-message').textContent = error.message; }
}

$('port-select').addEventListener('change', event => {
  if (event.target.value) localStorage.setItem('roomly.lastSerialPort', event.target.value);
});
$('baud-select').value = localStorage.getItem('roomly.lastSerialBaud') || '9600';
$('baud-select').addEventListener('change', event => localStorage.setItem('roomly.lastSerialBaud', event.target.value));

function fillSettings() {
  const form = $('threshold-form');
  for (const [key, value] of Object.entries(state.thresholds)) if (form.elements[key]) form.elements[key].value = value;
}

document.querySelectorAll('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-view-link]').forEach(button => button.addEventListener('click', () => showView(button.dataset.viewLink)));
document.querySelectorAll('#open-settings, #top-settings, #banner-settings, #edit-thresholds').forEach(button => button.addEventListener('click', openSettings));
document.querySelectorAll('#close-settings, #done-settings').forEach(button => button.addEventListener('click', closeSettings));
$('settings-modal').addEventListener('click', event => { if (event.target === $('settings-modal')) closeSettings(); });
$('refresh-ports').addEventListener('click', refreshPorts);
async function reconnectLastDevice() {
  const path = localStorage.getItem('roomly.lastSerialPort');
  if (!path) return false;
  try {
    const result = await appApi.connect({ path, baudRate: Number(localStorage.getItem('roomly.lastSerialBaud') || 9600), name: localStorage.getItem('roomly.lastSerialName') || '' });
    setConnection(result); toast(`${result.path} 湲곌린???곌껐?덉뒿?덈떎.`); return true;
  } catch (error) { toast(`??ν븳 湲곌린???곌껐?섏? 紐삵뻽?듬땲?? ?ы듃 ?ㅼ젙???뺤씤??二쇱꽭?? ${error.message}`, true); openSettings(); return true; }
}
$('dashboard-connect').addEventListener('click', async () => { if (state.connected) return openSettings(); if (!await reconnectLastDevice()) openSettings(); });
  $('history-export').addEventListener('click', () => {
  if (!state.history.length) return toast('?대낫??湲곕줉???놁뒿?덈떎.', true);
  const from = $('csv-start').value ? new Date(`${$('csv-start').value}T00:00:00`).getTime() : -Infinity;
  const to = $('csv-end').value ? new Date(`${$('csv-end').value}T23:59:59.999`).getTime() : Infinity;
  if (to < from) return toast('?좎쭨 踰붿쐞瑜??뺤씤?섏꽭??', true);
  const selected = state.history.filter(item => Date.parse(item.timestamp) >= from && Date.parse(item.timestamp) <= to);
  if (!selected.length) return toast('?좏깮??湲곌컙??湲곕줉???놁뒿?덈떎.', true);
  const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = ['timestamp,device,temperature_c,humidity_percent,gas_raw,light_raw,light_lux_estimated,quality_flags', ...selected.map(item => [item.timestamp, item.deviceName || item.deviceId || '?댁쟾 湲곕줉', item.temperature, item.humidity, item.gasRaw, item.lightRaw, item.lightLux, (item.qualityFlags || []).join('|')].map(csvCell).join(','))];
  const blob = new Blob(['\uFEFF', lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'roomly-sensor-history.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

$('connect-button').addEventListener('click', async () => {
  try {
    const result = await appApi.connect({ path: $('port-select').value, baudRate: Number($('baud-select').value), name: $('device-name-connect').value });
    localStorage.setItem('roomly.lastSerialPort', result.path);
    localStorage.setItem('roomly.lastSerialBaud', $('baud-select').value);
    localStorage.setItem('roomly.lastSerialName', result.deviceName || $('device-name-connect').value || '');
    $('device-name-connect').value = '';
    setConnection(result); toast(`${result.path} ?ы듃???곌껐?덉뒿?덈떎.`);
  } catch (error) { $('connection-message').textContent = error.message; toast(`?곌껐?섏? 紐삵뻽?듬땲?? ${error.message}`, true); }
});

$('threshold-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const next = Object.fromEntries(form.entries());
  for (const key of Object.keys(next)) if (key !== 'lightLuxDirection') next[key] = Number(next[key]);
  if (next.temperatureMin >= next.temperatureMax || next.humidityMin >= next.humidityMax) return toast('理쒖? 湲곗?? 理쒓퀬 湲곗?蹂대떎 ??븘???⑸땲??', true);
  try { state.thresholds = await appApi.saveThresholds(next); renderDashboard(); toast('?뚮┝ 湲곗?????ν뻽?듬땲??'); }
  catch (error) { toast(error.message, true); }
});
$('test-notification').addEventListener('click', async () => {
  try { await appApi.testNotification(); toast('Test notification sent.'); }
  catch (error) { toast(error.message, true); }
});
$('reset-thresholds').addEventListener('click', async () => {
  state.thresholds = await appApi.resetThresholds();
  fillSettings(); renderDashboard(); toast('?뚮┝ 湲곗???湲곕낯媛믪쑝濡??섎룎?몄뒿?덈떎.');
});

$('analyze-button').addEventListener('click', async () => {
  $('analyze-button').disabled = true; $('analyze-button').textContent = 'Analyzing?';
  try {
    const report = await appApi.analyze(analysisRange());
    if (!state.reports.some(item => item.id === report.id)) state.reports.unshift(report);
    state.reports = state.reports.slice(0, 60); showReport(report); renderReports(); toast('AI report is ready.');
  } catch (error) { toast(error.message, true); }
  finally { $('analyze-button').disabled = false; $('analyze-button').textContent = 'Analyze now'; }
});

$('analysis-period').addEventListener('change', () => {
  const custom = $('analysis-period').value === 'custom';
  $('custom-range').classList.toggle('hidden', !custom);
  if (custom && !$('analysis-start').value) {
    const end = new Date(), start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
    $('analysis-start').value = localDateInput(start);
    $('analysis-end').value = localDateInput(end);
  }
  localStorage.setItem('analysis-period', $('analysis-period').value);
  if ($('analysis-start').value) localStorage.setItem('analysis-start', $('analysis-start').value);
  if ($('analysis-end').value) localStorage.setItem('analysis-end', $('analysis-end').value);
});
$('analysis-start').addEventListener('change', () => localStorage.setItem('analysis-start', $('analysis-start').value));
$('analysis-end').addEventListener('change', () => localStorage.setItem('analysis-end', $('analysis-end').value));

appApi.onReading(reading => {
  const id = reading.deviceId || 'legacy';
  state.latestByDevice[id] = reading;
  if (!state.devices.some(device => device.id === id)) state.devices.push({ id, name: reading.deviceName || id });
  if (reading.persisted) { state.history.push(reading); if (state.history.length > 300000) state.history.shift(); }
  if (reading.qualityFlags?.length) { state.lastQualityFlags = reading.qualityFlags; state.qualityEventCount = (state.qualityEventCount || 0) + 1; }
  else state.lastQualityFlags = [];
  state.latest = reading; renderDashboard(); renderDiagnostics();
});
appApi.onSerialStatus(setConnection);
appApi.onDailyReviewStatus(status => {
  $('daily-review-status').textContent = status?.message || '';
  $('daily-review-status').classList.toggle('hidden', !status?.message);
});
appApi.onReport(report => {
  if (!state.reports.some(item => item.id === report.id)) state.reports.unshift(report);
  state.reports = state.reports.slice(0, 60); showReport(report); renderReports();
  if (report.kind === 'daily') toast('?ㅻ뒛??AI ?붿빟??以鍮꾨릱?듬땲??');
});

async function initialize() {
  installNewControls();
  installQualityControls();
  if (localStorage.getItem('roomly.lastSerialPort')) $('dashboard-connect').textContent = '이전 기기 바로 연결';
  $('chart-period').value = localStorage.getItem('chart-period') || '24';
  updateChartAxisLabels();
  $('today-label').textContent = new Intl.DateTimeFormat('ko-KR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
  $('analysis-period').value = localStorage.getItem('analysis-period') || '24h';
  $('analysis-start').value = localStorage.getItem('analysis-start') || '';
  $('analysis-end').value = localStorage.getItem('analysis-end') || '';
  $('custom-range').classList.toggle('hidden', $('analysis-period').value !== 'custom');
  if ($('analysis-period').value === 'custom' && !$('analysis-start').value && !$('analysis-end').value) {
    const end = new Date(), start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
    $('analysis-start').value = localDateInput(start);
    $('analysis-end').value = localDateInput(end);
  }
  try {
    const data = await appApi.getData();
    state.alertHistory = data.alertHistory || [];
    state.monitoringEvents = data.monitoringEvents || [];
    state.history = data.history || [];
    state.devices = data.devices || [];
    state.connectedDevices = data.connectedDevices || [];
    state.selectedDeviceId = state.devices[0]?.id || 'all';
    for (const item of state.history) state.latestByDevice[item.deviceId || 'legacy'] = item;
    state.historyTruncated = Boolean(data.historyTruncated);
    state.qualityEventCount = state.history.reduce((count, item) => count + (item.qualityFlags?.length ? 1 : 0), 0);
    state.systemSettings = data.systemSettings || { sampleIntervalSeconds: 30, retentionDays: 30, temperatureOffset: 0, humidityOffset: 0, alertHoldSeconds: 60, autoReconnect: true, notifyRecovery: false };
    $('device-name').value = state.systemSettings.deviceName || 'Sensor profile';
    $('temperature-sensor').value = state.systemSettings.temperatureSensor || 'unspecified';
    $('gas-sensor').value = state.systemSettings.gasSensor || 'unspecified';
    $('light-sensor').value = state.systemSettings.lightSensor || 'ldr';
    $('sample-interval').value = String(state.systemSettings.sampleIntervalSeconds);
    $('retention-days').value = String(state.systemSettings.retentionDays);
    $('temperature-offset').value = state.systemSettings.temperatureOffset;
    $('humidity-offset').value = state.systemSettings.humidityOffset;
    $('alert-hold').value = String(state.systemSettings.alertHoldSeconds);
    $('auto-reconnect').checked = Boolean(state.systemSettings.autoReconnect);
    $('notify-recovery').checked = Boolean(state.systemSettings.notifyRecovery);
    $('notify-data-gap').checked = Boolean(state.systemSettings.notifyDataGap);
    $('data-gap-minutes').value = String(state.systemSettings.dataGapMinutes || 5);
    state.latest = data.latest || state.history.at(-1) || null;
    state.thresholds = data.thresholds || {};
    state.reports = data.reports || [];
    state.weather = data.weather; state.weatherSettings = data.weatherSettings || {};
    state.lightCalibration = data.lightCalibration || { fixedResistorOhms: 10000, resistanceAt10LuxOhms: 15000, gamma: 0.7, wiring: 'ldr-high' };
    state.diagnostics = data.diagnostics || {};
    state.notificationRepeatMinutes = data.notificationRepeatMinutes || 30;
    $('daily-review-status').textContent = data.lastDailyReviewStatus?.message || '';
    $('daily-review-status').classList.toggle('hidden', !data.lastDailyReviewStatus?.message);
    $('notification-repeat').value = String(state.notificationRepeatMinutes);
    $('ldr-fixed').value = state.lightCalibration.fixedResistorOhms; $('ldr-r10').value = state.lightCalibration.resistanceAt10LuxOhms; $('ldr-gamma').value = state.lightCalibration.gamma; $('ldr-wiring').value = state.lightCalibration.wiring;
    state.history = state.history.map(item => item.lightRaw == null ? item : { ...item, lightLux: estimateLux(item.lightRaw) });
    state.latest = state.history.at(-1) || state.latest;
    $('weather-region').value = state.weatherSettings.region || '?쒖슱'; $('weather-nx').value = state.weatherSettings.nx || 60; $('weather-ny').value = state.weatherSettings.ny || 127; $('weather-stn').value = state.weatherSettings.stnId || 108;
    $('startup-enabled').checked = Boolean(data.openAtLogin);
    renderWeather();
    fillSettings(); renderDashboard(); renderReports();
    if (state.reports.length) showReport(state.reports[0]);
    state.hasAccount = data.hasAccount;
    $('account-status').textContent = data.hasAccount ? 'Gemini API key is configured in main.js.' : 'Paste your Gemini API key in main.js to enable AI analysis.';
    $('account-status').classList.toggle('success-text', data.hasAccount);
  } catch (error) { toast(`???곗씠?곕? ?쎌? 紐삵뻽?듬땲?? ${error.message}`, true); }
}

appApi.onWeather(snapshot => { state.weather = snapshot; renderWeather(snapshot); });
appApi.onDiagnostics(data => { state.diagnostics = { ...state.diagnostics, ...data }; renderDiagnostics(); });
appApi.onRestored(data => {
  state.alertHistory = data.alertHistory || state.alertHistory; state.monitoringEvents = data.monitoringEvents || state.monitoringEvents;
  state.history = data.history; state.latest = data.latest; state.thresholds = data.thresholds; state.reports = data.reports; state.lightCalibration = data.lightCalibration; state.historyTruncated = data.historyTruncated; state.systemSettings = data.systemSettings;
  state.latestByDevice = {}; state.devices = [];
  for (const item of state.history) {
    const id = item.deviceId || 'legacy';
    if (!state.latestByDevice[id] || Date.parse(item.timestamp) > Date.parse(state.latestByDevice[id].timestamp)) state.latestByDevice[id] = item;
    if (id !== 'legacy' && !state.devices.some(device => device.id === id)) state.devices.push({ id, name: item.deviceName || id });
  }
    $('device-name').value = state.systemSettings.deviceName || 'Sensor profile';
  $('sample-interval').value = String(state.systemSettings.sampleIntervalSeconds); $('retention-days').value = String(state.systemSettings.retentionDays);
  $('temperature-offset').value = state.systemSettings.temperatureOffset; $('humidity-offset').value = state.systemSettings.humidityOffset; $('alert-hold').value = String(state.systemSettings.alertHoldSeconds);
  $('auto-reconnect').checked = Boolean(state.systemSettings.autoReconnect); $('notify-recovery').checked = Boolean(state.systemSettings.notifyRecovery);
  fillSettings(); renderDashboard(); renderReports();
});
appApi.onStorageError(error => toast(`湲곕줉 ????ㅽ뙣: ${error}`, true));
initialize();
