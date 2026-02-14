/* ============================================================
   Guardian-Track Dashboard — Application Logic
   ============================================================ */

// ============================================================
//  STATE
// ============================================================
const state = {
  connected: false,
  port: null,
  reader: null,
  writer: null,
  readableStreamClosed: null,
  writableStreamClosed: null,
  
  mode: 'free', // 'free' or 'class'
  
  students: [],  // Array of student objects from Arduino
  
  // Stats
  stats: {
    classroom: 0,
    hostel: 0,
    left: 0,
    sneaked: 0
  },
  
  alerts: [],
  
  // Line buffer for serial input
  lineBuffer: ''
};

// Location constants (match Arduino)
const LOC = {
  UNKNOWN: 0,
  CLASSROOM: 1,
  HOSTEL: 2,
  AT_GATE: 3,
  LEFT: 4,
  SNEAKED: 5
};

const LOC_NAMES = {
  [LOC.UNKNOWN]: 'Unknown',
  [LOC.CLASSROOM]: 'Classroom',
  [LOC.HOSTEL]: 'Hostel',
  [LOC.AT_GATE]: 'At Gate',
  [LOC.LEFT]: 'Left School',
  [LOC.SNEAKED]: 'SNEAKED'
};

const LOC_CSS = {
  [LOC.UNKNOWN]: 'unknown',
  [LOC.CLASSROOM]: 'classroom',
  [LOC.HOSTEL]: 'hostel',
  [LOC.AT_GATE]: 'gate',
  [LOC.LEFT]: 'left',
  [LOC.SNEAKED]: 'sneaked'
};

// Student dot positions on the map (within each zone)
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
    { x: 370, y: 410 }, { x: 400, y: 420 }, { x: 430, y: 410 },
    { x: 385, y: 435 }, { x: 415, y: 435 }
  ],
  outside: [
    { x: 350, y: 490 }, { x: 400, y: 490 }, { x: 450, y: 490 },
    { x: 375, y: 490 }, { x: 425, y: 490 }
  ],
  unknown: [
    { x: 400, y: 340 }, { x: 370, y: 350 }, { x: 430, y: 350 },
    { x: 385, y: 360 }, { x: 415, y: 360 }
  ]
};

// Colors for student dots
const STUDENT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'
];

// ============================================================
//  DOM ELEMENTS
// ============================================================
const els = {
  btnConnect: document.getElementById('btn-connect'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  modeBadge: document.getElementById('mode-badge'),
  modeCheckbox: document.getElementById('mode-checkbox'),
  toggleText: document.getElementById('toggle-text'),
  
  // Stats
  statSchoolCount: document.getElementById('stat-school-count'),
  statClassCount: document.getElementById('stat-class-count'),
  statHostelCount: document.getElementById('stat-hostel-count'),
  statLeftCount: document.getElementById('stat-left-count'),
  statSneakedCount: document.getElementById('stat-sneaked-count'),
  statSneaked: document.getElementById('stat-sneaked'),
  
  // Zone counts on map
  classZoneCount: document.getElementById('class-zone-count'),
  hostelZoneCount: document.getElementById('hostel-zone-count'),
  gateZoneCount: document.getElementById('gate-zone-count'),
  
  // Student dots containers
  classroomStudents: document.getElementById('classroom-students'),
  hostelStudents: document.getElementById('hostel-students'),
  gateStudents: document.getElementById('gate-students'),
  outsideStudents: document.getElementById('outside-students'),
  
  // Panels
  studentList: document.getElementById('student-list'),
  studentTotal: document.getElementById('student-total'),
  alertsList: document.getElementById('alerts-list'),
  btnClearAlerts: document.getElementById('btn-clear-alerts'),
  
  // Alert sound
  alertSound: document.getElementById('alert-sound'),
  
  // Map
  schoolMap: document.getElementById('school-map')
};

// ============================================================
//  WEB SERIAL API
// ============================================================

async function connectSerial() {
  if (state.connected) {
    await disconnectSerial();
    return;
  }
  
  try {
    // Request port from user
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: 9600 });
    
    state.connected = true;
    updateConnectionUI(true);
    
    // Set up reader
    const textDecoder = new TextDecoderStream();
    state.readableStreamClosed = state.port.readable.pipeTo(textDecoder.writable);
    state.reader = textDecoder.readable.getReader();
    
    // Set up writer
    const textEncoder = new TextEncoderStream();
    state.writableStreamClosed = textEncoder.readable.pipeTo(state.port.writable);
    state.writer = textEncoder.writable.getWriter();
    
    addAlert('info', '🔌 Connected to Arduino');
    
    // Request sync
    await sendCommand('SYNC');
    
    // Start reading
    readLoop();
    
  } catch (error) {
    console.error('Connection error:', error);
    addAlert('warning', '❌ Connection failed: ' + error.message);
    updateConnectionUI(false);
  }
}

