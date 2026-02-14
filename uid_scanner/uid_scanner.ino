/*
 * Guardian-Track: UID Scanner Utility
 * ====================================
 * Scans all 3 RFID readers and prints detected card UIDs
 * to Serial Monitor + LCD display.
 *
 * Use this to identify all 6 RFID tags before configuring
 * the main Guardian-Track firmware.
 *
 * Wiring:
 *   RFID 1 (Gate)      SDA -> D7
 *   RFID 2 (Classroom) SDA -> D8
 *   RFID 3 (Hostel)    SDA -> D10
 *   All RFIDs share: SCK=D13, MOSI=D11, MISO=D12, RST=D9
 *   I2C LCD: SDA=A4, SCL=A5
 */

#include <LiquidCrystal_I2C.h>
#include <MFRC522.h>
#include <SPI.h>
#include <Wire.h>

// --- Pin Definitions ---
#define RST_PIN 9 // Shared RST for all RFID readers

#define SS_GATE 7   // RFID 1 - Gate
#define SS_CLASS 8  // RFID 2 - Classroom
#define SS_HOSTEL 2 // RFID 3 - Hostel

// --- RFID Reader Instances ---
MFRC522 rfidGate(SS_GATE, RST_PIN);
MFRC522 rfidClass(SS_CLASS, RST_PIN);
MFRC522 rfidHostel(SS_HOSTEL, RST_PIN);

// --- LCD (16x2, I2C address 0x27) ---
LiquidCrystal_I2C lcd(0x27, 16, 2);

// Reader names for display
const char *readerNames[] = {"Gate", "Classroom", "Hostel"};
MFRC522 *readers[] = {&rfidGate, &rfidClass, &rfidHostel};

int totalScanned = 0;

void deselectAllReaders() {
  digitalWrite(SS_GATE, HIGH);
  digitalWrite(SS_CLASS, HIGH);
  digitalWrite(SS_HOSTEL, HIGH);
}

void setup() {
  Serial.begin(9600);
  while (!Serial)
    ; // Wait for serial on some boards

  // CRITICAL: Set all SDA pins as OUTPUT HIGH before SPI.begin()
  // Prevents D10 (hardware SPI SS) from being hijacked
  pinMode(SS_GATE, OUTPUT);
  pinMode(SS_CLASS, OUTPUT);
  pinMode(SS_HOSTEL, OUTPUT);
  digitalWrite(SS_GATE, HIGH);
  digitalWrite(SS_CLASS, HIGH);
  digitalWrite(SS_HOSTEL, HIGH);

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

  // Small delay for readers to stabilize
  delay(100);

  // Initialize LCD
  lcd.init();
  lcd.backlight();

  // Welcome message
  lcd.setCursor(0, 0);
  lcd.print("Guardian-Track");
  lcd.setCursor(0, 1);
  lcd.print("UID Scanner v1.0");

  Serial.println(F("========================================"));
  Serial.println(F("  Guardian-Track: UID Scanner Utility"));
  Serial.println(F("========================================"));
  Serial.println(F(""));
  Serial.println(F("Tap each RFID tag on ANY reader to see its UID."));
  Serial.println(F("You have 6 tags to scan (3 cards + 3 key fobs)."));
  Serial.println(F(""));

  // Verify readers are connected
  Serial.println(F("--- Reader Status ---"));
  for (int i = 0; i < 3; i++) {
    Serial.print(readerNames[i]);
    Serial.print(F(": "));
    byte version = readers[i]->PCD_ReadRegister(MFRC522::VersionReg);
    if (version == 0x00 || version == 0xFF) {
      Serial.println(F("NOT DETECTED! Check wiring."));
    } else {
      Serial.print(F("OK (firmware v"));
      Serial.print(version, HEX);
      Serial.println(F(")"));
    }
  }
  Serial.println(F("---------------------"));
  Serial.println(F(""));
  Serial.println(F("Waiting for cards..."));
  Serial.println(F(""));

  delay(2000);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Tap a card...");
  lcd.setCursor(0, 1);
  lcd.print("Scanned: 0");
}

void loop() {
  // Poll each reader
  for (int i = 0; i < 3; i++) {
    deselectAllReaders(); // Ensure clean SPI bus before selecting reader
    // Check if a new card is present
    if (readers[i]->PICC_IsNewCardPresent() &&
        readers[i]->PICC_ReadCardSerial()) {
      totalScanned++;

      // Build UID string
      String uidStr = "";
      for (byte j = 0; j < readers[i]->uid.size; j++) {
        if (j > 0)
          uidStr += ":";
        if (readers[i]->uid.uidByte[j] < 0x10)
          uidStr += "0";
        uidStr += String(readers[i]->uid.uidByte[j], HEX);
      }
      uidStr.toUpperCase();

      // Print to Serial
      Serial.print(F(">>> Tag #"));
      Serial.print(totalScanned);
      Serial.print(F("  |  Reader: "));
      Serial.print(readerNames[i]);
      Serial.print(F("  |  UID: "));
      Serial.println(uidStr);

      // Print raw bytes for easy copy-paste into firmware
      Serial.print(F("    Firmware format: {"));
      for (byte j = 0; j < readers[i]->uid.size; j++) {
        if (j > 0)
          Serial.print(F(", "));
        Serial.print(F("0x"));
        if (readers[i]->uid.uidByte[j] < 0x10)
          Serial.print(F("0"));
        Serial.print(readers[i]->uid.uidByte[j], HEX);
      }
      Serial.println(F("}"));
      Serial.println(F(""));

      // Display on LCD
      lcd.clear();
      lcd.setCursor(0, 0);
      lcd.print(readerNames[i]);
      lcd.print(" Reader");
      lcd.setCursor(0, 1);
      lcd.print(uidStr);

      // Halt the card
      readers[i]->PICC_HaltA();
      readers[i]->PCD_StopCrypto1();

      // Wait a moment before scanning again
      delay(1500);

      // Show count on LCD
      lcd.clear();
      lcd.setCursor(0, 0);
      lcd.print("Tap next card...");
      lcd.setCursor(0, 1);
      lcd.print("Scanned: ");
      lcd.print(totalScanned);
    }
  }

  delay(100); // Small delay between polling cycles
}
