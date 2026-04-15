const net = require('net');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Logging Setup
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = path.join(logDir, `client_log_${timestamp}.txt`);

function logEntry(direction, packetType, payloadSummary) {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const line = `[${now}] [${direction}] [${packetType}] ${payloadSummary}\n`;
    fs.appendFileSync(logFile, line);
}

// Packet Helpers
const PacketType = {
    AUTH:          0x01,
    AUTH_ACK:      0x02,
    REQUEST_IMAGE: 0x03,
    IMAGE_DATA:    0x04,
    GET_STATUS:    0x05,
    STATUS:        0x06,
    DISCONNECT:    0x07,
    ERROR:         0xFF,
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
    const packet = Buffer.alloc(7 + length);
    packet[0] = 0x02;
    packet.writeUInt16BE(length, 1);
    packet[3] = type;
    payloadBuf.copy(packet, 4);
    const crc = crc16(packet.slice(1, 4 + length));
    packet.writeUInt16BE(crc, 4 + length);
    packet[6 + length] = 0x03;
    return packet;
}

// Packet Parser (handles partial/multiple packets in buffer)
let receiveBuffer = Buffer.alloc(0);

function tryParsePacket() {
    if (receiveBuffer.length < 7) return null;
    if (receiveBuffer[0] !== 0x02) {
        // Resync
        const idx = receiveBuffer.indexOf(0x02, 1);
        receiveBuffer = idx >= 0 ? receiveBuffer.slice(idx) : Buffer.alloc(0);
        return null;
    }
    const length = receiveBuffer.readUInt16BE(1);
    const totalSize = 7 + length;
    if (receiveBuffer.length < totalSize) return null;

    const packetBuf = receiveBuffer.slice(0, totalSize);
    receiveBuffer = receiveBuffer.slice(totalSize);

    const type = packetBuf[3];
    const payload = packetBuf.slice(4, 4 + length);
    const receivedCRC = packetBuf.readUInt16BE(4 + length);
    const computedCRC = crc16(packetBuf.slice(1, 4 + length));

    if (receivedCRC !== computedCRC) {
        logEntry('RX', 'CRC_FAIL', `Expected 0x${computedCRC.toString(16)} got 0x${receivedCRC.toString(16)}`);
        console.log('⚠ CRC validation failed on received packet');
        return null;
    }
    return { type, payload };
}

// State
let authenticated = false;
let receivingImage = false;
let imageChunks = [];
let totalChunks = 0;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const client = new net.Socket();

// Menu
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
client.connect(5000, '127.0.0.1', () => {
    console.log('\n✔ Connected to server');
    logEntry('SYS', 'CONNECTION', 'Connected to server at 127.0.0.1:5000');
    showMenu();
});

// Data Handler 
client.on('data', (data) => {
    receiveBuffer = Buffer.concat([receiveBuffer, data]);

    let packet;
    while ((packet = tryParsePacket()) !== null) {
        handlePacket(packet);
    }
});

function handlePacket(packet) {
    switch (packet.type) {

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

        case PacketType.IMAGE_DATA: {
            const payloadStr = packet.payload.toString('utf8', 0, Math.min(50, packet.payload.length));

            if (payloadStr.startsWith('END:')) {
                // Transfer complete
                const totalBytes = parseInt(payloadStr.split(':')[1]);
                const imageBuffer = Buffer.concat(imageChunks);
                const savePath = path.join(__dirname, 'received.jpg');
                fs.writeFileSync(savePath, imageBuffer);
                logEntry('RX', 'IMAGE_DATA', `END total=${totalBytes} bytes`);
                console.log(`\n✔ Image received and saved to: ${savePath}`);
                console.log(`  Total size: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
                receivingImage = false;
                imageChunks = [];
                showMenu();
            } else {
                // Chunk: "chunkIndex:totalChunks:<binarydata>"
                const colonOne = packet.payload.indexOf(':');
                const colonTwo = packet.payload.indexOf(':', colonOne + 1);
                const chunkIndex = parseInt(packet.payload.slice(0, colonOne).toString());
                totalChunks = parseInt(packet.payload.slice(colonOne + 1, colonTwo).toString());
                const chunkData = packet.payload.slice(colonTwo + 1);

                imageChunks.push(chunkData);
                receivingImage = true;

                // Progress bar
                const pct = Math.round(((chunkIndex + 1) / totalChunks) * 100);
                const filled = Math.round(pct / 5);
                const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
                process.stdout.write(`\r  Downloading: [${bar}] ${pct}% (${chunkIndex + 1}/${totalChunks})`);
                logEntry('RX', 'IMAGE_DATA', `chunk ${chunkIndex + 1}/${totalChunks}`);
            }
            break;
        }

        case PacketType.STATUS: {
            const status = packet.payload.toString();
            logEntry('RX', 'STATUS', status);
            console.log(`\n📊 Server Status: ${status}`);
            showMenu();
            break;
        }

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