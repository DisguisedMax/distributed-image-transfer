/**
 * @file packet.js
 * @brief Shared packet protocol definitions for the Distributed Image Transfer System.
 *
 * @details
 * This module defines the structured packet format used for all communication
 * between the client and server. It provides packet type constants, CRC-16
 * checksum computation, and packet serialization/deserialization functions.
 *
 * Packet Structure:
 * @code
 * +-------+--------+------+---------+-----+-----+
 * |  STX  | Length | Type | Payload | CRC | ETX |
 * | 1 byte| 2 bytes|1 byte|  n bytes|2 b  | 1 b |
 * +-------+--------+------+---------+-----+-----+
 * @endcode
 *
 * - STX (0x02): Start of packet marker
 * - Length: 16-bit big-endian unsigned integer representing payload length
 * - Type: Packet type identifier from PacketType enum
 * - Payload: Variable-length data content
 * - CRC: CRC-16 checksum computed over Length + Type + Payload
 * - ETX (0x03): End of packet marker
 *
 * @author Maxwell Omorodion
 * @version 1.0.0
 */

'use strict';

/**
 * @brief Enumeration of all packet type identifiers in the protocol.
 *
 * @details
 * These values occupy the Type byte of every packet and determine
 * how the receiver interprets the payload.
 *
 * @enum {number}
 */
const PacketType = {
    /** @brief Authentication request — payload: "username:password" */
    AUTH:          0x01,
    /** @brief Authentication acknowledgement — payload: "SUCCESS" or "FAILED" */
    AUTH_ACK:      0x02,
    /** @brief Image download request — payload: empty */
    REQUEST_IMAGE: 0x03,
    /** @brief Image data chunk or end marker — payload: "index:total:<binary>" or "END:<size>" */
    IMAGE_DATA:    0x04,
    /** @brief Server status query — payload: empty */
    GET_STATUS:    0x05,
    /** @brief Server status response — payload: "STATE:<stateName>" */
    STATUS:        0x06,
    /** @brief Client disconnect notification — payload: empty */
    DISCONNECT:    0x07,
    /** @brief Error response — payload: error description string */
    ERROR:         0xFF,
};

/**
 * @brief Computes a CRC-16/ARC checksum over a data buffer.
 *
 * @details
 * Algorithm: CRC-16/ARC
 * - Polynomial: 0xA001 (reflected form of 0x8005)
 * - Initial value: 0xFFFF
 * - Input/output reflection: true
 *
 * This checksum is computed over the Length + Type + Payload fields
 * and appended to every packet before transmission. The receiver
 * recomputes the CRC to verify packet integrity.
 *
 * @param {Buffer} buffer - The data buffer to checksum
 * @returns {number} The 16-bit CRC value (0–65535)
 *
 * @example
 * const crc = crc16(Buffer.from('hello'));
 * // Returns a 16-bit checksum value
 */
function crc16(buffer) {
    let crc = 0xFFFF;
    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
        }
    }
    return crc;
}

/**
 * @brief Serializes a packet type and payload into the protocol's binary format.
 *
 * @details
 * Constructs a complete packet buffer with all required fields:
 * STX | Length | Type | Payload | CRC | ETX
 *
 * The CRC is computed over bytes 1 through (4 + payloadLength - 1),
 * i.e. the Length, Type, and Payload fields.
 *
 * @param {number} type - Packet type byte; must be a value from PacketType
 * @param {Buffer|string} payload - Payload data; strings are UTF-8 encoded
 * @returns {Buffer} The complete binary packet ready for transmission
 *
 * @example
 * const pkt = buildPacket(PacketType.AUTH, 'admin:password');
 * socket.write(pkt);
 */
function buildPacket(type, payload) {
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    const length     = payloadBuf.length;
    const packet     = Buffer.alloc(7 + length);
    packet[0]        = 0x02;                        // STX
    packet.writeUInt16BE(length, 1);                // Length
    packet[3]        = type;                        // Type
    payloadBuf.copy(packet, 4);                     // Payload
    const crc = crc16(packet.slice(1, 4 + length));
    packet.writeUInt16BE(crc, 4 + length);          // CRC
    packet[6 + length] = 0x03;                     // ETX
    return packet;
}

/**
 * @brief Deserializes a raw buffer into a packet object and validates its CRC.
 *
 * @details
 * Verifies the STX byte, reads the declared payload length, extracts the
 * payload, and validates the CRC. Returns null if any check fails.
 * CRC failures are identified by comparing the received CRC against a
 * freshly computed value — callers should log the failure before discarding.
 *
 * @param {Buffer} data - Raw bytes received from the TCP socket
 * @returns {{ type: number, payload: Buffer } | null}
 *   A packet object on success, or null if the data is malformed or CRC fails
 *
 * @example
 * socket.on('data', (data) => {
 *   const packet = parsePacket(data);
 *   if (packet) { ... }
 * });
 */
function parsePacket(data) {
    if (data.length < 7)  return null;
    if (data[0] !== 0x02) return null;

    const length      = data.readUInt16BE(1);
    const type        = data[3];
    const payload     = data.slice(4, 4 + length);
    const receivedCRC = data.readUInt16BE(4 + length);
    const computedCRC = crc16(data.slice(1, 4 + length));

    if (receivedCRC !== computedCRC) return null;

    return { type, payload };
}

// Exports

module.exports = { PacketType, crc16, buildPacket, parsePacket };