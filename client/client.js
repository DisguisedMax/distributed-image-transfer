/**
 * @file client.js
 * @brief Distributed Image Transfer Client
 *
 * @details
 * This client application connects to the image transfer server via TCP/IP,
 * authenticates using a username and password, and requests JPEG image downloads.
 * It uses a structured packet protocol with CRC validation, displays a live
 * progress bar during image transfer, and logs all activity to a timestamped file.
 *
 * @author Maxwell Omorodion
 * @version 1.0.0
 *
 * @section usage Usage
 * @code
 * node client/client.js
 * @endcode
 */

'use strict';

const net      = require('net');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// Logging Setup

/** @constant {string} logDir - Directory where client log files are stored */
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** @constant {string} logFile - Full path to this session's client log file */
const logFile = path.join(logDir, `client_log_${timestamp}.txt`);

/**
 * @brief Writes a packet log entry to the client log file.
 *
 * @param {string} direction - 'TX', 'RX', or 'SYS'
 * @param {string} packetType - Packet type name (e.g. 'AUTH', 'IMAGE_DATA')
 * @param {string} payloadSummary - Human-readable description of the payload
 * @returns {void}
 */
function logEntry(direction, packetType, payloadSummary) {
    const now  = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const line = `[${now}] [${direction}] [${packetType}] ${payloadSummary}\n`;
    fs.appendFileSync(logFile, line);
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
    AUTH:          0x01, /**< Authentication request sent to server */
    AUTH_ACK:      0x02, /**< Authentication result received from server */
    REQUEST_IMAGE: 0x03, /**< Image download request sent to server */
    IMAGE_DATA:    0x04, /**< Image chunk or end marker received from server */
    GET_STATUS:    0x05, /**< Status query sent to server */
    STATUS:        0x06, /**< Status response received from server */
    DISCONNECT:    0x07, /**< Disconnect notification sent to server */
    ERROR:         0xFF, /**< Error packet received from server */
};

/**
 * @brief Computes a CRC-16 checksum over a buffer.
 *
 * @details
 * Uses the CRC-16/ARC polynomial (0xA001) with initial value 0xFFFF.
 * Must match the server implementation exactly for validation to succeed.
 *
 * @param {Buffer} buffer - Data to checksum
 * @returns {number} 16-bit CRC value
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
 * @param {Buffer|string} payload - Packet payload data
 * @returns {Buffer} Complete serialized packet
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

// Packet Parser

/**
 * @brief Internal receive buffer for handling partial and multi-packet TCP data.
 * @type {Buffer}
 */
let receiveBuffer = Buffer.alloc(0);

/**
 * @brief Attempts to extract and validate the next complete packet from receiveBuffer.
 *
 * @details
 * Handles TCP stream fragmentation by accumulating data until a full packet
 * is available. Performs CRC validation and resyncs the buffer if STX is missing.
 * Logs CRC failures before discarding the packet.
 *
 * @returns {{ type: number, payload: Buffer } | null} Parsed packet or null if incomplete/invalid
 */
function tryParsePacket() {
    if (receiveBuffer.length < 7) return null;
    if (receiveBuffer[0] !== 0x02) {
        const idx = receiveBuffer.indexOf(0x02, 1);
        receiveBuffer = idx >= 0 ? receiveBuffer.slice(idx) : Buffer.alloc(0);
        return null;
    }
    const length    = receiveBuffer.readUInt16BE(1);
    const totalSize = 7 + length;
    if (receiveBuffer.length < totalSize) return null;

    const packetBuf   = receiveBuffer.slice(0, totalSize);
    receiveBuffer     = receiveBuffer.slice(totalSize);

    const type        = packetBuf[3];
    const payload     = packetBuf.slice(4, 4 + length);
    const receivedCRC = packetBuf.readUInt16BE(4 + length);
    const computedCRC = crc16(packetBuf.slice(1, 4 + length));

    if (receivedCRC !== computedCRC) {
        logEntry('RX', 'CRC_FAIL', `Expected 0x${computedCRC.toString(16)} got 0x${receivedCRC.toString(16)}`);
        console.log('⚠ CRC validation failed on received packet');
        return null;
    }
    return { type, payload };
}

// Client State

/**
 * @brief Tracks whether the client has successfully authenticated.
 * @type {boolean}
 */
let authenticated = false;

/**
 * @brief Indicates if an image transfer is currently in progress.
 * @type {boolean}
 */
let receivingImage = false;

/**
 * @brief Accumulates received image data chunks during transfer.
 * @type {Buffer[]}
 */
let imageChunks = [];

/**
 * @brief Total number of chunks expected in the current image transfer.
 * @type {number}
 */
let totalChunks = 0;

/** @type {readline.Interface} - CLI interface for user input */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/** @type {net.Socket} - TCP socket for server communication */
const client = new net.Socket();

// Menu

/**
 * @brief Displays the main command menu and waits for user input.
 *
 * @details
 * Available options:
 * 1. Login — prompts for username/password and sends AUTH packet
 * 2. Request Image — sends REQUEST_IMAGE (requires authentication)
 * 3. Get Status — sends GET_STATUS to query server state
 * 4. Disconnect — sends DISCONNECT and closes connection
 *
 * @returns {void}
 */
function showMenu() {
    console.log('\n╔══════════════════════════╗');
    console.log('║        MAIN MENU         ║');
    console.log('╠══════════════════════════╣');
    console.log('║  1. Login                ║');
    console.log('║  2. Request Image        ║');
    console.log('║  3. Get Status           ║');
    console.log('║  4. Disconnect           ║');
    console.log('╚══════════════════════════╝');
    rl.question('Choose: ', handleMenuChoice);
}

