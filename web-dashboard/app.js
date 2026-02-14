/* ============================================================
   Guardian-Track Dashboard v2 — Liquid Glass
   ============================================================ */

// ============================================================
//  STATE
// ============================================================
let port = null;
let reader = null;
let writer = null;
let connected = false;
let lineBuffer = '';

const state = {
  students: [],
  stats: { classroom: 0, hostel: 0, left: 0, sneaked: 0 },
  mode: 'free',
  alerts: [],
  activeTab: 'map',
  unreadAlerts: 0
};

const LOC = {
  UNKNOWN: 0, CLASSROOM: 1, HOSTEL: 2, AT_GATE: 3, LEFT: 4, SNEAKED: 5
};

const LOC_NAMES = {
  [LOC.UNKNOWN]: 'Unknown', [LOC.CLASSROOM]: 'Classroom', [LOC.HOSTEL]: 'Hostel',
  [LOC.AT_GATE]: 'At Gate', [LOC.LEFT]: 'Left', [LOC.SNEAKED]: 'Sneaked'
};

const LOC_CSS = {
  [LOC.UNKNOWN]: 'unknown', [LOC.CLASSROOM]: 'classroom', [LOC.HOSTEL]: 'hostel',
  [LOC.AT_GATE]: 'gate', [LOC.LEFT]: 'left', [LOC.SNEAKED]: 'sneaked'
};

const ZONE_POSITIONS = {
  classroom: [
    { x: 150, y: 190 }, { x: 200, y: 210 }, { x: 250, y: 185 },
    { x: 180, y: 240 }, { x: 280, y: 230 }
  ],
  hostel: [
    { x: 500, y: 190 }, { x: 550, y: 210 }, { x: 610, y: 185 },
    { x: 530, y: 240 }, { x: 640, y: 230 }
  ],
  gate: [
    { x: 370, y: 420 }, { x: 400, y: 435 }, { x: 430, y: 420 },
    { x: 385, y: 445 }, { x: 415, y: 445 }
  ],
  outside: [
    { x: 330, y: 490 }, { x: 370, y: 495 }, { x: 410, y: 490 },
    { x: 440, y: 495 }, { x: 470, y: 490 }
  ]
};

const STUDENT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'];

// ============================================================
//  DOM ELEMENTS
// ============================================================
const els = {
  btnConnect: document.getElementById('btn-connect'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  modeBadge: document.getElementById('mode-badge'),
  modeCheckbox: document.getElementById('mode-checkbox'),
  settingsModeCheckbox: document.getElementById('settings-mode-checkbox'),
  toggleText: document.getElementById('toggle-text'),
  settingsModeText: document.getElementById('settings-mode-text'),
  statSchool: document.getElementById('stat-school-count'),
  statClass: document.getElementById('stat-class-count'),
  statHostel: document.getElementById('stat-hostel-count'),
  statLeft: document.getElementById('stat-left-count'),
  statSneaked: document.getElementById('stat-sneaked-count'),
  statLeftMobile: document.getElementById('stat-left-count-mobile'),
  statSneakedMobile: document.getElementById('stat-sneaked-count-mobile'),
  studentList: document.getElementById('student-list'),
  studentTotal: document.getElementById('student-total'),
  alertsList: document.getElementById('alerts-list'),
  btnClearAlerts: document.getElementById('btn-clear-alerts'),
  btnDemo: document.getElementById('btn-demo'),
  alertSound: document.getElementById('alert-sound'),
  schoolMap: document.getElementById('school-map'),
  alertBadge: document.getElementById('alert-badge'),
  bottomNav: document.getElementById('bottom-nav'),
  dashboard: document.getElementById('dashboard')
};

// ============================================================
//  WEB SERIAL API
// ============================================================
async function connectSerial() {
  if (connected) { disconnectSerial(); return; }

  if (!('serial' in navigator)) {
    addAlert('critical', 'Web Serial API not supported. Use Chrome/Edge/Brave.');
    return;
  }

  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    connected = true;
    updateConnectionUI(true);
    addAlert('success', 'Connected to Arduino');

    const textDecoder = new TextDecoderStream();
    port.readable.pipeTo(textDecoder.writable);
    reader = textDecoder.readable.getReader();

    const textEncoder = new TextEncoderStream();
    textEncoder.readable.pipeTo(port.writable);
    writer = textEncoder.writable.getWriter();

    sendCommand('SYNC');
    readLoop();
  } catch (err) {
    addAlert('critical', 'Connection failed: ' + err.message);
  }
}