async function disconnectSerial() {
  try {
    if (state.reader) {
      await state.reader.cancel();
      await state.readableStreamClosed.catch(() => {});
    }
    if (state.writer) {
      await state.writer.close();
      await state.writableStreamClosed.catch(() => {});
    }
    if (state.port) {
      await state.port.close();
    }
  } catch (err) {
    console.error('Disconnect error:', err);
  }
  
  state.connected = false;
  state.port = null;
  state.reader = null;
  state.writer = null;
  updateConnectionUI(false);
  addAlert('info', '🔌 Disconnected from Arduino');
}

async function readLoop() {
  try {
    while (true) {
      const { value, done } = await state.reader.read();
      if (done) break;
      
      // Buffer incoming data and process complete lines
      state.lineBuffer += value;
      const lines = state.lineBuffer.split('\n');
      
      // Keep the last incomplete line in the buffer
      state.lineBuffer = lines.pop();
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) processLine(trimmed);
      }
    }
  } catch (error) {
    if (state.connected) {
      console.error('Read error:', error);
      addAlert('warning', '⚠️ Connection lost');
      state.connected = false;
      updateConnectionUI(false);
    }
  }
}

async function sendCommand(cmd) {
  if (!state.writer) return;
  try {
    await state.writer.write(cmd + '\n');
  } catch (err) {
    console.error('Write error:', err);
  }
}

// ============================================================
//  MESSAGE PARSING
// ============================================================

function processLine(line) {
  // Try to parse as JSON
  try {
    const data = JSON.parse(line);
    handleEvent(data);
  } catch (e) {
    // Not JSON, log it
    console.log('[Arduino]', line);
  }
}

function handleEvent(data) {
  switch (data.event) {
    case 'boot':
      addAlert('success', '🚀 Arduino booted successfully');
      break;
      
    case 'student_info':
      handleStudentInfo(data);
      break;
      
    case 'status':
      handleStatusUpdate(data);
      break;
      
    case 'scan':
      handleScan(data);
      break;
      
    case 'approved':
      handleApproved(data);
      break;
      
    case 'sneaked':
      handleSneaked(data);
      break;
      
    case 'zone_change':
      handleZoneChange(data);
      break;
      
    case 'alarm':
      handleAlarm(data);
      break;
      
    case 'mode_change':
      handleModeChange(data);
      break;
      
    case 'unknown_card':
      addAlert('warning', `⚠️ Unknown card at ${data.zone || 'reader'}`);
      break;
      
    default:
      console.log('Unknown event:', data);
  }
}

// ============================================================
//  EVENT HANDLERS
// ============================================================

function handleStudentInfo(data) {
  // Add or update student in array
  const existing = state.students.find(s => s.id === data.id);
  if (existing) {
    Object.assign(existing, data);
  } else {
    state.students.push({
      id: data.id,
      name: data.name,
      classGrade: data.class,
      dormRoom: data.dorm,
      parentContact: data.contact,
      location: data.location
    });
  }
  renderStudentList();
  renderMapDots();
  els.studentTotal.textContent = state.students.length + ' registered';
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
  // Student scanned at gate
  const student = findStudentByName(data.student);
  if (student) {
    student.location = LOC.AT_GATE;
    renderStudentList();
    renderMapDots();
  }
  addAlert('warning', `🚪 ${data.student} requesting exit — waiting for admin approval`);
  playAlertSound();
}

function handleApproved(data) {
  const student = findStudentByName(data.student);
  if (student) {
    student.location = LOC.LEFT;
    renderStudentList();
    renderMapDots();
  }
  addAlert('success', `✅ ${data.student} approved to leave`);
}

function handleSneaked(data) {
  const student = findStudentByName(data.student);
  if (student) {
    student.location = LOC.SNEAKED;
    renderStudentList();
    renderMapDots();
  }
  addAlert('danger', `🚨 ALERT: ${data.student} SNEAKED OUT!`);
  playAlertSound();
  
  // Flash the sneaked stat card
  els.statSneaked.classList.add('has-sneaked');
}

