/**
 * AquaVise — app.js  (Redesigned UI Edition)
 * ─────────────────────────────────────────────────────────────
 * All original Firebase functionality preserved and extended.
 * Updated to target the new HTML element IDs from the redesigned
 * index.html. Zero breaking changes to data flow or Firebase paths.
 *
 * Modules:
 *   1. Firebase Configuration & Initialization
 *   2. Auth Module
 *   3. Realtime Data Module
 *   4. Chart Module
 *   5. Pump Control Module
 *   6. AI Insights Engine (rule-based)
 *   7. Alert Log Module
 *   8. UI Utilities
 *   9. App Core
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// 1. FIREBASE CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCPIyCcmDKyXUdGhNLGwv8ZE4WWMxYrg78",
  authDomain:        "aquavise-ff8b3.firebaseapp.com",
  databaseURL:       "https://aquavise-ff8b3-default-rtdb.firebaseio.com",
  projectId:         "aquavise-ff8b3",
  storageBucket:     "aquavise-ff8b3.firebasestorage.app",
  messagingSenderId: "436318256886",
  appId:             "1:436318256886:web:d68eed79db5724d0ac76d7",
  measurementId:     "G-HD3T4C2ZCF",
};

// ── Firebase RTDB paths — must stay in sync with ESP32 firmware ──
const DB = {
  sensors:      "/aquavise/sensors",
  cmdFresh:     "/aquavise/commands/freshwaterPump",
  cmdDrain:     "/aquavise/commands/drainPump",
  stateFresh:   "/aquavise/state/freshwaterPump",
  stateDrain:   "/aquavise/state/drainPump",
  stateAlert:   "/aquavise/state/alert",
  deviceOnline: "/aquavise/state/deviceOnline",
  history:      "/aquavise/history",
};

// ── Safety thresholds (mirrored from ESP32 constants) ──
const THR = {
  turbidity: { warning: 300,  danger: 600  },
  pH:        { lowWarn: 6.5,  highWarn: 8.5,  lowDanger: 6.0, highDanger: 9.0 },
  temp:      { lowWarn: 18,   highWarn: 30,   lowDanger: 15,  highDanger: 33  },
};

firebase.initializeApp(FIREBASE_CONFIG);

const fbAuth = firebase.auth();
const fbDB   = firebase.database();

// ═══════════════════════════════════════════════════════════════
// 2. AUTH MODULE
// ═══════════════════════════════════════════════════════════════

const AuthModule = (() => {

  // ── DOM refs ──
  const authScreen  = document.getElementById('auth-screen');
  const appDash     = document.getElementById('dashboard');
  const loginForm   = document.getElementById('login-form');
  const signupForm  = document.getElementById('signup-form');
  const loginError  = document.getElementById('login-error');
  const signupError = document.getElementById('signup-error');
  const logoutBtn   = document.getElementById('logout-btn');

  // ── Tab switcher ──
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tab.dataset.tab}-form`).classList.add('active');
    });
  });

  // ── Login ──
  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) { showError(loginError, 'Please enter your credentials.'); return; }
    setLoading('login-btn', true);
    hideError(loginError);
    try {
      await fbAuth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      showError(loginError, friendlyError(err.code));
    } finally {
      setLoading('login-btn', false);
    }
  });

  // ── Sign Up ──
  signupForm.addEventListener('submit', async e => {
    e.preventDefault();
    const email    = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    if (password.length < 8) { showError(signupError, 'Password must be at least 8 characters.'); return; }
    setLoading('signup-btn', true);
    hideError(signupError);
    try {
      await fbAuth.createUserWithEmailAndPassword(email, password);
    } catch (err) {
      showError(signupError, friendlyError(err.code));
    } finally {
      setLoading('signup-btn', false);
    }
  });

  // ── Logout ──
  logoutBtn.addEventListener('click', () => fbAuth.signOut());

  // ── Auth State Observer ──
  fbAuth.onAuthStateChanged(user => {
    if (user) {
      authScreen.style.display = 'none';
      appDash.style.display    = 'block';
      AppCore.start();
    } else {
      authScreen.style.display = 'flex';
      appDash.style.display    = 'none';
      AppCore.stop();
    }
  });

  // ── Helpers ──
  function setLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    btn.disabled = loading;
    btn.querySelector('.btn-label').classList.toggle('hidden', loading);
    btn.querySelector('.btn-spinner').classList.toggle('hidden', !loading);
  }

  function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
  function hideError(el)      { el.classList.add('hidden'); }

  function friendlyError(code) {
    const map = {
      'auth/user-not-found':      'No account found with that email.',
      'auth/wrong-password':      'Incorrect password. Please try again.',
      'auth/invalid-email':       'Please enter a valid email address.',
      'auth/email-already-in-use':'An account already exists with this email.',
      'auth/weak-password':       'Password is too weak (min 6 characters).',
      'auth/too-many-requests':   'Too many attempts. Please wait and try again.',
      'auth/invalid-credential':  'Invalid credentials. Please check and retry.',
    };
    return map[code] || 'Authentication failed. Please try again.';
  }

})();

// ═══════════════════════════════════════════════════════════════
// 3. REALTIME DATA MODULE
// ═══════════════════════════════════════════════════════════════

const DataModule = (() => {

  const MAX_HISTORY = 100;

  // Rolling buffer for chart + AI trend analysis
  const history = {
    turbidity:   [],
    pH:          [],
    temperature: [],
    timestamps:  [],
  };

  let listeners = [];  // Tracked so they can be torn down on logout

  function start() {
    // ── Live sensor readings ──
    const sRef = fbDB.ref(DB.sensors);
    const sHandler = sRef.on('value', snap => {
      const d = snap.val();
      if (!d) return;

      const r = {
        turbidity:   parseFloat(d.turbidity)   || 0,
        pH:          parseFloat(d.pH)           || 7,
        temperature: parseFloat(d.temperature)  || 25,
        status:      d.status || 'safe',
        timestamp:   d.timestamp || Date.now(),
      };

      // Push into rolling history
      history.turbidity.push(r.turbidity);
      history.pH.push(r.pH);
      history.temperature.push(r.temperature);
      history.timestamps.push(formatTime(r.timestamp));
      if (history.turbidity.length > MAX_HISTORY) {
        history.turbidity.shift();
        history.pH.shift();
        history.temperature.shift();
        history.timestamps.shift();
      }

      // Propagate to UI
      UIUtils.updateSensorCards(r);
      UIUtils.updateLastUpdated();
      ChartModule.update(history, ChartModule.getRange());
      AIEngine.analyse(r, history);
    });

    // ── Device online flag ──
    const oRef = fbDB.ref(DB.deviceOnline);
    const oHandler = oRef.on('value', snap => {
      UIUtils.setDeviceStatus(snap.val() === true);
    });

    // ── Pump state (actual device confirmation) ──
    const fRef = fbDB.ref(DB.stateFresh);
    const fHandler = fRef.on('value', snap => {
      PumpModule.reflectState('fresh', snap.val() === true);
    });

    const dRef = fbDB.ref(DB.stateDrain);
    const dHandler = dRef.on('value', snap => {
      PumpModule.reflectState('drain', snap.val() === true);
    });

    listeners = [
      { ref: sRef, fn: sHandler, ev: 'value' },
      { ref: oRef, fn: oHandler, ev: 'value' },
      { ref: fRef, fn: fHandler, ev: 'value' },
      { ref: dRef, fn: dHandler, ev: 'value' },
    ];
  }

  function stop() {
    listeners.forEach(l => l.ref.off(l.ev, l.fn));
    listeners = [];
  }

  function formatTime(ts) {
    const d = new Date(ts < 1e12 ? Date.now() : ts); // millis() from ESP32 is not epoch
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function getHistory() { return history; }

  return { start, stop, getHistory };

})();

// ═══════════════════════════════════════════════════════════════
// 4. CHART MODULE
// ═══════════════════════════════════════════════════════════════

const ChartModule = (() => {

  let range  = 20;
  let charts = {};

  // ── Shared Chart.js options ──
  const BASE_OPTS = {
    responsive:            true,
    maintainAspectRatio:   false,
    animation:             { duration: 350 },
    interaction:           { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0a1e30',
        titleColor:      '#5a8aa0',
        bodyColor:       '#e8f4f8',
        borderColor:     'rgba(0,200,255,0.2)',
        borderWidth:     1,
        padding:         10,
        titleFont: { family: "'DM Mono', monospace", size: 10 },
        bodyFont:  { family: "'DM Mono', monospace", size: 12 },
      },
    },
    scales: {
      x: {
        grid:  { color: 'rgba(0,200,255,0.06)', drawBorder: false },
        ticks: { color: '#3d6882', font: { family: "'DM Mono', monospace", size: 9 }, maxTicksLimit: 6 },
      },
      y: {
        grid:  { color: 'rgba(0,200,255,0.06)', drawBorder: false },
        ticks: { color: '#3d6882', font: { family: "'DM Mono', monospace", size: 9 } },
      },
    },
  };

  function mkDataset(color, data) {
    return {
      data,
      borderColor:     color,
      backgroundColor: color.replace('rgb', 'rgba').replace(')', ',0.08)'),
      borderWidth:     2,
      pointRadius:     2,
      pointHoverRadius:5,
      fill:            true,
      tension:         0.4,
    };
  }

  function init() {
    Object.values(charts).forEach(c => c.destroy());
    charts = {};

    charts.turbidity = new Chart(
      document.getElementById('chart-turbidity').getContext('2d'),
      {
        type: 'line',
        data: { labels: [], datasets: [mkDataset('rgb(0,200,255)', [])] },
        options: deepMerge(BASE_OPTS, { scales: { y: { min: 0, suggestedMax: 700 } } }),
      }
    );

    charts.ph = new Chart(
      document.getElementById('chart-ph').getContext('2d'),
      {
        type: 'line',
        data: { labels: [], datasets: [mkDataset('rgb(167,139,250)', [])] },
        options: deepMerge(BASE_OPTS, { scales: { y: { min: 0, max: 14 } } }),
      }
    );

    charts.temperature = new Chart(
      document.getElementById('chart-temperature').getContext('2d'),
      {
        type: 'line',
        data: { labels: [], datasets: [mkDataset('rgb(251,191,36)', [])] },
        options: deepMerge(BASE_OPTS, { scales: { y: { min: 0, suggestedMax: 45 } } }),
      }
    );

    // ── Range buttons ──
    document.querySelectorAll('.range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        range = parseInt(btn.dataset.range);
        update(DataModule.getHistory(), range);
      });
    });
  }

  function update(history, n) {
    const sl = arr => arr.slice(-n);
    const lb = sl(history.timestamps);

    charts.turbidity.data.labels             = lb;
    charts.turbidity.data.datasets[0].data   = sl(history.turbidity);
    charts.ph.data.labels                    = lb;
    charts.ph.data.datasets[0].data          = sl(history.pH);
    charts.temperature.data.labels           = lb;
    charts.temperature.data.datasets[0].data = sl(history.temperature);

    charts.turbidity.update('none');
    charts.ph.update('none');
    charts.temperature.update('none');
  }

  // Shallow deep-merge for options objects
  function deepMerge(base, override) {
    const out = { ...base };
    for (const k in override) {
      if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k])) {
        out[k] = deepMerge(base[k] || {}, override[k]);
      } else {
        out[k] = override[k];
      }
    }
    return out;
  }

  function getRange() { return range; }

  return { init, update, getRange };

})();

// ═══════════════════════════════════════════════════════════════
// 5. PUMP CONTROL MODULE
// ═══════════════════════════════════════════════════════════════

const PumpModule = (() => {

  const lastActivated = { fresh: null, drain: null };
  let freshPending = false;
  let drainPending = false;

  function init() {
    // ── Button clicks (original Activate / Deactivate pattern) ──
    document.getElementById('btn-fresh').addEventListener('click', () => toggle('fresh'));
    document.getElementById('btn-drain').addEventListener('click', () => toggle('drain'));

    // ── Emergency All Off ──
    document.getElementById('all-off-btn').addEventListener('click', async () => {
      try {
        await fbDB.ref(DB.cmdFresh).set(false);
        await fbDB.ref(DB.cmdDrain).set(false);
      } catch (e) {
        console.error('[Pump] Emergency all-off failed:', e);
      }
    });
  }

  async function toggle(pump) {
    if (pump === 'fresh' && freshPending) return;
    if (pump === 'drain' && drainPending) return;

    if (pump === 'fresh') freshPending = true;
    else                  drainPending = true;

    const path    = pump === 'fresh' ? DB.cmdFresh : DB.cmdDrain;
    const btnEl   = document.getElementById(`btn-${pump}`);
    const current = btnEl.textContent.trim() === 'Deactivate'; // currently ON → turn OFF
    const newVal  = !current;

    if (newVal) lastActivated[pump] = new Date();

    try {
      await fbDB.ref(path).set(newVal);
      updateLastOnLabel(pump);
    } catch (e) {
      console.error(`[Pump] Toggle ${pump} failed:`, e);
    } finally {
      if (pump === 'fresh') freshPending = false;
      else                  drainPending = false;
    }
  }

  // Called by DataModule when Firebase state changes (reflects device confirmation)
  function reflectState(pump, isOn) {
    const card  = document.getElementById(`pump-card-${pump}`);
    const badge = document.getElementById(`badge-${pump}`);
    const btn   = document.getElementById(`btn-${pump}`);

    if (card)  card.classList.toggle('pump-on', isOn);
    if (badge) badge.textContent = isOn ? 'Running' : 'Offline';
    if (btn)   btn.textContent   = isOn ? 'Deactivate' : 'Activate';
  }

  function updateLastOnLabel(pump) {
    const el = document.getElementById(`pump-last-${pump}`);
    if (!el || !lastActivated[pump]) return;
    const diff = Math.floor((Date.now() - lastActivated[pump].getTime()) / 1000);
    el.textContent = diff < 60 ? 'Just now' : `${Math.floor(diff / 60)} min ago`;
  }

  function getLastActivated() { return lastActivated; }

  return { init, reflectState, getLastActivated };

})();

// ═══════════════════════════════════════════════════════════════
// 6. AI INSIGHTS ENGINE  (Rule-Based Intelligent Analysis)
// ═══════════════════════════════════════════════════════════════

const AIEngine = (() => {

  let prevReading = null;
  const TREND_WINDOW = 6;

  /**
   * Main entry point — called on every sensor update.
   * Generates an array of insight objects and renders them.
   */
  function analyse(reading, history) {
    const insights = [];

    // ── Threshold checks ──
    insights.push(...checkTurbidity(reading));
    insights.push(...checkPH(reading));
    insights.push(...checkTemperature(reading));

    // ── Spike detection (inter-reading deltas) ──
    if (prevReading) {
      insights.push(...detectSpikes(reading, prevReading));
    }

    // ── Trend analysis (linear regression over rolling window) ──
    if (history.turbidity.length >= TREND_WINDOW) {
      insights.push(...analyseTrends(history));
    }

    // ── Water change recommendation (time-aware) ──
    const wcInsight = recommendWaterChange(reading);
    if (wcInsight) insights.push(wcInsight);

    // ── Pump advisory ──
    insights.push(...advisePumps(reading));

    // All-clear fallback
    if (insights.length === 0) {
      insights.push({
        level: 'safe',
        title: 'All Parameters Normal',
        desc:  'Water quality is within optimal range. No action required.',
      });
    }

    UIUtils.renderInsights(insights);
    AlertLog.add(reading.status, buildSummary(reading));
    UIUtils.updateAlertBanner(insights);

    prevReading = { ...reading };
  }

  // ── Individual checks ────────────────────────────────────────

  function checkTurbidity(r) {
    if (r.turbidity >= THR.turbidity.danger) return [{
      level: 'danger',
      title: 'Critical Turbidity',
      desc:  `Turbidity is ${r.turbidity.toFixed(0)} NTU — above the danger limit of ${THR.turbidity.danger} NTU. Immediate water change recommended.`,
    }];
    if (r.turbidity >= THR.turbidity.warning) return [{
      level: 'warning',
      title: 'Elevated Turbidity',
      desc:  `Turbidity at ${r.turbidity.toFixed(0)} NTU. Approaching danger level (${THR.turbidity.danger} NTU). Monitor closely.`,
    }];
    return [];
  }

  function checkPH(r) {
    const ph = r.pH;
    if (ph <= THR.pH.lowDanger)  return [{ level:'danger',  title:'Critically Low pH',   desc:`pH is ${ph.toFixed(2)} — dangerously acidic. Lethal for most aquatic species. Intervene immediately.` }];
    if (ph >= THR.pH.highDanger) return [{ level:'danger',  title:'Critically High pH',  desc:`pH is ${ph.toFixed(2)} — dangerously alkaline. Ammonia toxicity risk is elevated.` }];
    if (ph <= THR.pH.lowWarn)    return [{ level:'warning', title:'Low pH Warning',       desc:`pH at ${ph.toFixed(2)} is below the safe lower bound of ${THR.pH.lowWarn}. Check aeration.` }];
    if (ph >= THR.pH.highWarn)   return [{ level:'warning', title:'High pH Warning',      desc:`pH at ${ph.toFixed(2)} exceeds upper warning threshold of ${THR.pH.highWarn}. Consider partial water change.` }];
    return [];
  }

  function checkTemperature(r) {
    const t = r.temperature;
    if (t >= THR.temp.highDanger) return [{ level:'danger',  title:'Dangerously High Temperature', desc:`Water at ${t.toFixed(1)}°C. Above ${THR.temp.highDanger}°C fish experience severe stress and oxygen depletion.` }];
    if (t <= THR.temp.lowDanger)  return [{ level:'danger',  title:'Dangerously Low Temperature',  desc:`Water at ${t.toFixed(1)}°C. Metabolic activity drops critically below ${THR.temp.lowDanger}°C.` }];
    if (t >= THR.temp.highWarn)   return [{ level:'warning', title:'Elevated Temperature',         desc:`Temperature at ${t.toFixed(1)}°C is approaching the upper safe limit. Check cooling.` }];
    if (t <= THR.temp.lowWarn)    return [{ level:'warning', title:'Low Temperature',              desc:`Temperature at ${t.toFixed(1)}°C may slow feed conversion. Optimal: ${THR.temp.lowWarn}–${THR.temp.highWarn}°C.` }];
    return [];
  }

  function detectSpikes(cur, prev) {
    const insights = [];
    const dTurb = cur.turbidity - prev.turbidity;
    const dPH   = Math.abs(cur.pH - prev.pH);
    const dTemp = Math.abs(cur.temperature - prev.temperature);

    if (dTurb > 150) insights.push({ level:'warning', title:'Sudden Turbidity Spike',   desc:`Turbidity jumped ${dTurb.toFixed(0)} NTU in one cycle. May indicate algal bloom or external contamination.` });
    if (dPH   > 0.5) insights.push({ level:'warning', title:'Rapid pH Shift',           desc:`pH changed by ${dPH.toFixed(2)} units suddenly. Rapid swings are more stressful than gradual changes.` });
    if (dTemp > 3.0) insights.push({ level:'warning', title:'Temperature Fluctuation',  desc:`Temperature shifted ${dTemp.toFixed(1)}°C in a short period. Thermal shock can weaken fish immunity.` });
    return insights;
  }

  function analyseTrends(history) {
    const insights  = [];
    const turbSlope = slope(history.turbidity.slice(-TREND_WINDOW));
    const phSlope   = slope(history.pH.slice(-TREND_WINDOW));

    if (turbSlope > 25) {
      insights.push({ level:'warning', title:'Water Quality Degrading', desc:`Turbidity rising steadily over the last ${TREND_WINDOW} readings (trend: +${turbSlope.toFixed(0)} NTU/reading). Water change may be needed soon.` });
    }
    if (Math.abs(phSlope) > 0.08) {
      const dir = phSlope > 0 ? 'rising' : 'falling';
      insights.push({ level:'warning', title:`pH ${dir.charAt(0).toUpperCase() + dir.slice(1)} Trend`, desc:`pH has been steadily ${dir} (slope: ${phSlope.toFixed(3)}/reading). Check buffering capacity.` });
    }
    return insights;
  }

  // Least-squares linear regression slope
  function slope(values) {
    const n = values.length;
    if (n < 2) return 0;
    const sx  = n * (n - 1) / 2;
    const sx2 = n * (n - 1) * (2 * n - 1) / 6;
    const sy  = values.reduce((a, v) => a + v, 0);
    const sxy = values.reduce((a, v, i) => a + i * v, 0);
    const den = n * sx2 - sx * sx;
    return den === 0 ? 0 : (n * sxy - sx * sy) / den;
  }

  function recommendWaterChange(r) {
    const last = PumpModule.getLastActivated().drain;
    const hrs  = last ? (Date.now() - last.getTime()) / 3_600_000 : 9999;
    if (r.turbidity >= THR.turbidity.warning && hrs > 4) {
      return {
        level: 'warning',
        title: 'Water Change Recommended',
        desc:  `Turbidity is elevated. Last drain event: ${hrs > 900 ? 'not recorded' : hrs.toFixed(1) + ' hours ago'}. Consider activating drain + freshwater pumps.`,
      };
    }
    return null;
  }

  function advisePumps(r) {
    if (r.status === 'danger' && r.turbidity >= THR.turbidity.danger) {
      return [{
        level: 'danger',
        title: 'Activate Pumps Now',
        desc:  'Conditions are critical. Enable both pumps simultaneously: drain waste water and supply fresh water to dilute contaminants.',
      }];
    }
    return [];
  }

  function buildSummary(r) {
    const parts = [];
    if (r.turbidity >= THR.turbidity.warning)                              parts.push(`Turbidity: ${r.turbidity.toFixed(0)} NTU`);
    if (r.pH <= THR.pH.lowWarn || r.pH >= THR.pH.highWarn)                parts.push(`pH: ${r.pH.toFixed(2)}`);
    if (r.temperature <= THR.temp.lowWarn || r.temperature >= THR.temp.highWarn) parts.push(`Temp: ${r.temperature.toFixed(1)}°C`);
    return parts.length ? parts.join(' | ') : 'Parameters within safe range.';
  }

  return { analyse };

})();