async function disconnectSerial() {
  try {
    if (reader) { reader.cancel(); reader = null; }
    if (writer) { writer.close(); writer = null; }
    if (port) { await port.close(); port = null; }
  } catch (e) { /* ignore */ }

  connected = false;
  updateConnectionUI(false);
  addAlert('info', 'Disconnected from Arduino');
}

async function readLoop() {
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuffer += value;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) processLine(line.trim());
      }
    }
  } catch (e) {
    if (connected) disconnectSerial();
  }
}

async function sendCommand(cmd) {
  if (!writer) return;
  try { await writer.write(cmd + '\n'); } catch (e) { /* ignore */ }
}

// ============================================================
//  MESSAGE PARSING
// ============================================================
function processLine(line) {
  try {
    if (line.startsWith('{')) {
      const data = JSON.parse(line);
      handleEvent(data);
    }
  } catch (e) { /* skip non-JSON lines */ }
}

function handleEvent(data) {
  switch (data.event) {
    case 'student_info': handleStudentInfo(data); break;
    case 'status': handleStatusUpdate(data); break;
    case 'scan': handleScan(data); break;
    case 'approved': handleApproved(data); break;
    case 'sneaked': handleSneaked(data); break;
    case 'zone_change': handleZoneChange(data); break;
    case 'alarm': handleAlarm(data); break;
    case 'mode_change': handleModeChange(data); break;
    case 'unknown_card': addAlert('warning', `Unknown card at ${data.zone || 'reader'}`); break;
    case 'boot': addAlert('success', 'Arduino booted successfully'); break;
  }
}

// ============================================================
//  EVENT HANDLERS
// ============================================================
function handleStudentInfo(data) {
  const existing = state.students.find(s => s.id === data.id);
  if (existing) {
    Object.assign(existing, data);
  } else {
    state.students.push({
      id: data.id, name: data.name, classGrade: data.class,
      dormRoom: data.dorm, contact: data.contact, location: data.location
    });
  }
  els.studentTotal.textContent = state.students.length + ' registered';
  renderStudentList();
  renderMapDots();
}

function handleStatusUpdate(data) {
  state.stats.classroom = data.classroom || 0;
  state.stats.hostel = data.hostel || 0;
  state.stats.left = data.left || 0;
  state.stats.sneaked = data.sneaked || 0;
  if (data.mode) {
    state.mode = data.mode;
    updateModeUI();
  }
  updateStatsUI();
}

function handleScan(data) {
  const s = state.students.find(s => s.name === data.student);
  if (s) { s.location = LOC.AT_GATE; renderStudentList(); renderMapDots(); }
  addAlert('warning', `🚪 ${data.student} at gate — awaiting approval`);
}

function handleApproved(data) {
  const s = state.students.find(s => s.name === data.student);
  if (s) { s.location = LOC.LEFT; renderStudentList(); renderMapDots(); }
  addAlert('success', `✅ ${data.student} — exit approved`);
}

function handleSneaked(data) {
  const s = state.students.find(s => s.name === data.student);
  if (s) { s.location = LOC.SNEAKED; renderStudentList(); renderMapDots(); }
  addAlert('critical', `🚨 ALERT: ${data.student} sneaked out!`);
  playAlertSound();
  vibrateDevice();
  document.body.classList.add('sneak-alert-active');
  setTimeout(() => document.body.classList.remove('sneak-alert-active'), 2000);
}

function handleZoneChange(data) {
  const s = state.students.find(s => s.name === data.student);
  if (s) {
    s.location = data.zone === 'classroom' ? LOC.CLASSROOM : LOC.HOSTEL;
    renderStudentList();
    renderMapDots();
  }
  const icon = data.zone === 'classroom' ? '📚' : '🏠';
  addAlert('info', `${icon} ${data.student} → ${data.zone}`);
}

