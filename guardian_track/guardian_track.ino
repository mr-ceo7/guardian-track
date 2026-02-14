/*
 * Guardian-Track: IoT RFID Student Monitoring System
 * ====================================================
 * Main firmware for Arduino Nano.
 *
 * Features:
 *   - 3-zone RFID tracking (Gate, Classroom, Hostel)
 *   - Gate authorization (admin card approval required to exit)
 *   - Sneaking detection with 5-second alarm countdown
 *   - Class time enforcement (wrong zone alerts)
 *   - LCD dashboard with scrolling info
 *   - Serial JSON protocol for web dashboard
 *   - LED + Buzzer feedback
 *
 * Wiring:
 *   RFID 1 (Gate) SDA=D7 | RFID 2 (Classroom) SDA=D8 | RFID 3 (Hostel) SDA=D10
 *   Shared SPI: SCK=D13, MOSI=D11, MISO=D12, RST=D9
 *   I2C LCD: SDA=A4, SCL=A5
 *   Servo=D3 | Red LED=D5 | Blue LED=D4 | Buzzer=D6
 */

#include <LiquidCrystal_I2C.h>
#include <MFRC522.h>
#include <SPI.h>
#include <Servo.h>
#include <Wire.h>

// ============================================================
//  PIN DEFINITIONS
// ============================================================
#define RST_PIN 9

#define SS_GATE 7
#define SS_CLASS 8
#define SS_HOSTEL 2

#define SERVO_PIN 3
#define BLUE_LED 4
#define RED_LED 5
#define BUZZER_PIN 6

// ============================================================
//  CONSTANTS
// ============================================================
#define NUM_STUDENTS 5
#define UID_LENGTH 4
#define GATE_TIMEOUT_MS 20000   // Max time to wait while card at gate
#define SNEAK_WINDOW_MS 5000    // 5 seconds after card leaves gate
#define GATE_OPEN_TIME_MS 5000  // How long gate stays open
#define LCD_SCROLL_MS 3000      // LCD scroll interval
#define ALARM_DURATION_MS 10000 // How long sneak alarm lasts

// Location codes
#define LOC_UNKNOWN 0
#define LOC_CLASSROOM 1
#define LOC_HOSTEL 2
#define LOC_AT_GATE 3
#define LOC_LEFT 4
#define LOC_SNEAKED 5

// Zone indices
#define ZONE_GATE 0
#define ZONE_CLASS 1
#define ZONE_HOSTEL 2

// System modes
#define MODE_FREE 0
#define MODE_CLASS 1

// Gate states
#define GATE_IDLE 0
#define GATE_WAITING_APPROVAL 1
#define GATE_APPROVED 2
#define GATE_SNEAK_COUNTDOWN 3
#define GATE_ALARM 4

// ============================================================
//  DATA STRUCTURES
// ============================================================
struct Student {
  byte uid[UID_LENGTH];
  const char *name;
  const char *classGrade;
  const char *dormRoom;
  const char *parentContact;
  byte location;
};

// ============================================================
//  HARDCODED STUDENT DATA (Replace UIDs after scanning!)
// ============================================================
Student students[NUM_STUDENTS] = {
    // Student 1 — Tag: 93:85:CB:13
    {{0x93, 0x85, 0xCB, 0x13},
     "Ali Hassan",
     "Form 3A",
     "Dorm A, Rm 5",
     "+254700000001",
     LOC_UNKNOWN},
    // Student 2 — Tag: 93:E5:02:29
    {{0x93, 0xE5, 0x02, 0x29},
     "Fatima Said",
     "Form 3B",
     "Dorm B, Rm 12",
     "+254700000002",
     LOC_UNKNOWN},
    // Student 3 — Tag: 23:9E:C8:13
    {{0x23, 0x9E, 0xC8, 0x13},
     "James Ochieng",
     "Form 4A",
     "Dorm A, Rm 8",
     "+254700000003",
     LOC_UNKNOWN},
    // Student 4 — Tag: 53:C3:B7:13
    {{0x53, 0xC3, 0xB7, 0x13},
     "Sarah Wanjiku",
     "Form 4B",
     "Dorm C, Rm 3",
     "+254700000004",
     LOC_UNKNOWN},
    // Student 5 — Tag: B3:21:D3:26
    {{0xB3, 0x21, 0xD3, 0x26},
     "David Mutua",
     "Form 2A",
     "Dorm B, Rm 7",
     "+254700000005",
     LOC_UNKNOWN}};