function handleZoneChange(data) {
  const student = findStudentByName(data.student);
  if (student) {
    const zone = data.zone;
    if (zone === 'classroom') student.location = LOC.CLASSROOM;
    else if (zone === 'hostel') student.location = LOC.HOSTEL;
    renderStudentList();
    renderMapDots();
  }
  
  const emoji = data.zone === 'classroom' ? '📚' : '🏠';
  addAlert('info', `${emoji} ${data.student} → ${data.zone}`);
}

function handleAlarm(data) {
  if (data.reason === 'wrong_zone') {
    addAlert('danger', `⚠️ ${data.student} is in the WRONG ZONE during class time!`);
    playAlertSound();
  }
}

function handleModeChange(data) {
  state.mode = data.mode;
  updateModeUI();
  
  if (data.mode === 'class') {
    addAlert('warning', '📚 Mode switched to CLASS TIME — hostel access restricted');
  } else {
    addAlert('info', '🕐 Mode switched to FREE TIME — no restrictions');
  }
}

// ============================================================
//  UI RENDERING
// ============================================================

function updateConnectionUI(connected) {
  els.statusDot.className = 'status-dot' + (connected ? ' connected' : '');
  els.statusText.textContent = connected ? 'Connected' : 'Disconnected';
  
  const btn = els.btnConnect;
  btn.querySelector('span').textContent = connected ? 'Disconnect' : 'Connect';
  btn.className = 'btn btn-connect' + (connected ? ' connected' : '');
}

function updateModeUI() {
  const isClass = state.mode === 'class';
  els.modeBadge.textContent = isClass ? 'CLASS TIME' : 'FREE TIME';
  els.modeBadge.className = 'mode-badge' + (isClass ? ' class-time' : '');
  els.modeCheckbox.checked = isClass;
  els.toggleText.textContent = isClass ? 'Class Time' : 'Free Time';
}

function updateStatsUI() {
  const inSchool = state.stats.classroom + state.stats.hostel;
  
  animateNumber(els.statSchoolCount, inSchool);
  animateNumber(els.statClassCount, state.stats.classroom);
  animateNumber(els.statHostelCount, state.stats.hostel);
  animateNumber(els.statLeftCount, state.stats.left);
  animateNumber(els.statSneakedCount, state.stats.sneaked);
  
  // Update map zone counts
  els.classZoneCount.textContent = state.stats.classroom + ' students';
  els.hostelZoneCount.textContent = state.stats.hostel + ' students';
  
  // Gate count (students at gate)
  const atGate = state.students.filter(s => s.location === LOC.AT_GATE).length;
  els.gateZoneCount.textContent = atGate + ' students';
  
  // Sneaked danger state
  if (state.stats.sneaked > 0) {
    els.statSneaked.classList.add('has-sneaked');
  } else {
    els.statSneaked.classList.remove('has-sneaked');
  }
}

function animateNumber(el, target) {
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  el.textContent = target;
  el.style.transform = 'scale(1.2)';
  el.style.transition = 'transform 0.3s ease';
  setTimeout(() => {
    el.style.transform = 'scale(1)';
  }, 300);
}

// ============================================================
//  STUDENT LIST RENDERING
// ============================================================

function renderStudentList() {
  if (state.students.length === 0) {
    els.studentList.innerHTML = '<div class="empty-state"><p>No data yet. Connect to Arduino to see students.</p></div>';
    return;
  }
  
  // Sort: sneaked first, then at gate, then by name
  const sorted = [...state.students].sort((a, b) => {
    if (a.location === LOC.SNEAKED && b.location !== LOC.SNEAKED) return -1;
    if (b.location === LOC.SNEAKED && a.location !== LOC.SNEAKED) return 1;
    if (a.location === LOC.AT_GATE && b.location !== LOC.AT_GATE) return -1;
    if (b.location === LOC.AT_GATE && a.location !== LOC.AT_GATE) return 1;
    return a.name.localeCompare(b.name);
  });
  
  els.studentList.innerHTML = sorted.map(student => {
    const locCSS = LOC_CSS[student.location] || 'unknown';
    const locName = LOC_NAMES[student.location] || 'Unknown';
    const initials = student.name.split(' ').map(n => n[0]).join('').substring(0, 2);
    
    return `
      <div class="student-item" data-student-id="${student.id}">
        <div class="student-avatar avatar-${locCSS}">${initials}</div>
        <div class="student-info">
          <div class="student-name">${student.name}</div>
          <div class="student-detail">${student.classGrade || ''} · ${student.dormRoom || ''}</div>
        </div>
        <span class="student-status status-${locCSS}">${locName}</span>
      </div>
    `;
  }).join('');
}