function handleAlarm(data) {
  addAlert('critical', `⚠️ Alarm: ${data.student} — ${data.reason || 'security breach'}`);
  playAlertSound();
  vibrateDevice();
}

function handleModeChange(data) {
  state.mode = data.mode;
  updateModeUI();
  addAlert('info', `Mode changed to ${data.mode === 'class' ? 'Class Time' : 'Free Time'}`);
}

// ============================================================
//  UI RENDERING
// ============================================================
function updateConnectionUI(isConnected) {
  els.statusDot.className = `w-2 h-2 rounded-full ${isConnected ? 'bg-accent animate-pulse' : 'bg-red-500 animate-pulse'}`;
  els.statusText.textContent = isConnected ? 'Connected' : 'Disconnected';
  els.btnConnect.querySelector('span').textContent = isConnected ? 'Disconnect' : 'Connect';
}

function updateModeUI() {
  const isClass = state.mode === 'class';
  els.modeBadge.textContent = isClass ? 'CLASS TIME' : 'FREE TIME';
  els.modeBadge.classList.toggle('class-mode', isClass);
  els.modeCheckbox.checked = isClass;
  els.toggleText.textContent = isClass ? 'Class Time' : 'Free Time';
  if (els.settingsModeCheckbox) {
    els.settingsModeCheckbox.checked = isClass;
    els.settingsModeText.textContent = isClass ? 'Class Time — restrictions enforced' : 'Free Time — no restrictions';
  }
}

function updateStatsUI() {
  const total = state.stats.classroom + state.stats.hostel;
  animateNumber(els.statSchool, total);
  animateNumber(els.statClass, state.stats.classroom);
  animateNumber(els.statHostel, state.stats.hostel);
  animateNumber(els.statLeft, state.stats.left);
  animateNumber(els.statSneaked, state.stats.sneaked);

  // Mobile stat duplicates
  if (els.statLeftMobile) els.statLeftMobile.textContent = state.stats.left;
  if (els.statSneakedMobile) els.statSneakedMobile.textContent = state.stats.sneaked;

  // Update map zone counts
  const classCount = document.getElementById('class-zone-count');
  const hostelCount = document.getElementById('hostel-zone-count');
  const gateCount = document.getElementById('gate-zone-count');
  if (classCount) classCount.textContent = state.stats.classroom + ' students';
  if (hostelCount) hostelCount.textContent = state.stats.hostel + ' students';

  const gateStudents = state.students.filter(s => s.location === LOC.AT_GATE).length;
  if (gateCount) gateCount.textContent = gateStudents + ' students';
}

function animateNumber(el, target) {
  if (!el) return;
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  el.textContent = target;
  el.classList.add('updated');
  setTimeout(() => el.classList.remove('updated'), 500);
}

// ============================================================
//  STUDENT LIST
// ============================================================
function renderStudentList() {
  if (state.students.length === 0) {
    els.studentList.innerHTML = '<div class="empty-state px-4 py-8 text-center"><p class="text-white/25 text-xs">Connect Arduino to see students</p></div>';
    return;
  }

  const sorted = [...state.students].sort((a, b) => {
    if (a.location === LOC.SNEAKED) return -1;
    if (b.location === LOC.SNEAKED) return 1;
    if (a.location === LOC.AT_GATE) return -1;
    if (b.location === LOC.AT_GATE) return 1;
    return 0;
  });

  els.studentList.innerHTML = sorted.map((s, i) => {
    const color = STUDENT_COLORS[s.id % STUDENT_COLORS.length];
    const initials = s.name.split(' ').map(n => n[0]).join('').substring(0, 2);
    const locClass = LOC_CSS[s.location] || 'unknown';
    const locName = LOC_NAMES[s.location] || 'Unknown';

    return `<div class="student-item">
      <div class="student-avatar" style="background:${color}20; color:${color}">${initials}</div>
      <div class="student-details">
        <div class="student-name">${s.name}</div>
        <div class="student-meta">${s.classGrade} · ${s.dormRoom}</div>
      </div>
      <span class="student-status ${locClass}">${locName}</span>
    </div>`;
  }).join('');
}