// Admin card UID — Tag: 03:3E:27:29
byte adminUID[UID_LENGTH] = {0x03, 0x3E, 0x27, 0x29};

// ============================================================
//  HARDWARE INSTANCES
// ============================================================
MFRC522 rfidGate(SS_GATE, RST_PIN);
MFRC522 rfidClass(SS_CLASS, RST_PIN);
MFRC522 rfidHostel(SS_HOSTEL, RST_PIN);
MFRC522 *readers[] = {&rfidGate, &rfidClass, &rfidHostel};

LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo gateServo;

// ============================================================
//  STATE VARIABLES
// ============================================================
byte systemMode = MODE_FREE;      // Current mode (class/free)
byte gateState = GATE_IDLE;       // Gate state machine
int gateStudentIdx = -1;          // Index of student at gate
unsigned long gateEventTime = 0;  // When gate event started
unsigned long sneakStartTime = 0; // When card left gate reader
unsigned long alarmStartTime = 0; // When alarm started

// LCD scrolling
unsigned long lastLCDScroll = 0;
byte lcdPage = 0;
bool lcdOverride = false;          // True when showing event-specific message
unsigned long lcdOverrideTime = 0; // When override started
#define LCD_OVERRIDE_MS 3000       // How long to show override message

// Alarm state
bool alarmActive = false;
unsigned long lastAlarmToggle = 0;
bool alarmLedState = false;

// LED flash state
bool blueLedFlashing = false;
unsigned long blueLedOffTime = 0;

// Status broadcast
unsigned long lastStatusBroadcast = 0;
#define STATUS_INTERVAL_MS 5000

// ============================================================
//  HELPER FUNCTIONS
// ============================================================

// Compare two UIDs
bool compareUID(byte *uid1, byte *uid2) {
  for (byte i = 0; i < UID_LENGTH; i++) {
    if (uid1[i] != uid2[i])
      return false;
  }
  return true;
}

// Find student index by UID, returns -1 if not found
int findStudent(byte *uid) {
  for (int i = 0; i < NUM_STUDENTS; i++) {
    if (compareUID(students[i].uid, uid))
      return i;
  }
  return -1;
}

// Check if UID is admin
bool isAdmin(byte *uid) { return compareUID(uid, adminUID); }

// Count students at a given location
int countAt(byte loc) {
  int count = 0;
  for (int i = 0; i < NUM_STUDENTS; i++) {
    if (students[i].location == loc)
      count++;
  }
  return count;
}

// Count students currently in school (classroom + hostel + gate + unknown)
int countInSchool() {
  int count = 0;
  for (int i = 0; i < NUM_STUDENTS; i++) {
    byte loc = students[i].location;
    if (loc != LOC_LEFT && loc != LOC_SNEAKED)
      count++;
  }
  return count;
}

// ============================================================
//  FEEDBACK FUNCTIONS
// ============================================================

void beepShort(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(100);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < times - 1)
      delay(100);
  }
}

void flashBlue(unsigned long durationMs) {
  digitalWrite(BLUE_LED, HIGH);
  blueLedFlashing = true;
  blueLedOffTime = millis() + durationMs;
}

void flashRed(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(RED_LED, HIGH);
    delay(200);
    digitalWrite(RED_LED, LOW);
    if (i < times - 1)
      delay(200);
  }
}

void startAlarm() {
  alarmActive = true;
  alarmStartTime = millis();
  lastAlarmToggle = millis();
  alarmLedState = true;
  digitalWrite(RED_LED, HIGH);
  digitalWrite(BUZZER_PIN, HIGH);
}

void stopAlarm() {
  alarmActive = false;
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER_PIN, LOW);
}