/**
 * @brief Processes the user's menu selection and sends the appropriate packet.
 *
 * @param {string} choice - The user's input string from the menu prompt
 * @returns {void}
 */
function handleMenuChoice(choice) {
    switch (choice.trim()) {
        case '1': {
            rl.question('Username: ', (user) => {
                rl.question('Password: ', (pass) => {
                    const packet = buildPacket(PacketType.AUTH, `${user}:${pass}`);
                    client.write(packet);
                    logEntry('TX', 'AUTH', `user=${user}`);
                });
            });
            break;
        }
        case '2': {
            if (!authenticated) {
                console.log('⚠ Please login first.');
                showMenu();
                return;
            }
            const packet = buildPacket(PacketType.REQUEST_IMAGE, '');
            client.write(packet);
            logEntry('TX', 'REQUEST_IMAGE', '');
            console.log('📥 Requesting image from server...');
            break;
        }
        case '3': {
            const packet = buildPacket(PacketType.GET_STATUS, '');
            client.write(packet);
            logEntry('TX', 'GET_STATUS', '');
            break;
        }
        case '4': {
            const packet = buildPacket(PacketType.DISCONNECT, '');
            client.write(packet);
            logEntry('TX', 'DISCONNECT', '');
            client.end();
            rl.close();
            break;
        }
        default:
            console.log('Invalid option.');
            showMenu();
    }
}

// Connection

/**
 * @brief Initiates TCP connection to the server and shows the menu on success.
 */
client.connect(5000, '127.0.0.1', () => {
    console.log('\n✔ Connected to server');
    logEntry('SYS', 'CONNECTION', 'Connected to server at 127.0.0.1:5000');
    showMenu();
});

/**
 * @brief Handles incoming data from the server.
 *
 * @details
 * Appends incoming bytes to receiveBuffer and processes all complete
 * packets found in the buffer using tryParsePacket().
 */
client.on('data', (data) => {
    receiveBuffer = Buffer.concat([receiveBuffer, data]);
    let packet;
    while ((packet = tryParsePacket()) !== null) {
        handlePacket(packet);
    }
});

/**
 * @brief Dispatches a parsed packet to the appropriate handler.
 *
 * @details
 * Handles the following incoming packet types:
 * - AUTH_ACK: Login result
 * - IMAGE_DATA: Image chunk or transfer completion
 * - STATUS: Current server state
 * - ERROR: Server-side error message
 *
 * @param {{ type: number, payload: Buffer }} packet - The parsed packet to handle
 * @returns {void}
 */
function handlePacket(packet) {
    switch (packet.type) {

        /**
         * AUTH_ACK: Updates authenticated state and shows result to user.
         */
        case PacketType.AUTH_ACK: {
            const result = packet.payload.toString();
            logEntry('RX', 'AUTH_ACK', result);
            if (result === 'SUCCESS') {
                authenticated = true;
                console.log('✔ Login successful');
            } else {
                console.log('✘ Login failed. Check your credentials.');
            }
            showMenu();
            break;
        }

        /**
         * IMAGE_DATA: Accumulates chunks and saves the image on END marker.
         * Displays a live progress bar during transfer.
         */
        case PacketType.IMAGE_DATA: {
            const payloadStr = packet.payload.toString('utf8', 0, Math.min(50, packet.payload.length));

            if (payloadStr.startsWith('END:')) {
                const totalBytes  = parseInt(payloadStr.split(':')[1]);
                const imageBuffer = Buffer.concat(imageChunks);
                const savePath    = path.join(__dirname, 'received.jpg');
                fs.writeFileSync(savePath, imageBuffer);
                logEntry('RX', 'IMAGE_DATA', `END total=${totalBytes} bytes`);
                console.log(`\n✔ Image received and saved to: ${savePath}`);
                console.log(`  Total size: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
                receivingImage = false;
                imageChunks    = [];
                showMenu();
            } else {
                const colonOne  = packet.payload.indexOf(':');
                const colonTwo  = packet.payload.indexOf(':', colonOne + 1);
                const chunkIndex = parseInt(packet.payload.slice(0, colonOne).toString());
                totalChunks      = parseInt(packet.payload.slice(colonOne + 1, colonTwo).toString());
                const chunkData  = packet.payload.slice(colonTwo + 1);

                imageChunks.push(chunkData);
                receivingImage = true;

                const pct    = Math.round(((chunkIndex + 1) / totalChunks) * 100);
                const filled = Math.round(pct / 5);
                const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
                process.stdout.write(`\r  Downloading: [${bar}] ${pct}% (${chunkIndex + 1}/${totalChunks})`);
                logEntry('RX', 'IMAGE_DATA', `chunk ${chunkIndex + 1}/${totalChunks}`);
            }
            break;
        }

        /**
         * STATUS: Displays the server's current state machine state.
         */
        case PacketType.STATUS: {
            const status = packet.payload.toString();
            logEntry('RX', 'STATUS', status);
            console.log(`\n📊 Server Status: ${status}`);
            showMenu();
            break;
        }

        /**
         * ERROR: Displays the server error message to the user.
         */
        case PacketType.ERROR: {
            const msg = packet.payload.toString();
            logEntry('RX', 'ERROR', msg);
            console.log(`\n✘ Server error: ${msg}`);
            showMenu();
            break;
        }

        default:
            logEntry('RX', 'UNKNOWN', `type=0x${packet.type.toString(16)}`);
    }
}

client.on('close', () => {
    console.log('\n✔ Connection closed');
    logEntry('SYS', 'CONNECTION', 'Connection closed');
    rl.close();
});

client.on('error', (err) => {
    console.log(`\n✘ Connection error: ${err.message}`);
    logEntry('SYS', 'ERROR', err.message);
    rl.close();
});