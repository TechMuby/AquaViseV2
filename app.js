/**
 * AquaVise — app.js
 * Full-stack IoT Web Application Logic
 *
 * Sections:
 *   1. Firebase Configuration & Initialization
 *   2. Auth Module
 *   3. Realtime Data Module
 *   4. Chart Module
 *   5. Pump Control Module
 *   6. AI Insights Engine (rule-based)
 *   7. Alert Log Module
 *   8. UI Utilities
 *   9. Bootstrap
 */

// ═══════════════════════════════════════════════════════════════
// 1. FIREBASE CONFIGURATION & INITIALIZATION
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

// Firebase Realtime Database paths — must match ESP32 firmware exactly
const DB_PATHS = {
  sensors:       "/aquavise/sensors",
  cmdFresh:      "/aquavise/commands/freshwaterPump",
  cmdDrain:      "/aquavise/commands/drainPump",
  stateFresh:    "/aquavise/state/freshwaterPump",
  stateDrain:    "/aquavise/state/drainPump",
  stateAlert:    "/aquavise/state/alert",
  deviceOnline:  "/aquavise/state/deviceOnline",
  history:       "/aquavise/history",
};

// Safety thresholds (mirror of ESP32 constants — single source of truth in production)
const THRESHOLDS = {
  turbidity: { warning: 300,  danger: 600  },   // NTU
  pH:        { low_warn: 6.5, high_warn: 8.5, low_danger: 6.0, high_danger: 9.0 },
  temp:      { low_warn: 18,  high_warn: 30,  low_danger: 15,  high_danger: 33  }, // °C
};

firebase.initializeApp(FIREBASE_CONFIG);

const auth     = firebase.auth();
const database = firebase.database();

// ═══════════════════════════════════════════════════════════════
// 2. AUTH MODULE
// ═══════════════════════════════════════════════════════════════

const AuthModule = (() => {
  const authScreen  = document.getElementById("auth-screen");
  const appScreen   = document.getElementById("app");
  const loginForm   = document.getElementById("login-form");
  const signupForm  = document.getElementById("signup-form");
  const loginError  = document.getElementById("login-error");
  const signupError = document.getElementById("signup-error");
  const logoutBtn   = document.getElementById("logout-btn");
  const footerEmail = document.getElementById("footer-user-email");

  // Tab switching
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`${tab.dataset.tab}-form`).classList.add("active");
    });
  });

  // Login
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email    = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    setFormLoading("login-btn", true);
    hideError(loginError);
    try {
      await auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      showError(loginError, friendlyAuthError(err.code));
    } finally {
      setFormLoading("login-btn", false);
    }
  });

  // Sign Up
  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email    = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    if (password.length < 8) {
      showError(signupError, "Password must be at least 8 characters.");
      return;
    }
    setFormLoading("signup-btn", true);
    hideError(signupError);
    try {
      await auth.createUserWithEmailAndPassword(email, password);
    } catch (err) {
      showError(signupError, friendlyAuthError(err.code));
    } finally {
      setFormLoading("signup-btn", false);
    }
  });

  // Logout
  logoutBtn.addEventListener("click", () => auth.signOut());

  // Auth State Listener
  auth.onAuthStateChanged(user => {
    if (user) {
      authScreen.classList.add("hidden");
      appScreen.classList.remove("hidden");
      footerEmail.textContent = user.email;
      AppCore.start();
    } else {
      authScreen.classList.remove("hidden");
      appScreen.classList.add("hidden");
      AppCore.stop();
    }
  });

  function setFormLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    btn.disabled = loading;
    btn.querySelector(".btn-label").classList.toggle("hidden", loading);
    btn.querySelector(".btn-spinner").classList.toggle("hidden", !loading);
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function hideError(el) {
    el.classList.add("hidden");
  }

  function friendlyAuthError(code) {
    const map = {
      "auth/user-not-found":      "No account found with that email.",
      "auth/wrong-password":      "Incorrect password. Try again.",
      "auth/invalid-email":       "Please enter a valid email address.",
      "auth/email-already-in-use":"An account already exists with this email.",
      "auth/weak-password":       "Password is too weak.",
      "auth/too-many-requests":   "Too many attempts. Please wait and try again.",
    };
    return map[code] || "Authentication failed. Please try again.";
  }
})();