// ============================================================
//  MAP RENDERING
// ============================================================

function renderMapDots() {
  // Clear all dot containers
  els.classroomStudents.innerHTML = '';
  els.hostelStudents.innerHTML = '';
  els.gateStudents.innerHTML = '';
  els.outsideStudents.innerHTML = '';
  
  // Group students by zone
  const groups = {
    classroom: [],
    hostel: [],
    gate: [],
    outside: [], // left + sneaked
    unknown: []
  };
  
  state.students.forEach(student => {
    switch (student.location) {
      case LOC.CLASSROOM: groups.classroom.push(student); break;
      case LOC.HOSTEL: groups.hostel.push(student); break;
      case LOC.AT_GATE: groups.gate.push(student); break;
      case LOC.LEFT:
      case LOC.SNEAKED: groups.outside.push(student); break;
      default: groups.unknown.push(student); break;
    }
  });
  
  // Render dots for each zone
  renderZoneDots(els.classroomStudents, groups.classroom, 'classroom');
  renderZoneDots(els.hostelStudents, groups.hostel, 'hostel');
  renderZoneDots(els.gateStudents, groups.gate, 'gate');
  renderZoneDots(els.outsideStudents, groups.outside, 'outside');
  
  // Render unknown students in the middle area
  if (groups.unknown.length > 0) {
    // Create a temporary group in the SVG for unknown
    let unknownGroup = document.getElementById('unknown-students');
    if (!unknownGroup) {
      unknownGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      unknownGroup.id = 'unknown-students';
      els.schoolMap.appendChild(unknownGroup);
    }
    unknownGroup.innerHTML = '';
    renderZoneDots(unknownGroup, groups.unknown, 'unknown');
  }
  
  updateStatsUI();
}

