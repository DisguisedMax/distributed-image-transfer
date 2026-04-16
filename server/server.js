/**
 * @file server.js
 * @brief Distributed Image Transfer Server
 *
 * @details
 * This server application implements a TCP/IP socket server that authenticates
 * clients and transfers JPEG images using a structured packet protocol.
 * It implements a state machine with four states: IDLE, AUTHENTICATED,
 * TRANSFERRING, and DISCONNECTED. All transmitted and received packets are
 * logged to a timestamped log file.
 *
 * @author Maxwell Omorodion
 * @version 1.0.0
 *
 * @section usage Usage
 * @code
 * node server/server.js
 * @endcode
 */
 
'use strict';
 
const net  = require('net');
const fs   = require('fs');
const path = require('path');
 
/** @constant {number} PORT - The TCP port the server listens on */
const PORT = 5000;
 
/** @constant {string} USERNAME - Hardcoded valid username for authentication */
const USERNAME = "admin";
 
/** @constant {string} PASSWORD - Hardcoded valid password for authentication */
const PASSWORD = "password";
 
// Logging Setup
 
/** @constant {string} logDir - Directory path where log files are stored */
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
 
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
 
/** @constant {string} logFile - Full path to the current session log file */
const logFile = path.join(logDir, `server_log_${timestamp}.txt`);
 
/**
 * @brief Writes a packet log entry to the log file and stdout.
 *
 * @param {string} direction - Direction of communication: 'TX', 'RX', or 'SYS'
 * @param {string} packetType - The type/name of the packet (e.g. 'AUTH', 'IMAGE_DATA')
 * @param {string} payloadSummary - A human-readable summary of the packet payload
 * @returns {void}
 */
function logEntry(direction, packetType, payloadSummary) {
    const now  = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const line = `[${now}] [${direction}] [${packetType}] ${payloadSummary}\n`;
    fs.appendFileSync(logFile, line);
    process.stdout.write(line);
}
 
/**
 * @brief Logs a state machine transition to the log file and stdout.
 *
 * @param {string} prevState - The state before the transition
 * @param {string} event - The event that triggered the transition
 * @param {string} newState - The state after the transition
 * @returns {void}
 */
function logStateTransition(prevState, event, newState) {
    const now  = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const line = `[${now}] [STATE] ${prevState} --[${event}]--> ${newState}\n`;
    fs.appendFileSync(logFile, line);
    process.stdout.write(line);
}
 
// Packet Definitions
 
/**
 * @brief Enumeration of packet type identifiers used in the protocol.
 *
 * @details
 * Packet format: STX(1) | Length(2) | Type(1) | Payload(n) | CRC(2) | ETX(1)
 *
 * @enum {number}
 */
const PacketType = {
    AUTH:          0x01, /**< Authentication request from client */
    AUTH_ACK:      0x02, /**< Authentication acknowledgement from server */
    REQUEST_IMAGE: 0x03, /**< Client request to receive image */
    IMAGE_DATA:    0x04, /**< Image chunk or end marker from server */
    GET_STATUS:    0x05, /**< Client request for server state */
    STATUS:        0x06, /**< Server response with state machine state */
    DISCONNECT:    0x07, /**< Client disconnect notification */
    ERROR:         0xFF, /**< Error response packet */
};
 
/**
 * @brief Computes a CRC-16 checksum over a buffer.
 *
 * @details
 * Uses the CRC-16/ARC polynomial (0xA001) with initial value 0xFFFF.
 * Used to validate packet integrity on both send and receive.
 *
 * @param {Buffer} buffer - The data to checksum
 * @returns {number} The 16-bit CRC value
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
 * @brief Constructs a structured data packet from a type and payload.
 *
 * @details
 * Packet format: STX(1) | Length(2) | Type(1) | Payload(n) | CRC(2) | ETX(1)
 * STX = 0x02, ETX = 0x03, CRC computed over Length+Type+Payload.
 *
 * @param {number} type - Packet type byte from PacketType enum
 * @param {Buffer|string} payload - The packet payload
 * @returns {Buffer} The complete serialized packet
 */