// ═══════════════════════════════════════════════════════════════
// 3. REALTIME DATA MODULE
// ═══════════════════════════════════════════════════════════════

const DataModule = (() => {
  // Holds the last N readings for chart and AI analysis
  const HISTORY_BUFFER_SIZE = 100;
  const history = {
    turbidity:   [],
    pH:          [],
    temperature: [],
    timestamps:  [],
  };

  let activeListeners = [];

  function start() {
    // Listen to live sensor data
    const sensorRef = database.ref(DB_PATHS.sensors);
    const sensorHandler = sensorRef.on("value", snapshot => {
      const data = snapshot.val();
      if (!data) return;

      const reading = {
        turbidity:   parseFloat(data.turbidity)   || 0,
        pH:          parseFloat(data.pH)           || 7,
        temperature: parseFloat(data.temperature)  || 25,
        status:      data.status || "safe",
        timestamp:   data.timestamp || Date.now(),
      };

      // Push to rolling history buffer
      history.turbidity.push(reading.turbidity);
      history.pH.push(reading.pH);
      history.temperature.push(reading.temperature);
      history.timestamps.push(formatTimestamp(reading.timestamp));

      if (history.turbidity.length > HISTORY_BUFFER_SIZE) {
        history.turbidity.shift();
        history.pH.shift();
        history.temperature.shift();
        history.timestamps.shift();
      }

      // Update UI
      UIModule.updateSensorCards(reading);
      ChartModule.update(history, ChartModule.getRange());
      AIEngine.analyse(reading, history);
    });

    // Listen to device online state
    const onlineRef = database.ref(DB_PATHS.deviceOnline);
    const onlineHandler = onlineRef.on("value", snapshot => {
      UIModule.updateDeviceStatus(snapshot.val() === true);
    });

    // Listen to pump states (reflects what the device actually did)
    const freshRef = database.ref(DB_PATHS.stateFresh);
    const freshHandler = freshRef.on("value", snapshot => {
      PumpModule.syncState("fresh", snapshot.val() === true);
    });

    const drainRef = database.ref(DB_PATHS.stateDrain);
    const drainHandler = drainRef.on("value", snapshot => {
      PumpModule.syncState("drain", snapshot.val() === true);
    });

    activeListeners = [
      { ref: sensorRef,  handler: sensorHandler,  event: "value" },
      { ref: onlineRef,  handler: onlineHandler,  event: "value" },
      { ref: freshRef,   handler: freshHandler,   event: "value" },
      { ref: drainRef,   handler: drainHandler,   event: "value" },
    ];
  }

  function stop() {
    activeListeners.forEach(({ ref, handler, event }) => {
      ref.off(event, handler);
    });
    activeListeners = [];
  }

  function getHistory() { return history; }

  function formatTimestamp(ts) {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}`;
  }

  return { start, stop, getHistory };
})();

// ═══════════════════════════════════════════════════════════════
// 4. CHART MODULE
// ═══════════════════════════════════════════════════════════════

const ChartModule = (() => {
  let range = 20;
  let charts = {};

  const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    interaction: { intersect: false, mode: "index" },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#0d1a2d",
        titleColor: "#7ca0c0",
        bodyColor: "#e2edf7",
        borderColor: "#1a3050",
        borderWidth: 1,
        padding: 10,
        titleFont: { family: "'DM Mono', monospace", size: 11 },
        bodyFont:  { family: "'DM Mono', monospace", size: 12 },
      },
    },
    scales: {
      x: {
        grid:  { color: "rgba(26,48,80,0.6)", drawBorder: false },
        ticks: { color: "#3d6080", font: { family: "'DM Mono', monospace", size: 10 }, maxTicksLimit: 8 },
      },
      y: {
        grid:  { color: "rgba(26,48,80,0.6)", drawBorder: false },
        ticks: { color: "#3d6080", font: { family: "'DM Mono', monospace", size: 10 } },
      },
    },
  };

  function buildDataset(label, color, data) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: color.replace("rgb", "rgba").replace(")", ",0.08)"),
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 5,
      fill: true,
      tension: 0.4,
    };
  }

  function init() {
    // Destroy any previous instances
    Object.values(charts).forEach(c => c.destroy());
    charts = {};

    charts.turbidity = new Chart(
      document.getElementById("chart-turbidity").getContext("2d"),
      {
        type: "line",
        data: { labels: [], datasets: [buildDataset("Turbidity", "rgb(56,189,248)", [])] },
        options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, suggestedMax: 700 } } },
      }
    );

    charts.ph = new Chart(
      document.getElementById("chart-ph").getContext("2d"),
      {
        type: "line",
        data: { labels: [], datasets: [buildDataset("pH", "rgb(167,139,250)", [])] },
        options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, max: 14 } } },
      }
    );

    charts.temperature = new Chart(
      document.getElementById("chart-temperature").getContext("2d"),
      {
        type: "line",
        data: { labels: [], datasets: [buildDataset("Temperature", "rgb(251,113,133)", [])] },
        options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, min: 0, suggestedMax: 40 } } },
      }
    );

    // Range buttons
    document.querySelectorAll(".chart-range-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".chart-range-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        range = parseInt(btn.dataset.range);
        update(DataModule.getHistory(), range);
      });
    });
  }

  function update(history, n) {
    const slice = (arr) => arr.slice(-n);
    const labels = slice(history.timestamps);

    charts.turbidity.data.labels                 = labels;
    charts.turbidity.data.datasets[0].data       = slice(history.turbidity);
    charts.ph.data.labels                        = labels;
    charts.ph.data.datasets[0].data              = slice(history.pH);
    charts.temperature.data.labels               = labels;
    charts.temperature.data.datasets[0].data     = slice(history.temperature);

    charts.turbidity.update("none");
    charts.ph.update("none");
    charts.temperature.update("none");
  }

  function getRange() { return range; }

  return { init, update, getRange };
})();

// ═══════════════════════════════════════════════════════════════
// 5. PUMP CONTROL MODULE
// ═══════════════════════════════════════════════════════════════

const PumpModule = (() => {
  // Track last-activated timestamps locally
  const lastOn = { fresh: null, drain: null };
  // Track whether UI-initiated toggle is in-flight to prevent feedback loop
  let freshPending = false;
  let drainPending = false;

  function init() {
    const toggleFresh = document.getElementById("toggle-fresh");
    const toggleDrain = document.getElementById("toggle-drain");

    toggleFresh.addEventListener("change", async () => {
      if (freshPending) return;
      freshPending = true;
      const value = toggleFresh.checked;
      if (value) lastOn.fresh = new Date();
      try {
        await database.ref(DB_PATHS.cmdFresh).set(value);
        updateLastOnLabel("fresh");
      } catch (err) {
        console.error("[Pump] Failed to set freshwater command:", err);
        toggleFresh.checked = !value; // rollback
      } finally {
        freshPending = false;
      }
    });

    toggleDrain.addEventListener("change", async () => {
      if (drainPending) return;
      drainPending = true;
      const value = toggleDrain.checked;
      if (value) lastOn.drain = new Date();
      try {
        await database.ref(DB_PATHS.cmdDrain).set(value);
        updateLastOnLabel("drain");
      } catch (err) {
        console.error("[Pump] Failed to set drain command:", err);
        toggleDrain.checked = !value;
      } finally {
        drainPending = false;
      }
    });
  }

  // Called by DataModule when Firebase state is updated by the device
  function syncState(pump, isOn) {
    const toggle = document.getElementById(`toggle-${pump}`);
    const badge  = document.getElementById(`${pump}-state-badge`);
    const card   = document.getElementById(`card-pump-${pump}`);

    if (toggle) toggle.checked = isOn;
    if (badge) {
      badge.textContent = isOn ? "ON" : "OFF";
      badge.classList.toggle("on", isOn);
    }
    if (card) card.classList.toggle("active", isOn);
  }

  function updateLastOnLabel(pump) {
    const el = document.getElementById(`${pump}-last-on`);
    if (!el || !lastOn[pump]) return;
    el.textContent = formatRelativeTime(lastOn[pump]);
  }

  function formatRelativeTime(date) {
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60)    return "Just now";
    if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`;
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function getLastOn() { return lastOn; }

  return { init, syncState, getLastOn };
})();

