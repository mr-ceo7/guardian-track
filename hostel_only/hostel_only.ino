/*
 * Test ONLY the Hostel reader on D2 - nothing else
 */
#include <MFRC522.h>
#include <SPI.h>

#define RST_PIN 9
#define SS_HOSTEL 2

// Also explicitly keep D10 as OUTPUT for SPI master mode
MFRC522 rfidHostel(SS_HOSTEL, RST_PIN);

void setup() {
  Serial.begin(9600);

  pinMode(SS_HOSTEL, OUTPUT);
  digitalWrite(SS_HOSTEL, HIGH);

  // Keep hardware SPI SS (D10) as output
  pinMode(10, OUTPUT);
  digitalWrite(10, HIGH);

  // Also set D7 and D8 HIGH so other readers don't interfere on shared SPI
  pinMode(7, OUTPUT);
  digitalWrite(7, HIGH);
  pinMode(8, OUTPUT);
  digitalWrite(8, HIGH);

  SPI.begin();

  rfidHostel.PCD_Init();
  delay(100);

  byte ver = rfidHostel.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.print(F("Hostel reader firmware: 0x"));
  Serial.println(ver, HEX);
  Serial.println(F("Tap card on HOSTEL reader (D2) ONLY..."));
}

void loop() {
  if (rfidHostel.PICC_IsNewCardPresent() && rfidHostel.PICC_ReadCardSerial()) {
    Serial.print(F("HOSTEL CARD: "));
    for (byte i = 0; i < rfidHostel.uid.size; i++) {
      if (i > 0)
        Serial.print(":");
      if (rfidHostel.uid.uidByte[i] < 0x10)
        Serial.print("0");
      Serial.print(rfidHostel.uid.uidByte[i], HEX);
    }
    Serial.println();
    rfidHostel.PICC_HaltA();
    rfidHostel.PCD_StopCrypto1();
    delay(1000);
  }
  delay(50);
}
