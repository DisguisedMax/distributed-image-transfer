const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
const USERNAME = "admin";
const PASSWORD = "password";

// Logging Setup
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = path.join(logDir, `server_log_${timestamp}.txt`);

function logEntry(direction, packetType, payloadSummary) {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const line = `[${now}] [${direction}] [${packetType}] ${payloadSummary}\n`;
    fs.appendFileSync(logFile, line);
    process.stdout.write(line);
}

function logStateTransition(prevState, event, newState) {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const line = `[${now}] [STATE] ${prevState} --[${event}]--> ${newState}\n`;
    fs.appendFileSync(logFile, line);
    process.stdout.write(line);
}

// Packet Helpers
const PacketType = {
    AUTH:         0x01,
    AUTH_ACK:     0x02,
    REQUEST_IMAGE:0x03,
    IMAGE_DATA:   0x04,
    GET_STATUS:   0x05,
    STATUS:       0x06,
    DISCONNECT:   0x07,
    ERROR:        0xFF,
};

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

function buildPacket(type, payload) {
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    const length = payloadBuf.length;
    // STX(1) + Length(2) + Type(1) + Payload(n) + CRC(2) + ETX(1)
    const packet = Buffer.alloc(7 + length);
    packet[0] = 0x02;                          // STX
    packet.writeUInt16BE(length, 1);           // Length
    packet[3] = type;                          // Type
    payloadBuf.copy(packet, 4);                // Payload
    const crc = crc16(packet.slice(1, 4 + length));
    packet.writeUInt16BE(crc, 4 + length);     // CRC
    packet[6 + length] = 0x03;                // ETX
    return packet;
}

function parsePacket(data) {
    if (data.length < 7) return null;
    if (data[0] !== 0x02) return null;
    const length = data.readUInt16BE(1);
    const type = data[3];
    const payload = data.slice(4, 4 + length);
    const receivedCRC = data.readUInt16BE(4 + length);
    const computedCRC = crc16(data.slice(1, 4 + length));
    if (receivedCRC !== computedCRC) {
        logEntry('RX', 'CRC_FAIL', `Expected 0x${computedCRC.toString(16)} got 0x${receivedCRC.toString(16)}`);
        return null;
    }
    return { type, payload };
}

// State Machine States 
const State = {
    IDLE:          'IDLE',
    AUTHENTICATED: 'AUTHENTICATED',
    TRANSFERRING:  'TRANSFERRING',
    DISCONNECTED:  'DISCONNECTED',
};

// Server 
console.log(`\n╔══════════════════════════════════════╗`);
console.log(`║  Distributed Image Transfer Server  ║`);
console.log(`║  Listening on port ${PORT}             ║`);
console.log(`║  Version 1.0.0                      ║`);
console.log(`╚══════════════════════════════════════╝\n`);

const server = net.createServer((socket) => {
    let state = State.IDLE;
    logEntry('SYS', 'CONNECTION', `Client connected from ${socket.remoteAddress}`);
    logStateTransition('--', 'CLIENT_CONNECTED', state);

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

            case PacketType.AUTH: {
                const [user, pass] = packet.payload.toString().split(':');
                logEntry('RX', 'AUTH', `user=${user}`);
                if (user === USERNAME && pass === PASSWORD) {
                    setState('AUTH_SUCCESS', State.AUTHENTICATED);
                    const ack = buildPacket(PacketType.AUTH_ACK, 'SUCCESS');
                    socket.write(ack);
                    logEntry('TX', 'AUTH_ACK', 'SUCCESS');
                } else {
                    const ack = buildPacket(PacketType.AUTH_ACK, 'FAILED');
                    socket.write(ack);
                    logEntry('TX', 'AUTH_ACK', 'FAILED');
                }
                break;
            }

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

                    // Send image in chunks
                    const CHUNK_SIZE = 4096;
                    let offset = 0;
                    let chunkIndex = 0;
                    const totalChunks = Math.ceil(imageData.length / CHUNK_SIZE);

                    function sendNextChunk() {
                        if (offset >= imageData.length) {
                            // Send END marker
                            socket.write(buildPacket(PacketType.IMAGE_DATA, `END:${imageData.length}`));
                            logEntry('TX', 'IMAGE_DATA', `END total=${imageData.length} bytes`);
                            setState('TRANSFER_COMPLETE', State.AUTHENTICATED);
                            return;
                        }
                        const chunk = imageData.slice(offset, offset + CHUNK_SIZE);
                        const header = Buffer.from(`${chunkIndex}:${totalChunks}:`);
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

            case PacketType.GET_STATUS: {
                logEntry('RX', 'GET_STATUS', '');
                const statusPacket = buildPacket(PacketType.STATUS, `STATE:${state}`);
                socket.write(statusPacket);
                logEntry('TX', 'STATUS', `STATE:${state}`);
                break;
            }

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