void updateAlarm() {
  if (!alarmActive)
    return;

  // Check if alarm duration has passed
  if (millis() - alarmStartTime > ALARM_DURATION_MS) {
    stopAlarm();
    return;
  }

  // Toggle LED and buzzer for blinking effect
  if (millis() - lastAlarmToggle > 300) {
    lastAlarmToggle = millis();
    alarmLedState = !alarmLedState;
    digitalWrite(RED_LED, alarmLedState ? HIGH : LOW);
    digitalWrite(BUZZER_PIN, alarmLedState ? HIGH : LOW);
  }
}

// ============================================================
//  SERIAL COMMUNICATION
// ============================================================

// Send JSON event to dashboard
void sendEvent(const char *event, int studentIdx, const char *extra1 = NULL,
               const char *extra2 = NULL) {
  Serial.print(F("{\"event\":\""));
  Serial.print(event);
  Serial.print(F("\""));

  if (studentIdx >= 0) {
    Serial.print(F(",\"student\":\""));
    Serial.print(students[studentIdx].name);
    Serial.print(F("\""));
  }

  if (extra1 != NULL && extra2 != NULL) {
    Serial.print(F(",\""));
    Serial.print(extra1);
    Serial.print(F("\":\""));
    Serial.print(extra2);
    Serial.print(F("\""));
  }

  Serial.println(F("}"));
}

void sendStatus() {
  Serial.print(F("{\"event\":\"status\",\"classroom\":"));
  Serial.print(countAt(LOC_CLASSROOM));
  Serial.print(F(",\"hostel\":"));
  Serial.print(countAt(LOC_HOSTEL));
  Serial.print(F(",\"left\":"));
  Serial.print(countAt(LOC_LEFT));
  Serial.print(F(",\"sneaked\":"));
  Serial.print(countAt(LOC_SNEAKED));
  Serial.print(F(",\"mode\":\""));
  Serial.print(systemMode == MODE_CLASS ? F("class") : F("free"));
  Serial.println(F("\"}"));
}

// Send full student list (for dashboard initial sync)
void sendStudentList() {
  for (int i = 0; i < NUM_STUDENTS; i++) {
    Serial.print(F("{\"event\":\"student_info\",\"id\":"));
    Serial.print(i);
    Serial.print(F(",\"name\":\""));
    Serial.print(students[i].name);
    Serial.print(F("\",\"class\":\""));
    Serial.print(students[i].classGrade);
    Serial.print(F("\",\"dorm\":\""));
    Serial.print(students[i].dormRoom);
    Serial.print(F("\",\"contact\":\""));
    Serial.print(students[i].parentContact);
    Serial.print(F("\",\"location\":"));
    Serial.print(students[i].location);
    Serial.println(F("}"));
  }
}

void processSerialCommand() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd == "MODE:CLASS") {
      systemMode = MODE_CLASS;
      Serial.println(F("{\"event\":\"mode_change\",\"mode\":\"class\"}"));
      lcdShowOverride("Mode: CLASS", "Time enforced!");
      beepShort(1);
    } else if (cmd == "MODE:FREE") {
      systemMode = MODE_FREE;
      Serial.println(F("{\"event\":\"mode_change\",\"mode\":\"free\"}"));
      lcdShowOverride("Mode: FREE", "No restrictions");
      beepShort(1);
    } else if (cmd == "SYNC") {
      sendStudentList();
      sendStatus();
    }
  }
}

// ============================================================
//  LCD FUNCTIONS
// ============================================================

void lcdShowOverride(const char *line1, const char *line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1);
  lcd.setCursor(0, 1);
  lcd.print(line2);
  lcdOverride = true;
  lcdOverrideTime = millis();
}