// ═══════════════════════════════════════════════════════════════
// 6. AI INSIGHTS ENGINE (Rule-Based Intelligent Analysis)
// ═══════════════════════════════════════════════════════════════

const AIEngine = (() => {
  // Internal memory for trend and spike detection
  let previousReading = null;
  let degradationWindow = [];          // Rolling window for 6-reading trend
  const DEGRADATION_WINDOW_SIZE = 6;

  // Track when issues were first detected
  const issueOnsetTimes = {};

  /**
   * Main analysis function — called on every new sensor reading.
   * Generates a structured list of insight objects and renders them.
   */
  function analyse(reading, history) {
    const insights = [];

    // ── Threshold Checks ────────────────────────────────────────
    insights.push(...checkTurbidity(reading));
    insights.push(...checkPH(reading));
    insights.push(...checkTemperature(reading));

    // ── Spike Detection (sudden change vs previous reading) ─────
    if (previousReading) {
      insights.push(...detectSpikes(reading, previousReading));
    }

    // ── Trend Analysis (over last N readings) ───────────────────
    if (history.turbidity.length >= DEGRADATION_WINDOW_SIZE) {
      insights.push(...analyseTrends(history));
    }

    // ── Water Change Recommendation ──────────────────────────────
    const waterChangeInsight = recommendWaterChange(reading);
    if (waterChangeInsight) insights.push(waterChangeInsight);

    // ── Pump Status Advisory ─────────────────────────────────────
    insights.push(...advisePumpAction(reading));

    // Fallback: all-clear message
    if (insights.length === 0) {
      insights.push({
        level: "safe",
        title: "All Parameters Normal",
        desc:  "Water quality is within optimal range. No action required.",
      });
    }

    UIModule.renderInsights(insights);
    AlertLogModule.addEntry(reading.status, buildAlertSummary(reading));
    UIModule.updateAlertBanner(reading, insights);

    previousReading = { ...reading };
  }

  function checkTurbidity(r) {
    const insights = [];
    if (r.turbidity >= THRESHOLDS.turbidity.danger) {
      insights.push({
        level: "danger",
        title: "Critical Turbidity",
        desc:  `Turbidity is ${r.turbidity.toFixed(1)} NTU — far above the danger threshold of ${THRESHOLDS.turbidity.danger} NTU. Immediate water change recommended.`,
      });
    } else if (r.turbidity >= THRESHOLDS.turbidity.warning) {
      insights.push({
        level: "warning",
        title: "Elevated Turbidity",
        desc:  `Turbidity at ${r.turbidity.toFixed(1)} NTU. Approaching dangerous levels (>${THRESHOLDS.turbidity.danger} NTU). Monitor closely.`,
      });
    }
    return insights;
  }

  function checkPH(r) {
    const insights = [];
    const ph = r.pH;
    if (ph <= THRESHOLDS.pH.low_danger) {
      insights.push({ level: "danger", title: "Critically Low pH", desc: `pH is ${ph.toFixed(2)} — dangerously acidic. This level is lethal for most aquatic species. Immediate intervention required.` });
    } else if (ph >= THRESHOLDS.pH.high_danger) {
      insights.push({ level: "danger", title: "Critically High pH", desc: `pH is ${ph.toFixed(2)} — dangerously alkaline. Ammonia toxicity risk is elevated. Take corrective action now.` });
    } else if (ph <= THRESHOLDS.pH.low_warn) {
      insights.push({ level: "warning", title: "Low pH Warning", desc: `pH at ${ph.toFixed(2)} is below the safe lower bound of ${THRESHOLDS.pH.low_warn}. Check aeration and CO₂ levels.` });
    } else if (ph >= THRESHOLDS.pH.high_warn) {
      insights.push({ level: "warning", title: "High pH Warning", desc: `pH at ${ph.toFixed(2)} exceeds the upper warning threshold of ${THRESHOLDS.pH.high_warn}. Consider partial water replacement.` });
    }
    return insights;
  }

  function checkTemperature(r) {
    const insights = [];
    const t = r.temperature;
    if (t >= THRESHOLDS.temp.high_danger) {
      insights.push({ level: "danger", title: "Dangerously High Temperature", desc: `Water temperature is ${t.toFixed(1)}°C. Above ${THRESHOLDS.temp.high_danger}°C fish experience severe stress and oxygen depletion.` });
    } else if (t <= THRESHOLDS.temp.low_danger) {
      insights.push({ level: "danger", title: "Dangerously Low Temperature", desc: `Water temperature is ${t.toFixed(1)}°C. Below ${THRESHOLDS.temp.low_danger}°C metabolic activity drops critically.` });
    } else if (t >= THRESHOLDS.temp.high_warn) {
      insights.push({ level: "warning", title: "Elevated Temperature", desc: `Temperature at ${t.toFixed(1)}°C is approaching the upper safe limit. Check for shade cover or cooling systems.` });
    } else if (t <= THRESHOLDS.temp.low_warn) {
      insights.push({ level: "warning", title: "Low Temperature", desc: `Temperature at ${t.toFixed(1)}°C may slow feed conversion. Optimal range: ${THRESHOLDS.temp.low_warn}–${THRESHOLDS.temp.high_warn}°C.` });
    }
    return insights;
  }

  function detectSpikes(current, previous) {
    const insights = [];
    const turbDiff = current.turbidity   - previous.turbidity;
    const phDiff   = Math.abs(current.pH - previous.pH);
    const tempDiff = Math.abs(current.temperature - previous.temperature);

    if (turbDiff > 150) {
      insights.push({
        level: "warning",
        title: "Sudden Turbidity Spike",
        desc:  `Turbidity jumped by ${turbDiff.toFixed(0)} NTU in one reading. This may indicate fish activity, algal bloom, or external contamination.`,
      });
    }
    if (phDiff > 0.5) {
      insights.push({
        level: "warning",
        title: "Rapid pH Shift",
        desc:  `pH changed by ${phDiff.toFixed(2)} units suddenly. Rapid pH swings are more stressful to fish than gradual changes. Investigate cause.`,
      });
    }
    if (tempDiff > 3) {
      insights.push({
        level: "warning",
        title: "Temperature Fluctuation",
        desc:  `Temperature shifted by ${tempDiff.toFixed(1)}°C in a short period. Thermal shock can weaken fish immune systems.`,
      });
    }
    return insights;
  }

  function analyseTrends(history) {
    const insights = [];
    const n = DEGRADATION_WINDOW_SIZE;

    // Compute simple linear regression slope for turbidity over last N readings
    const turbSlope  = computeSlope(history.turbidity.slice(-n));
    const phSlope    = computeSlope(history.pH.slice(-n));

    if (turbSlope > 30) {
      insights.push({
        level: "warning",
        title: "Water Quality Degrading",
        desc:  `Turbidity has been rising consistently over the last ${n} readings (trend: +${turbSlope.toFixed(0)} NTU/reading). A water change may be needed soon.`,
      });
    }

    if (Math.abs(phSlope) > 0.1) {
      const dir = phSlope > 0 ? "rising" : "falling";
      insights.push({
        level: "warning",
        title: `pH ${dir.charAt(0).toUpperCase() + dir.slice(1)} Trend`,
        desc:  `pH has been steadily ${dir} over recent readings (slope: ${phSlope.toFixed(3)}/reading). Check buffering capacity of the water.`,
      });
    }

    return insights;
  }

  /**
   * computeSlope() — least squares linear regression on y-values.
   * Returns slope (change per reading index).
   */
  function computeSlope(values) {
    const n = values.length;
    if (n < 2) return 0;
    const sumX  = n * (n - 1) / 2;
    const sumX2 = n * (n - 1) * (2 * n - 1) / 6;
    const sumY  = values.reduce((a, v) => a + v, 0);
    const sumXY = values.reduce((acc, v, i) => acc + i * v, 0);
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return 0;
    return (n * sumXY - sumX * sumY) / denom;
  }

  function recommendWaterChange(r) {
    const pumpLastOn = PumpModule.getLastOn();
    const lastDrainTime = pumpLastOn.drain;
    const now = Date.now();
    const hoursSinceLastChange = lastDrainTime
      ? (now - lastDrainTime.getTime()) / 3_600_000
      : 999;

    // Recommend if turbidity is high and no water change in > 4 hours
    if (r.turbidity >= THRESHOLDS.turbidity.warning && hoursSinceLastChange > 4) {
      return {
        level: "warning",
        title: "Water Change Recommended",
        desc:  `Turbidity is elevated and the last recorded drain event was ${
          hoursSinceLastChange > 900 ? "not recorded" : `${hoursSinceLastChange.toFixed(1)} hours ago`
        }. Consider activating the drain + freshwater pumps.`,
      };
    }
    return null;
  }

  function advisePumpAction(r) {
    const insights = [];
    const status = r.status;

    if (status === "danger" && r.turbidity >= THRESHOLDS.turbidity.danger) {
      insights.push({
        level: "danger",
        title: "Activate Freshwater Pump",
        desc:  "Water conditions are critical. Enable the freshwater pump to dilute contaminants and simultaneously activate the drain pump to remove waste water.",
      });
    }
    return insights;
  }

  function buildAlertSummary(r) {
    const parts = [];
    if (r.turbidity >= THRESHOLDS.turbidity.warning) parts.push(`Turbidity: ${r.turbidity.toFixed(0)} NTU`);
    if (r.pH <= THRESHOLDS.pH.low_warn || r.pH >= THRESHOLDS.pH.high_warn) parts.push(`pH: ${r.pH.toFixed(2)}`);
    if (r.temperature <= THRESHOLDS.temp.low_warn || r.temperature >= THRESHOLDS.temp.high_warn) parts.push(`Temp: ${r.temperature.toFixed(1)}°C`);
    if (parts.length === 0) return "Parameters within safe range.";
    return parts.join(" | ");
  }

  return { analyse };
})();

