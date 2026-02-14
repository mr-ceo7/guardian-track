/*
 * Guardian-Track: Individual Reader Diagnostic
 * =============================================
 * Tests each RFID reader one by one to verify hardware connection.
 * Upload this, open Serial Monitor at 9600 baud, and check output.
 */

#include <MFRC522.h>
#include <SPI.h>

#define RST_PIN 9
#define SS_GATE 7
#define SS_CLASS 8
#define SS_HOSTEL 2

MFRC522 rfidGate(SS_GATE, RST_PIN);
MFRC522 rfidClass(SS_CLASS, RST_PIN);
MFRC522 rfidHostel(SS_HOSTEL, RST_PIN);

MFRC522 *readers[] = {&rfidGate, &rfidClass, &rfidHostel};
const char *names[] = {"Gate (D7)", "Classroom (D8)", "Hostel (D10)"};
byte ssPins[] = {SS_GATE, SS_CLASS, SS_HOSTEL};

void deselectAll() {
  digitalWrite(SS_GATE, HIGH);
  digitalWrite(SS_CLASS, HIGH);
  digitalWrite(SS_HOSTEL, HIGH);
}

void setup() {
  Serial.begin(9600);
  while (!Serial)
    ;

  Serial.println(F("=== RFID Reader Diagnostic ==="));
  Serial.println();

  // Set ALL SDA pins as OUTPUT HIGH before anything else
  for (byte i = 0; i < 3; i++) {
    pinMode(ssPins[i], OUTPUT);
    digitalWrite(ssPins[i], HIGH);
  }

  SPI.begin();

  // Test each reader individually
  for (byte i = 0; i < 3; i++) {
    Serial.print(F("--- Testing: "));
    Serial.print(names[i]);
    Serial.println(F(" ---"));

    // Deselect all, then init this one
    deselectAll();
    delay(50);

    readers[i]->PCD_Init();
    delay(100);

    // Read firmware version
    byte version = readers[i]->PCD_ReadRegister(MFRC522::VersionReg);
    Serial.print(F("  Firmware version: 0x"));
    Serial.println(version, HEX);

    if (version == 0x00 || version == 0xFF) {
      Serial.println(F("  *** NOT DETECTED! Check wiring. ***"));
      Serial.println(F("  Expected: 0x91 (v1.0) or 0x92 (v2.0)"));
    } else if (version == 0x91) {
      Serial.println(F("  Status: OK (MFRC522 v1.0)"));
    } else if (version == 0x92) {
      Serial.println(F("  Status: OK (MFRC522 v2.0)"));
    } else {
      Serial.print(F("  Status: UNKNOWN version (might still work)"));
    }

    // Try a self-test
    bool selfTest = readers[i]->PCD_PerformSelfTest();
    Serial.print(F("  Self-test: "));
    Serial.println(selfTest ? "PASSED" : "FAILED");

    // Re-init after self test (self test resets the reader)
    readers[i]->PCD_Init();
    delay(50);

    Serial.println();
  }

  Serial.println(F("=== Diagnostic Complete ==="));
  Serial.println(F("Now continuously polling all readers..."));
  Serial.println(F("Tap a card on any reader to test detection."));
  Serial.println();
}

void loop() {
  for (byte i = 0; i < 3; i++) {
    deselectAll();

    if (readers[i]->PICC_IsNewCardPresent() &&
        readers[i]->PICC_ReadCardSerial()) {
      Serial.print(F("CARD DETECTED on "));
      Serial.print(names[i]);
      Serial.print(F(" -> UID: "));

      for (byte j = 0; j < readers[i]->uid.size; j++) {
        if (j > 0)
          Serial.print(":");
        if (readers[i]->uid.uidByte[j] < 0x10)
          Serial.print("0");
        Serial.print(readers[i]->uid.uidByte[j], HEX);
      }
      Serial.println();

      readers[i]->PICC_HaltA();
      readers[i]->PCD_StopCrypto1();

      delay(1000);
    }
  }

  delay(100);
}