void updateLCDDefault() {
  // Don't update if showing an override message
  if (lcdOverride) {
    if (millis() - lcdOverrideTime > LCD_OVERRIDE_MS) {
      lcdOverride = false;
    } else {
      return;
    }
  }

  // Don't update during gate operations
  if (gateState != GATE_IDLE)
    return;

  if (millis() - lastLCDScroll < LCD_SCROLL_MS)
    return;
  lastLCDScroll = millis();

  lcd.clear();

  switch (lcdPage) {
  case 0:
    lcd.setCursor(0, 0);
    lcd.print("Guardian-Track");
    lcd.setCursor(0, 1);
    lcd.print(systemMode == MODE_CLASS ? "Mode: CLASS" : "Mode: FREE");
    break;

  case 1:
    lcd.setCursor(0, 0);
    lcd.print("Class:");
    lcd.print(countAt(LOC_CLASSROOM));
    lcd.print(" Hostel:");
    lcd.print(countAt(LOC_HOSTEL));
    lcd.setCursor(0, 1);
    lcd.print("In School: ");
    lcd.print(countInSchool());
    break;

  case 2:
    lcd.setCursor(0, 0);
    lcd.print("Left: ");
    lcd.print(countAt(LOC_LEFT));
    lcd.setCursor(0, 1);
    lcd.print("Sneaked: ");
    lcd.print(countAt(LOC_SNEAKED));
    break;

  case 3: {
    // Show individual student locations
    // Find next student to display
    static byte displayStudent = 0;
    if (displayStudent >= NUM_STUDENTS)
      displayStudent = 0;

    lcd.setCursor(0, 0);
    lcd.print(students[displayStudent].name);
    lcd.setCursor(0, 1);
    switch (students[displayStudent].location) {
    case LOC_UNKNOWN:
      lcd.print("Loc: Unknown");
      break;
    case LOC_CLASSROOM:
      lcd.print("Loc: Classroom");
      break;
    case LOC_HOSTEL:
      lcd.print("Loc: Hostel");
      break;
    case LOC_AT_GATE:
      lcd.print("Loc: At Gate");
      break;
    case LOC_LEFT:
      lcd.print("Loc: Left School");
      break;
    case LOC_SNEAKED:
      lcd.print("Loc: SNEAKED!");
      break;
    }
    displayStudent++;
    break;
  }
  }

  lcdPage++;
  if (lcdPage > 3)
    lcdPage = 0;
}

// ============================================================
//  RFID READING
// ============================================================

// Deselect all readers (set all SDA pins HIGH) to ensure clean SPI bus
void deselectAllReaders() {
  digitalWrite(SS_GATE, HIGH);
  digitalWrite(SS_CLASS, HIGH);
  digitalWrite(SS_HOSTEL, HIGH);
}

// Try to read a card from a specific reader
// Returns true if a card was read, fills uid buffer
bool readCard(MFRC522 *reader, byte *uidBuffer) {
  deselectAllReaders();
  delayMicroseconds(100);

  // Turn on antenna for this reader only
  reader->PCD_AntennaOn();
  delay(1); // Give antenna time to energize card

  // Use WUPA (Wake-Up) instead of REQA so we can detect cards that were
  // put into HALT state by RF cross-talk from adjacent readers
  byte bufferATQA[2];
  byte bufferSize = sizeof(bufferATQA);
  MFRC522::StatusCode status = reader->PICC_WakeupA(bufferATQA, &bufferSize);

  if (status != MFRC522::STATUS_OK) {
    reader->PCD_AntennaOff(); // Turn off to prevent RF interference
    return false;
  }

  // Card detected — read its serial
  if (reader->PICC_ReadCardSerial()) {
    for (byte i = 0; i < UID_LENGTH; i++) {
      uidBuffer[i] = reader->uid.uidByte[i];
    }
    reader->PICC_HaltA();
    reader->PCD_StopCrypto1();
    reader->PCD_AntennaOff(); // Turn off to prevent RF interference
    return true;
  }

  reader->PCD_AntennaOff();
  return false;
}

// Check if a card is still present at a reader (for continuous detection)
bool isCardPresent(MFRC522 *reader) {
  deselectAllReaders();
  delayMicroseconds(100);

  reader->PCD_AntennaOn();
  delay(1);

  byte bufferATQA[2];
  byte bufferSize = sizeof(bufferATQA);

  MFRC522::StatusCode result = reader->PICC_WakeupA(bufferATQA, &bufferSize);

  if (result == MFRC522::STATUS_OK) {
    reader->PICC_HaltA();
    reader->PCD_AntennaOff();
    return true;
  }
  reader->PCD_AntennaOff();
  return false;
}

// ============================================================
//  ZONE HANDLING
// ============================================================