function buildPacket(type, payload) {
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    const length     = payloadBuf.length;
    const packet     = Buffer.alloc(7 + length);
    packet[0]        = 0x02;
    packet.writeUInt16BE(length, 1);
    packet[3]        = type;
    payloadBuf.copy(packet, 4);
    const crc = crc16(packet.slice(1, 4 + length));
    packet.writeUInt16BE(crc, 4 + length);
    packet[6 + length] = 0x03;
    return packet;
}
 
/**
 * @brief Parses raw socket data into a structured packet object.
 *
 * @details
 * Validates STX byte and CRC checksum. Logs CRC failures with
 * expected vs received values before returning null.
 *
 * @param {Buffer} data - Raw bytes received from the TCP socket
 * @returns {{ type: number, payload: Buffer } | null} Parsed packet, or null on error
 */
function parsePacket(data) {
    if (data.length < 7)  return null;
    if (data[0] !== 0x02) return null;
    const length      = data.readUInt16BE(1);
    const type        = data[3];
    const payload     = data.slice(4, 4 + length);
    const receivedCRC = data.readUInt16BE(4 + length);
    const computedCRC = crc16(data.slice(1, 4 + length));
    if (receivedCRC !== computedCRC) {
        logEntry('RX', 'CRC_FAIL', `Expected 0x${computedCRC.toString(16)} got 0x${receivedCRC.toString(16)}`);
        return null;
    }
    return { type, payload };
}
 
// State Machine
 
/**
 * @brief Server-side state machine state definitions.
 *
 * @details
 * One state instance is maintained per connected client:
 * - IDLE: Connected, awaiting authentication
 * - AUTHENTICATED: Login verified, commands accepted
 * - TRANSFERRING: Image transfer in progress
 * - DISCONNECTED: Session ended
 *
 * @enum {string}
 */
const State = {
    IDLE:          'IDLE',
    AUTHENTICATED: 'AUTHENTICATED',
    TRANSFERRING:  'TRANSFERRING',
    DISCONNECTED:  'DISCONNECTED',
};
 
// Server Startup
 
console.log(`\n╔══════════════════════════════════════╗`);
console.log(`║  Distributed Image Transfer Server  ║`);
console.log(`║  Listening on port ${PORT}             ║`);
console.log(`║  Version 1.0.0                      ║`);
console.log(`╚══════════════════════════════════════╝\n`);
 
/**
 * @brief TCP server instance.
 *
 * @details
 * Each client connection gets its own state machine. Handles AUTH,
 * REQUEST_IMAGE, GET_STATUS, and DISCONNECT packets. Image data is
 * read from /images/sample.jpg and streamed in 4096-byte chunks.
 */