// ============================================================
//  MAP RENDERING
// ============================================================
function renderMapDots() {
  const classStudents = state.students.filter(s => s.location === LOC.CLASSROOM);
  const hostelStudents = state.students.filter(s => s.location === LOC.HOSTEL);
  const gateStudents = state.students.filter(s => s.location === LOC.AT_GATE);
  const sneakedStudents = state.students.filter(s => s.location === LOC.SNEAKED);
  const leftStudents = state.students.filter(s => s.location === LOC.LEFT);

  renderZoneDots('classroom-students', classStudents, 'classroom');
  renderZoneDots('hostel-students', hostelStudents, 'hostel');
  renderZoneDots('gate-students', gateStudents, 'gate');
  renderZoneDots('outside-students', [...sneakedStudents, ...leftStudents], 'outside');
}

function renderZoneDots(containerId, students, zoneName) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const positions = ZONE_POSITIONS[zoneName] || [];
  let svg = '';

  students.forEach((s, i) => {
    const pos = positions[i % positions.length];
    if (!pos) return;

    const color = STUDENT_COLORS[s.id % STUDENT_COLORS.length];
    const initials = s.name.split(' ').map(n => n[0]).join('').substring(0, 2);
    const isSneaked = s.location === LOC.SNEAKED;
    const dotColor = isSneaked ? '#ef4444' : color;
    const extraClass = isSneaked ? 'sneaked' : '';

    const offsetX = (i * 7) % 20 - 10;
    const offsetY = (i * 5) % 15 - 7;

    svg += `<g class="student-dot ${extraClass}" transform="translate(${pos.x + offsetX}, ${pos.y + offsetY})">
      <circle r="10" fill="${dotColor}" opacity="0.9" filter="url(#glow)" />
      <text dy="0.5">${initials}</text>
    </g>`;
  });

  container.innerHTML = svg;
}

// ============================================================
//  ALERTS
// ============================================================
function addAlert(type, message) {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.alerts.unshift({ type, message, time });
  if (state.alerts.length > 50) state.alerts.pop();

  // Update badge if not on alerts tab
  if (state.activeTab !== 'alerts') {
    state.unreadAlerts++;
    updateAlertBadge();
  }

  renderAlerts();
}

function renderAlerts() {
  if (state.alerts.length === 0) {
    els.alertsList.innerHTML = '<div class="empty-state px-4 py-8 text-center"><p class="text-white/25 text-xs">No alerts yet</p></div>';
    return;
  }

  els.alertsList.innerHTML = state.alerts.map(a => `
    <div class="alert-item ${a.type === 'critical' ? 'critical' : ''}">
      <div class="alert-icon ${a.type}"></div>
      <div class="alert-content">
        <div class="alert-message">${a.message}</div>
        <div class="alert-time">${a.time}</div>
      </div>
    </div>
  `).join('');
}

function clearAlerts() {
  state.alerts = [];
  renderAlerts();
}

function updateAlertBadge() {
  if (!els.alertBadge) return;
  if (state.unreadAlerts > 0) {
    els.alertBadge.textContent = state.unreadAlerts > 9 ? '9+' : state.unreadAlerts;
    els.alertBadge.classList.remove('hidden');
  } else {
    els.alertBadge.classList.add('hidden');
  }
}

// ============================================================
//  SOUND & HAPTICS
// ============================================================
function playAlertSound() {
  if (!els.alertSound) return;
  try {
    els.alertSound.currentTime = 0;
    els.alertSound.play().catch(() => {});
  } catch (e) { /* ignore */ }
}

function vibrateDevice() {
  if ('vibrate' in navigator) {
    navigator.vibrate([200, 100, 200, 100, 400]);
  }
}