void handleZoneTap(int studentIdx, byte zone) {
  const char *zoneName;
  byte newLocation;

  if (zone == ZONE_CLASS) {
    zoneName = "classroom";
    newLocation = LOC_CLASSROOM;
  } else {
    zoneName = "hostel";
    newLocation = LOC_HOSTEL;
  }

  byte oldLocation = students[studentIdx].location;
  students[studentIdx].location = newLocation;

  // Send zone change event
  sendEvent("zone_change", studentIdx, "zone", zoneName);

  // Show on LCD
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(students[studentIdx].name);
  lcd.setCursor(0, 1);
  lcd.print("-> ");
  lcd.print(zoneName);
  lcdOverride = true;
  lcdOverrideTime = millis();

  // Check class time enforcement
  if (systemMode == MODE_CLASS && newLocation == LOC_HOSTEL) {
    // Student in hostel during class time - alarm!
    flashRed(3);
    beepShort(3);

    sendEvent("alarm", studentIdx, "reason", "wrong_zone");

    lcdShowOverride("!! ALERT !!", "Wrong zone!");
  } else {
    // Normal zone tap
    flashBlue(1000);
    beepShort(1);
  }

  // Broadcast updated status
  sendStatus();
}

// ============================================================
//  GATE AUTHORIZATION STATE MACHINE
// ============================================================

void handleGateDetection(int studentIdx) {
  if (gateState != GATE_IDLE)
    return; // Already handling a gate event

  gateStudentIdx = studentIdx;
  gateState = GATE_WAITING_APPROVAL;
  gateEventTime = millis();

  students[studentIdx].location = LOC_AT_GATE;

  // Display on LCD
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("EXIT REQUEST:");
  lcd.setCursor(0, 1);
  lcd.print(students[studentIdx].name);

  // Send event to dashboard
  sendEvent("scan", studentIdx, "zone", "gate");

  // Feedback
  flashBlue(500);
  beepShort(1);

  sendStatus();
}