const server = net.createServer((socket) => {
    /** @type {string} Current state machine state for this client */
    let state = State.IDLE;
 
    logEntry('SYS', 'CONNECTION', `Client connected from ${socket.remoteAddress}`);
    logStateTransition('--', 'CLIENT_CONNECTED', state);
 
    /**
     * @brief Transitions the state machine and logs the change.
     *
     * @param {string} event - The triggering event
     * @param {string} newState - The target state
     * @returns {void}
     */
    function setState(event, newState) {
        logStateTransition(state, event, newState);
        state = newState;
    }
 
    socket.on('data', (data) => {
        const packet = parsePacket(data);
        if (!packet) {
            socket.write(buildPacket(PacketType.ERROR, 'INVALID_PACKET'));
            return;
        }
 
        switch (packet.type) {
 
            /**
             * AUTH: Validates credentials and transitions to AUTHENTICATED on success.
             */
            case PacketType.AUTH: {
                const [user, pass] = packet.payload.toString().split(':');
                logEntry('RX', 'AUTH', `user=${user}`);
                if (user === USERNAME && pass === PASSWORD) {
                    setState('AUTH_SUCCESS', State.AUTHENTICATED);
                    socket.write(buildPacket(PacketType.AUTH_ACK, 'SUCCESS'));
                    logEntry('TX', 'AUTH_ACK', 'SUCCESS');
                } else {
                    socket.write(buildPacket(PacketType.AUTH_ACK, 'FAILED'));
                    logEntry('TX', 'AUTH_ACK', 'FAILED');
                }
                break;
            }
 
            /**
             * REQUEST_IMAGE: Reads sample.jpg and streams it in 4096-byte chunks.
             * Transitions: AUTHENTICATED -> TRANSFERRING -> AUTHENTICATED.
             */
            case PacketType.REQUEST_IMAGE: {
                logEntry('RX', 'REQUEST_IMAGE', '');
                if (state !== State.AUTHENTICATED) {
                    socket.write(buildPacket(PacketType.ERROR, 'NOT_AUTHENTICATED'));
                    logEntry('TX', 'ERROR', 'NOT_AUTHENTICATED');
                    return;
                }
                setState('REQUEST_IMAGE', State.TRANSFERRING);
 
                const imagePath = path.join(__dirname, '..', 'images', 'sample.jpg');
                fs.readFile(imagePath, (err, imageData) => {
                    if (err) {
                        socket.write(buildPacket(PacketType.ERROR, 'FILE_NOT_FOUND'));
                        logEntry('TX', 'ERROR', 'FILE_NOT_FOUND');
                        setState('TRANSFER_FAILED', State.AUTHENTICATED);
                        return;
                    }
 
                    /** @constant {number} CHUNK_SIZE - Max bytes per image packet */
                    const CHUNK_SIZE  = 4096;
                    let offset        = 0;
                    let chunkIndex    = 0;
                    const totalChunks = Math.ceil(imageData.length / CHUNK_SIZE);
 
                    /**
                     * @brief Sends the next image chunk, called recursively via setImmediate.
                     * @returns {void}
                     */
                    function sendNextChunk() {
                        if (offset >= imageData.length) {
                            socket.write(buildPacket(PacketType.IMAGE_DATA, `END:${imageData.length}`));
                            logEntry('TX', 'IMAGE_DATA', `END total=${imageData.length} bytes`);
                            setState('TRANSFER_COMPLETE', State.AUTHENTICATED);
                            return;
                        }
                        const chunk   = imageData.slice(offset, offset + CHUNK_SIZE);
                        const header  = Buffer.from(`${chunkIndex}:${totalChunks}:`);
                        const payload = Buffer.concat([header, chunk]);
                        socket.write(buildPacket(PacketType.IMAGE_DATA, payload));
                        logEntry('TX', 'IMAGE_DATA', `chunk ${chunkIndex + 1}/${totalChunks}`);
                        offset += CHUNK_SIZE;
                        chunkIndex++;
                        setImmediate(sendNextChunk);
                    }
 
                    sendNextChunk();
                });
                break;
            }
 
            /**
             * GET_STATUS: Responds with the current state machine state string.
             */
            case PacketType.GET_STATUS: {
                logEntry('RX', 'GET_STATUS', '');
                socket.write(buildPacket(PacketType.STATUS, `STATE:${state}`));
                logEntry('TX', 'STATUS', `STATE:${state}`);
                break;
            }
 
            /**
             * DISCONNECT: Closes the socket gracefully.
             * Transitions: any -> DISCONNECTED.
             */
            case PacketType.DISCONNECT: {
                logEntry('RX', 'DISCONNECT', '');
                setState('CLIENT_DISCONNECT', State.DISCONNECTED);
                socket.end();
                break;
            }
 
            default:
                socket.write(buildPacket(PacketType.ERROR, 'UNKNOWN_PACKET_TYPE'));
                logEntry('TX', 'ERROR', 'UNKNOWN_PACKET_TYPE');
        }
    });
 
    socket.on('end', () => {
        if (state !== State.DISCONNECTED) setState('SOCKET_END', State.DISCONNECTED);
        logEntry('SYS', 'CONNECTION', 'Client disconnected');
    });
 
    socket.on('error', (err) => {
        logEntry('SYS', 'ERROR', err.message);
    });
});
 
server.listen(PORT, () => {
    logEntry('SYS', 'STARTUP', `Server listening on port ${PORT}`);
});