// ═══════════════════════════════════════════════════════════════
// 7. ALERT LOG MODULE
// ═══════════════════════════════════════════════════════════════

const AlertLogModule = (() => {
  const log       = document.getElementById("alert-log");
  const clearBtn  = document.getElementById("clear-alerts-btn");
  const MAX_ENTRIES = 50;
  let entries = [];

  // Only add a new entry if status has changed or it's been > 60 s since last
  let lastEntryTime  = 0;
  let lastEntryLevel = "";

  function addEntry(level, message) {
    const now = Date.now();
    if (level === lastEntryLevel && now - lastEntryTime < 60_000) return;
    lastEntryTime  = now;
    lastEntryLevel = level;

    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    entries.unshift({ time, level, message });
    if (entries.length > MAX_ENTRIES) entries.pop();
    render();
  }

  function render() {
    if (entries.length === 0) {
      log.innerHTML = '<p class="no-alerts">No alerts recorded yet.</p>';
      return;
    }
    log.innerHTML = entries.map(e => `
      <div class="log-entry">
        <span class="log-time">${e.time}</span>
        <span class="log-level ${e.level}">${e.level}</span>
        <span class="log-msg">${escapeHtml(e.message)}</span>
      </div>
    `).join("");
  }

  clearBtn.addEventListener("click", () => {
    entries = [];
    lastEntryTime  = 0;
    lastEntryLevel = "";
    render();
  });

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  return { addEntry };
})();