// ============================================================
//  MOBILE TAB NAVIGATION
// ============================================================
function switchTab(tabName) {
  state.activeTab = tabName;

  // Update nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });

  // Update panels (mobile only — desktop shows all)
  if (window.innerWidth < 768) {
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    const target = document.getElementById(`panel-${tabName}`);
    if (target) target.classList.add('active');
  }

  // Clear alert badge when viewing alerts
  if (tabName === 'alerts') {
    state.unreadAlerts = 0;
    updateAlertBadge();
  }
}

// Responsive: show all panels on desktop
function handleResize() {
  if (window.innerWidth >= 768) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('active'));
  } else {
    switchTab(state.activeTab);
  }
}

// ============================================================
//  3D TILT EFFECT
// ============================================================
function initTiltEffect() {
  document.querySelectorAll('[data-tilt]').forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      card.style.setProperty('--tilt-x', `${-y * 8}deg`);
      card.style.setProperty('--tilt-y', `${x * 8}deg`);
    });

    card.addEventListener('mouseleave', () => {
      card.style.setProperty('--tilt-x', '0deg');
      card.style.setProperty('--tilt-y', '0deg');
    });
  });
}

// ============================================================
//  DEMO MODE
// ============================================================
function loadDemoData() {
  const demoStudents = [
    { id: 0, name: 'Ali Hassan', classGrade: 'Form 3A', dormRoom: 'Dorm A, Rm 5', contact: '+254700000001', location: LOC.CLASSROOM },
    { id: 1, name: 'Fatima Said', classGrade: 'Form 3B', dormRoom: 'Dorm B, Rm 12', contact: '+254700000002', location: LOC.HOSTEL },
    { id: 2, name: 'James Ochieng', classGrade: 'Form 4A', dormRoom: 'Dorm A, Rm 8', contact: '+254700000003', location: LOC.CLASSROOM },
    { id: 3, name: 'Sarah Wanjiku', classGrade: 'Form 4B', dormRoom: 'Dorm C, Rm 3', contact: '+254700000004', location: LOC.CLASSROOM },
    { id: 4, name: 'David Mutua', classGrade: 'Form 2A', dormRoom: 'Dorm B, Rm 7', contact: '+254700000005', location: LOC.HOSTEL }
  ];

  state.students = demoStudents;
  state.stats = { classroom: 3, hostel: 2, left: 0, sneaked: 0 };
  state.mode = 'free';

  updateStatsUI();
  updateModeUI();
  renderStudentList();
  renderMapDots();
  els.studentTotal.textContent = state.students.length + ' registered';

  addAlert('info', '📊 Demo data loaded — connect Arduino for live tracking');
  addAlert('info', '💡 Tip: Press Ctrl+Shift+D to toggle demo mode');
  addAlert('success', '🛡️ Guardian-Track ready. Click Connect to start monitoring.');
}

// ============================================================
//  PWA REGISTRATION
// ============================================================
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ============================================================
//  EVENT LISTENERS
// ============================================================
function init() {
  // PWA
  registerSW();

  // Connect button
  els.btnConnect.addEventListener('click', connectSerial);

  // Mode toggles
  function toggleMode() {
    const newMode = state.mode === 'free' ? 'CLASS' : 'FREE';
    sendCommand('MODE:' + newMode);
    state.mode = newMode.toLowerCase();
    updateModeUI();
  }

  els.modeCheckbox.addEventListener('change', toggleMode);
  if (els.settingsModeCheckbox) {
    els.settingsModeCheckbox.addEventListener('change', toggleMode);
  }

  // Clear alerts
  els.btnClearAlerts.addEventListener('click', clearAlerts);

  // Demo button
  if (els.btnDemo) {
    els.btnDemo.addEventListener('click', loadDemoData);
  }

  // Keyboard shortcut for demo
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      loadDemoData();
    }
  });

  // Bottom nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });

  // Responsive handler
  window.addEventListener('resize', handleResize);
  handleResize();

  // 3D tilt effects
  initTiltEffect();

  // Initial alert
  addAlert('info', '🛡️ Guardian-Track ready. Click Connect to start monitoring.');
  addAlert('info', '💡 Tip: Press Ctrl+Shift+D to load demo data for testing.');
}

init();