void updateGateStateMachine() {
  if (gateState == GATE_IDLE)
    return;

  byte uid[UID_LENGTH];

  switch (gateState) {
  case GATE_WAITING_APPROVAL: {
    // Check if admin card is tapped on Classroom or Hostel reader
    // Check Classroom reader for admin card
    if (readCard(&rfidClass, uid)) {
      if (isAdmin(uid)) {
        gateApproved();
        return;
      } else {
        // It's a student card on classroom reader - handle zone tap
        int idx = findStudent(uid);
        if (idx >= 0)
          handleZoneTap(idx, ZONE_CLASS);
      }
    }

    // Check Hostel reader for admin card
    if (readCard(&rfidHostel, uid)) {
      if (isAdmin(uid)) {
        gateApproved();
        return;
      } else {
        // It's a student card on hostel reader - handle zone tap
        int idx = findStudent(uid);
        if (idx >= 0)
          handleZoneTap(idx, ZONE_HOSTEL);
      }
    }

    // Check if student card is still at gate
    if (!isCardPresent(&rfidGate)) {
      // Card left the gate reader! Start sneak countdown
      gateState = GATE_SNEAK_COUNTDOWN;
      sneakStartTime = millis();

      lcd.clear();
      lcd.setCursor(0, 0);
      lcd.print("Card removed!");
      lcd.setCursor(0, 1);
      lcd.print("Verifying...");
    }

    // Timeout - if waiting too long, reset
    if (millis() - gateEventTime > GATE_TIMEOUT_MS) {
      gateState = GATE_IDLE;
      gateStudentIdx = -1;
      lcdShowOverride("Gate timeout", "Request expired");
    }
    break;
  }

  case GATE_SNEAK_COUNTDOWN: {
    // Check if student card appears on another reader (went back inside)
    if (readCard(&rfidClass, uid)) {
      int idx = findStudent(uid);
      if (idx == gateStudentIdx) {
        // Student went back to classroom
        students[gateStudentIdx].location = LOC_CLASSROOM;
        sendEvent("zone_change", gateStudentIdx, "zone", "classroom");
        sendStatus();
        lcdShowOverride("Student returned", "to Classroom");
        beepShort(1);
        gateState = GATE_IDLE;
        gateStudentIdx = -1;
        return;
      } else if (isAdmin(uid)) {
        // Late admin approval - still allow
        gateApproved();
        return;
      } else if (idx >= 0) {
        handleZoneTap(idx, ZONE_CLASS);
      }
    }

    if (readCard(&rfidHostel, uid)) {
      int idx = findStudent(uid);
      if (idx == gateStudentIdx) {
        // Student went back to hostel
        students[gateStudentIdx].location = LOC_HOSTEL;
        sendEvent("zone_change", gateStudentIdx, "zone", "hostel");
        sendStatus();
        lcdShowOverride("Student returned", "to Hostel");
        beepShort(1);
        gateState = GATE_IDLE;
        gateStudentIdx = -1;
        return;
      } else if (isAdmin(uid)) {
        gateApproved();
        return;
      } else if (idx >= 0) {
        handleZoneTap(idx, ZONE_HOSTEL);
      }
    }

    // Check if student card returned to gate
    if (readCard(&rfidGate, uid)) {
      int idx = findStudent(uid);
      if (idx == gateStudentIdx) {
        // Student came back to gate, resume waiting
        gateState = GATE_WAITING_APPROVAL;
        gateEventTime = millis();
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("EXIT REQUEST:");
        lcd.setCursor(0, 1);
        lcd.print(students[gateStudentIdx].name);
        return;
      }
    }

    // 5-second countdown expired - SNEAKED!
    if (millis() - sneakStartTime >= SNEAK_WINDOW_MS) {
      students[gateStudentIdx].location = LOC_SNEAKED;

      sendEvent("sneaked", gateStudentIdx);
      sendStatus();

      // LCD alarm
      lcd.clear();
      lcd.setCursor(0, 0);
      lcd.print("!! ALARM !!");
      lcd.setCursor(0, 1);
      lcd.print(students[gateStudentIdx].name);

      // Start alarm (red LED + buzzer)
      startAlarm();

      gateState = GATE_ALARM;
    }
    break;
  }

  case GATE_ALARM: {
    // Alarm is active, wait for it to end
    // Admin can tap to acknowledge and stop alarm
    if (readCard(&rfidClass, uid) || readCard(&rfidHostel, uid)) {
      if (isAdmin(uid)) {
        stopAlarm();
        lcdShowOverride("Alarm cleared", "by Admin");
        gateState = GATE_IDLE;
        gateStudentIdx = -1;
        return;
      }
    }

    // Auto-stop after alarm duration
    if (!alarmActive) {
      gateState = GATE_IDLE;
      gateStudentIdx = -1;
    }
    break;
  }

  case GATE_APPROVED: {
    // Gate is open, waiting to close
    if (millis() - gateEventTime >= GATE_OPEN_TIME_MS) {
      gateServo.write(0); // Close gate
      gateState = GATE_IDLE;
      gateStudentIdx = -1;
      lcdShowOverride("Gate closed", "System ready");
      sendStatus();
    }
    break;
  }
  }
}

void gateApproved() {
  students[gateStudentIdx].location = LOC_LEFT;

  // Open gate
  gateServo.write(90);
  gateEventTime = millis(); // Reuse for gate open timer

  // Feedback
  flashBlue(2000);
  beepShort(2);

  // LCD
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("APPROVED!");
  lcd.setCursor(0, 1);
  lcd.print(students[gateStudentIdx].name);

  // Send event
  sendEvent("approved", gateStudentIdx);
  sendStatus();

  gateState = GATE_APPROVED;
}

// ============================================================
//  LED UPDATE
// ============================================================

void updateLEDs() {
  // Handle blue LED flash timeout
  if (blueLedFlashing && millis() >= blueLedOffTime) {
    digitalWrite(BLUE_LED, LOW);
    blueLedFlashing = false;
  }
}

// ============================================================
//  SETUP
// ============================================================

