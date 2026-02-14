/*
 * Test: All 3 readers with antenna re-enable fix
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
const char *names[] = {"Gate", "Class", "Hostel"};
byte ssPins[] = {SS_GATE, SS_CLASS, SS_HOSTEL};

void deselectAll() {
  for (byte i = 0; i < 3; i++) {
    digitalWrite(ssPins[i], HIGH);
  }
  // Also keep D10 high
  digitalWrite(10, HIGH);
}

void setup() {
  Serial.begin(9600);

  for (byte i = 0; i < 3; i++) {
    pinMode(ssPins[i], OUTPUT);
    digitalWrite(ssPins[i], HIGH);
  }
  pinMode(10, OUTPUT);
  digitalWrite(10, HIGH);

  SPI.begin();

  for (byte i = 0; i < 3; i++) {
    deselectAll();
    readers[i]->PCD_Init();
    delay(50);
  }

  Serial.println(F("=== All 3 readers with antenna re-enable fix ==="));
  Serial.println(F("Tap cards on any reader..."));
}

void loop() {
  byte uid[4];

  for (byte i = 0; i < 3; i++) {
    deselectAll();
    delayMicroseconds(100); // Let SPI bus settle

    // Re-enable the antenna for this reader before polling
    // Clone MFRC522 modules lose antenna state after bus contention
    readers[i]->PCD_AntennaOn();
    delayMicroseconds(100);

    if (readers[i]->PICC_IsNewCardPresent() &&
        readers[i]->PICC_ReadCardSerial()) {
      Serial.print(F("CARD on "));
      Serial.print(names[i]);
      Serial.print(F(": "));
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
      delay(500);
    }
  }

  delay(50);
}