function renderZoneDots(container, students, zoneName) {
  const positions = ZONE_POSITIONS[zoneName] || ZONE_POSITIONS.unknown;
  
  students.forEach((student, index) => {
    const pos = positions[index % positions.length];
    // Add slight random offset so dots don't stack perfectly
    const offsetX = (index >= positions.length) ? (Math.random() * 20 - 10) : 0;
    const offsetY = (index >= positions.length) ? (Math.random() * 15 - 7) : 0;
    
    const color = STUDENT_COLORS[student.id % STUDENT_COLORS.length];
    const isSneaked = student.location === LOC.SNEAKED;
    const dotColor = isSneaked ? '#ef4444' : color;
    
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'student-dot' + (isSneaked ? ' sneaked' : ''));
    g.setAttribute('transform', `translate(${pos.x + offsetX}, ${pos.y + offsetY})`);
    
    // Dot circle
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '8');
    circle.setAttribute('fill', dotColor);
    circle.setAttribute('opacity', '0.9');
    g.appendChild(circle);
    
    // Initials text
    const initials = student.name.split(' ').map(n => n[0]).join('').substring(0, 2);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dy', '0.35em');
    text.setAttribute('fill', 'white');
    text.setAttribute('font-size', '7');
    text.setAttribute('font-weight', '700');
    text.setAttribute('font-family', 'Inter, sans-serif');
    text.textContent = initials;
    g.appendChild(text);
    
    // Name label below dot
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('y', '18');
    label.setAttribute('fill', isSneaked ? '#ef4444' : 'rgba(255,255,255,0.7)');
    label.setAttribute('font-size', '8');
    label.setAttribute('font-weight', '500');
    label.setAttribute('font-family', 'Inter, sans-serif');
    label.textContent = student.name.split(' ')[0]; // First name only
    g.appendChild(label);
    
    // Tooltip (title)
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${student.name}\n${student.classGrade}\n${student.dormRoom}\nStatus: ${LOC_NAMES[student.location]}`;
    g.appendChild(title);
    
    container.appendChild(g);
  });
}

// ============================================================
//  ALERTS
// ============================================================

function addAlert(type, message) {
  const time = new Date().toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    hour12: true 
  });
  
  const alert = { type, message, time };
  state.alerts.unshift(alert); // Add to beginning
  
  // Keep max 50 alerts
  if (state.alerts.length > 50) state.alerts.pop();
  
  renderAlerts();
}

function renderAlerts() {
  if (state.alerts.length === 0) {
    els.alertsList.innerHTML = '<div class="empty-state"><p>No alerts yet.</p></div>';
    return;
  }
  
  els.alertsList.innerHTML = state.alerts.map(alert => {
    return `
      <div class="alert-item alert-${alert.type}">
        <div class="alert-content">
          <div class="alert-message">${alert.message}</div>
          <div class="alert-time">${alert.time}</div>
        </div>
      </div>
    `;
  }).join('');
}

function clearAlerts() {
  state.alerts = [];
  renderAlerts();
}

// ============================================================
//  SOUND
// ============================================================

function playAlertSound() {
  try {
    // Create a simple beep using AudioContext
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.frequency.value = 800;
    oscillator.type = 'sine';
    gainNode.gain.value = 0.3;
    
    oscillator.start();
    
    // Two beeps
    setTimeout(() => {
      gainNode.gain.value = 0;
      setTimeout(() => {
        gainNode.gain.value = 0.3;
        setTimeout(() => {
          oscillator.stop();
          audioCtx.close();
        }, 200);
      }, 100);
    }, 200);
  } catch (e) {
    // Fallback to HTML audio
    els.alertSound.currentTime = 0;
    els.alertSound.play().catch(() => {});
  }
}

// ============================================================
//  HELPER FUNCTIONS
// ============================================================

function findStudentByName(name) {
  return state.students.find(s => s.name === name);
}

// ============================================================
//  DEMO MODE (for testing without Arduino)
// ============================================================

function loadDemoData() {
  const demoStudents = [
    { id: 0, name: 'Ali Hassan', classGrade: 'Form 3A', dormRoom: 'Dorm A, Rm 5', parentContact: '+254700000001', location: LOC.CLASSROOM },
    { id: 1, name: 'Fatima Said', classGrade: 'Form 3B', dormRoom: 'Dorm B, Rm 12', parentContact: '+254700000002', location: LOC.CLASSROOM },
    { id: 2, name: 'James Ochieng', classGrade: 'Form 4A', dormRoom: 'Dorm A, Rm 8', parentContact: '+254700000003', location: LOC.HOSTEL },
    { id: 3, name: 'Sarah Wanjiku', classGrade: 'Form 4B', dormRoom: 'Dorm C, Rm 3', parentContact: '+254700000004', location: LOC.UNKNOWN },
    { id: 4, name: 'David Mutua', classGrade: 'Form 2A', dormRoom: 'Dorm B, Rm 7', parentContact: '+254700000005', location: LOC.CLASSROOM }
  ];
  
  state.students = demoStudents;
  state.stats = { classroom: 3, hostel: 1, left: 0, sneaked: 0 };
  
  renderStudentList();
  renderMapDots();
  updateStatsUI();
  
  els.studentTotal.textContent = state.students.length + ' registered';
  addAlert('info', '📋 Demo data loaded — connect Arduino for live tracking');
}

// ============================================================
//  EVENT LISTENERS
// ============================================================

// Connect button
els.btnConnect.addEventListener('click', () => {
  if ('serial' in navigator) {
    connectSerial();
  } else {
    addAlert('danger', '❌ Web Serial API not supported! Use Chrome, Edge, or Brave.');
    alert('Web Serial API is not supported in this browser.\nPlease use Chrome, Edge, or Brave.');
  }
});

// Mode toggle
els.modeCheckbox.addEventListener('change', (e) => {
  const newMode = e.target.checked ? 'class' : 'free';
  state.mode = newMode;
  updateModeUI();
  
  if (state.connected) {
    sendCommand(newMode === 'class' ? 'MODE:CLASS' : 'MODE:FREE');
  } else {
    // If not connected, just update the UI
    handleModeChange({ mode: newMode });
  }
});

// Clear alerts
els.btnClearAlerts.addEventListener('click', clearAlerts);

// Handle serial disconnect
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (state.port === e.target) {
      state.connected = false;
      updateConnectionUI(false);
      addAlert('warning', '⚠️ Arduino disconnected');
    }
  });
}

// Keyboard shortcut: D for demo data
document.addEventListener('keydown', (e) => {
  if (e.key === 'd' && e.ctrlKey && e.shiftKey) {
    e.preventDefault();
    loadDemoData();
  }
});

// ============================================================
//  INITIALIZATION
// ============================================================

function init() {
  // Check for Web Serial support
  if (!('serial' in navigator)) {
    addAlert('warning', '⚠️ Web Serial not supported — use Chrome/Edge/Brave. Press Ctrl+Shift+D for demo.');
  } else {
    addAlert('info', '🛡️ Guardian-Track ready. Click Connect to start monitoring.');
  }
  
  addAlert('info', '💡 Tip: Press Ctrl+Shift+D to load demo data for testing.');
}

init();