void setup() {
  // Initialize serial
  Serial.begin(9600);

  // CRITICAL: Set all SDA pins as OUTPUT HIGH *before* SPI.begin()
  // This prevents D10 (hardware SPI SS) from being hijacked by the SPI library
  pinMode(SS_GATE, OUTPUT);
  pinMode(SS_CLASS, OUTPUT);
  pinMode(SS_HOSTEL, OUTPUT);
  digitalWrite(SS_GATE, HIGH);
  digitalWrite(SS_CLASS, HIGH);
  digitalWrite(SS_HOSTEL, HIGH);

  // Initialize SPI
  SPI.begin();

  // Initialize RFID readers one at a time with deselect between each
  deselectAllReaders();
  rfidGate.PCD_Init();
  delay(50);

  deselectAllReaders();
  rfidClass.PCD_Init();
  delay(50);

  deselectAllReaders();
  rfidHostel.PCD_Init();
  delay(50);

  // Initialize LCD
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Guardian-Track");
  lcd.setCursor(0, 1);
  lcd.print("Initializing...");

  // Initialize servo (uses Timer1 — attach AFTER RFID init to avoid conflicts)
  gateServo.attach(SERVO_PIN);
  gateServo.write(0); // Start closed

  // Re-initialize hostel reader after servo attach, since Servo's Timer1
  // can interfere with pin D10 state during attach
  deselectAllReaders();
  rfidHostel.PCD_Init();
  delay(50);

  // Initialize output pins
  pinMode(BLUE_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  digitalWrite(BLUE_LED, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  // Startup feedback
  beepShort(1);
  flashBlue(1000);

  // Verify RFID readers
  Serial.println(F("{\"event\":\"boot\",\"status\":\"ok\"}"));

  delay(2000);
  lcd.clear();

  // Send initial status
  sendStudentList();
  sendStatus();
}

// ============================================================
//  MAIN LOOP
// ============================================================

void loop() {
  byte uid[UID_LENGTH];

  // --- Process serial commands from dashboard ---
  processSerialCommand();

  // --- Update gate state machine ---
  updateGateStateMachine();

  // --- Update alarm ---
  updateAlarm();

  // --- Update LEDs ---
  updateLEDs();

  // --- If gate is busy, don't process new scans on gate reader ---
  if (gateState == GATE_IDLE) {
    // --- Poll Gate Reader ---
    if (readCard(&rfidGate, uid)) {
      if (isAdmin(uid)) {
        // Admin tapped at gate - just acknowledge
        lcdShowOverride("Admin Card", "Recognized");
        flashBlue(500);
        beepShort(1);
      } else {
        int idx = findStudent(uid);
        if (idx >= 0) {
          handleGateDetection(idx);
        } else {
          // Unknown card
          lcdShowOverride("UNKNOWN CARD!", "Access Denied");
          flashRed(3);
          beepShort(3);
          sendEvent("unknown_card", -1, "zone", "gate");
        }
      }
    }
  }

  // --- Poll Classroom Reader (only if not being used for gate approval) ---
  if (gateState == GATE_IDLE || gateState == GATE_ALARM) {
    if (readCard(&rfidClass, uid)) {
      if (!isAdmin(uid)) {
        int idx = findStudent(uid);
        if (idx >= 0) {
          handleZoneTap(idx, ZONE_CLASS);
        } else {
          lcdShowOverride("UNKNOWN CARD!", "Classroom");
          flashRed(3);
          beepShort(3);
          sendEvent("unknown_card", -1, "zone", "classroom");
        }
      }
    }

    // --- Poll Hostel Reader ---
    if (readCard(&rfidHostel, uid)) {
      if (!isAdmin(uid)) {
        int idx = findStudent(uid);
        if (idx >= 0) {
          handleZoneTap(idx, ZONE_HOSTEL);
        } else {
          lcdShowOverride("UNKNOWN CARD!", "Hostel");
          flashRed(3);
          beepShort(3);
          sendEvent("unknown_card", -1, "zone", "hostel");
        }
      }
    }
  }

  // --- Update LCD default display ---
  updateLCDDefault();

  // --- Periodic status broadcast ---
  if (millis() - lastStatusBroadcast > STATUS_INTERVAL_MS) {
    lastStatusBroadcast = millis();
    sendStatus();
  }

  delay(50); // Small delay to prevent excessive polling
}