// ═══════════════════════════════════════════════════════════════
// 8. UI UTILITIES MODULE
// ═══════════════════════════════════════════════════════════════

const UIModule = (() => {
  const alertBanner  = document.getElementById("alert-banner");
  const alertMessage = document.getElementById("alert-message");
  const alertClose   = document.getElementById("alert-close");
  const deviceDot    = document.getElementById("device-dot");
  const deviceLabel  = document.getElementById("device-label");
  const insightsPanel= document.getElementById("insights-panel");
  const lastUpdated  = document.getElementById("last-updated-time");

  alertClose.addEventListener("click", () => alertBanner.classList.add("hidden"));

  function updateSensorCards(reading) {
    const now = new Date();
    lastUpdated.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    setSensorCard("turb",  reading.turbidity,   reading.turbidity / 3000 * 100, reading.status);
    setSensorCard("ph",    reading.pH,           reading.pH / 14 * 100,          phStatus(reading.pH));
    setSensorCard("temp",  reading.temperature,  reading.temperature / 40 * 100, tempStatus(reading.temperature));
  }

  function setSensorCard(prefix, value, pct, status) {
    const valueEl  = document.getElementById(`${prefix}-value`);
    const barEl    = document.getElementById(`${prefix}-bar`);
    const statusEl = document.getElementById(`${prefix}-status`);
    const cardId   = prefix === "turb" ? "card-turbidity" : prefix === "ph" ? "card-ph" : "card-temp";
    const cardEl   = document.getElementById(cardId);

    if (valueEl) valueEl.textContent = formatValue(prefix, value);
    if (barEl) {
      barEl.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;
      barEl.className = `sensor-bar ${status}`;
    }
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className   = `status-pill ${status}`;
    }
    if (cardEl) {
      cardEl.classList.remove("warning-card", "danger-card");
      if (status === "warning") cardEl.classList.add("warning-card");
      if (status === "danger")  cardEl.classList.add("danger-card");
    }
  }

  function formatValue(prefix, value) {
    if (prefix === "ph")   return value.toFixed(2);
    if (prefix === "temp") return value.toFixed(1);
    return value.toFixed(0);
  }

  function phStatus(ph) {
    if (ph <= THRESHOLDS.pH.low_danger  || ph >= THRESHOLDS.pH.high_danger)  return "danger";
    if (ph <= THRESHOLDS.pH.low_warn    || ph >= THRESHOLDS.pH.high_warn)    return "warning";
    return "safe";
  }

  function tempStatus(t) {
    if (t <= THRESHOLDS.temp.low_danger  || t >= THRESHOLDS.temp.high_danger)  return "danger";
    if (t <= THRESHOLDS.temp.low_warn    || t >= THRESHOLDS.temp.high_warn)    return "warning";
    return "safe";
  }

  function updateDeviceStatus(isOnline) {
    deviceDot.classList.toggle("online", isOnline);
    deviceLabel.textContent = isOnline ? "Online" : "Offline";
  }

  function updateAlertBanner(reading, insights) {
    const hasIssue = insights.some(i => i.level !== "safe");
    const topLevel = insights.reduce((acc, i) => {
      if (i.level === "danger")  return "danger";
      if (i.level === "warning" && acc !== "danger") return "warning";
      return acc;
    }, "safe");

    if (!hasIssue) {
      alertBanner.classList.add("hidden");
      return;
    }

    const topInsight = insights.find(i => i.level === topLevel);
    alertMessage.textContent = topInsight ? topInsight.desc : "Parameter alert.";
    alertBanner.classList.remove("hidden", "danger-banner");
    if (topLevel === "danger") alertBanner.classList.add("danger-banner");
  }

  function renderInsights(insights) {
    insightsPanel.innerHTML = insights.map((ins, i) => `
      <div class="insight-item" style="animation-delay:${i * 0.05}s">
        <div class="insight-dot ${ins.level}"></div>
        <div class="insight-content">
          <p class="insight-title">${ins.title}</p>
          <p class="insight-desc">${ins.desc}</p>
        </div>
      </div>
    `).join("");
  }

  return { updateSensorCards, updateDeviceStatus, renderInsights, updateAlertBanner };
})();

// ═══════════════════════════════════════════════════════════════
// 9. APP CORE — Orchestrates module lifecycle
// ═══════════════════════════════════════════════════════════════

const AppCore = (() => {
  let initialized = false;

  function start() {
    if (!initialized) {
      ChartModule.init();
      PumpModule.init();
      initialized = true;
    }
    DataModule.start();
  }

  function stop() {
    DataModule.stop();
  }

  return { start, stop };
})();