// ═══════════════════════════════════════════════════════════════
// 7. ALERT LOG MODULE
// ═══════════════════════════════════════════════════════════════

const AlertLog = (() => {

  const logEl    = document.getElementById('alert-log');
  const clearBtn = document.getElementById('clear-alerts-btn');
  const MAX      = 50;

  let entries        = [];
  let lastEntryTime  = 0;
  let lastEntryLevel = '';

  // Debounce: don't add a new entry at the same level within 60 s
  function add(level, message) {
    const now = Date.now();
    if (level === lastEntryLevel && now - lastEntryTime < 60_000) return;
    lastEntryTime  = now;
    lastEntryLevel = level;

    const time = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    entries.unshift({ time, level, message });
    if (entries.length > MAX) entries.pop();
    render();
  }

  function render() {
    if (!entries.length) {
      logEl.innerHTML = '<p class="no-alerts-msg">No alerts recorded yet.</p>';
      return;
    }
    logEl.innerHTML = entries.map(e => `
      <div class="log-entry">
        <span class="log-time">${e.time}</span>
        <span class="log-level ${e.level}">${e.level}</span>
        <span class="log-msg">${esc(e.message)}</span>
      </div>`).join('');
  }

  function esc(str) {
    return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  clearBtn.addEventListener('click', () => {
    entries = []; lastEntryTime = 0; lastEntryLevel = '';
    render();
  });

  return { add };

})();

// ═══════════════════════════════════════════════════════════════
// 8. UI UTILITIES
// ═══════════════════════════════════════════════════════════════

const UIUtils = (() => {

  const alertBanner  = document.getElementById('alert-banner');
  const alertMessage = document.getElementById('alert-message');
  const alertClose   = document.getElementById('alert-close');
  const insightsEl   = document.getElementById('insights-panel');
  const deviceDot    = document.getElementById('device-dot');
  const deviceLabel  = document.getElementById('device-label');
  const deviceBadge  = document.getElementById('device-badge');
  const lastUpdEl    = document.getElementById('last-updated');

  alertClose.addEventListener('click', () => alertBanner.classList.add('hidden'));

  // ── Sensor card updates ──
  function updateSensorCards(r) {
    setCard('temp',  r.temperature, r.temperature / 50 * 100,   tempStatus(r.temperature));
    setCard('ph',    r.pH,          r.pH          / 14 * 100,   phStatus(r.pH));
    setCard('turb',  r.turbidity,   r.turbidity   / 3000 * 100, turbStatus(r.turbidity));
  }

  function setCard(id, value, pct, status) {
    const valEl  = document.getElementById(`${id}-val`);
    const barEl  = document.getElementById(`${id}-bar`);
    const pillEl = document.getElementById(`${id}-pill`);
    const cardEl = document.getElementById(`card-${id}`);

    if (valEl)  valEl.textContent = fmtVal(id, value);
    if (barEl) {
      barEl.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;
      barEl.classList.remove('bar-warning', 'bar-danger');
      if (status === 'warning') barEl.classList.add('bar-warning');
      if (status === 'danger')  barEl.classList.add('bar-danger');
    }
    if (pillEl) {
      pillEl.textContent  = statusLabel(status, id, value);
      pillEl.className    = `status-pill ${status}`;
    }
    if (cardEl) {
      cardEl.classList.remove('card-warning', 'card-danger');
      if (status === 'warning') cardEl.classList.add('card-warning');
      if (status === 'danger')  cardEl.classList.add('card-danger');
    }
  }

  function fmtVal(id, v) {
    if (id === 'ph')   return v.toFixed(2);
    if (id === 'temp') return v.toFixed(1);
    return Math.round(v).toString();
  }

  // ── Status label strings (matches original v1 pattern) ──
  function statusLabel(status, id, value) {
    if (id === 'temp') {
      if (value < THR.temp.lowWarn)  return '⬇ Too Cold';
      if (value > THR.temp.highWarn) return '⬆ Too Warm';
      return '✓ Optimal';
    }
    if (id === 'ph') {
      if (value < THR.pH.lowWarn)  return '⬇ Acidic';
      if (value > THR.pH.highWarn) return '⬆ Alkaline';
      return '✓ Balanced';
    }
    if (id === 'turb') {
      if (value < 50)  return '✓ Clear';
      if (value < 300) return '~ Moderate';
      return '⬆ Turbid';
    }
    return status;
  }

  // ── Status evaluation helpers ──
  function turbStatus(v) {
    if (v >= THR.turbidity.danger)  return 'danger';
    if (v >= THR.turbidity.warning) return 'warning';
    return 'safe';
  }
  function phStatus(v) {
    if (v <= THR.pH.lowDanger  || v >= THR.pH.highDanger)  return 'danger';
    if (v <= THR.pH.lowWarn    || v >= THR.pH.highWarn)    return 'warning';
    return 'safe';
  }
  function tempStatus(v) {
    if (v <= THR.temp.lowDanger  || v >= THR.temp.highDanger)  return 'danger';
    if (v <= THR.temp.lowWarn    || v >= THR.temp.highWarn)    return 'warning';
    return 'safe';
  }

  // ── Device online indicator ──
  function setDeviceStatus(online) {
    deviceDot.classList.toggle('online', online);
    deviceLabel.textContent = online ? 'Live Feed' : 'Offline';
    deviceBadge.classList.toggle('online-state', online);
  }

  // ── Last-updated timestamp ──
  function updateLastUpdated() {
    lastUpdEl.textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  // ── Alert banner ──
  function updateAlertBanner(insights) {
    const hasIssue = insights.some(i => i.level !== 'safe');
    if (!hasIssue) { alertBanner.classList.add('hidden'); return; }

    const topLevel  = insights.reduce((a, i) => {
      if (i.level === 'danger')  return 'danger';
      if (i.level === 'warning' && a !== 'danger') return 'warning';
      return a;
    }, 'safe');

    const top = insights.find(i => i.level === topLevel);
    alertMessage.textContent = top ? top.desc : 'Parameter alert.';
    alertBanner.classList.remove('hidden', 'danger-banner');
    if (topLevel === 'danger') alertBanner.classList.add('danger-banner');
  }

  // ── Insights panel ──
  function renderInsights(insights) {
    insightsEl.innerHTML = insights.map((ins, i) => `
      <div class="insight-item" style="animation-delay:${i * 0.05}s">
        <div class="insight-dot ${ins.level}"></div>
        <div>
          <p class="insight-title">${ins.title}</p>
          <p class="insight-desc">${ins.desc}</p>
        </div>
      </div>`).join('');
  }

  return {
    updateSensorCards,
    setDeviceStatus,
    updateLastUpdated,
    updateAlertBanner,
    renderInsights,
  };

})();

// ═══════════════════════════════════════════════════════════════
// 9. APP CORE — Module lifecycle orchestrator
// ═══════════════════════════════════════════════════════════════

const AppCore = (() => {

  let ready = false;

  function start() {
    if (!ready) {
      ChartModule.init();
      PumpModule.init();
      ready = true;
    }
    DataModule.start();
  }

  function stop() {
    DataModule.stop();
  }

  return { start, stop };

})();
