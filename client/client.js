const net = require('net');
const fs = require('fs');

const client = new net.Socket();

client.connect(5000, '127.0.0.1', () => {
    console.log("Connected to server");

    client.write("LOGIN admin password\n");
});

let imageBuffer = [];
let receivingImage = false;

client.on('data', (data) => {
    const text = data.toString();

    if (text.includes("LOGIN_SUCCESS")) {
        console.log("Login successful");
        client.write("GET_IMAGE\n");
        return;
    }

    if (text.includes("LOGIN_FAILED")) {
        console.log("Login failed");
        return;
    }

    if (text.includes("IMAGE_START")) {
        receivingImage = true;
        imageBuffer = [];
        return;
    }

    if (text.includes("IMAGE_END")) {
        receivingImage = false;

        const image = Buffer.concat(imageBuffer);
        fs.writeFileSync("received.jpg", image);

        console.log("Image received and saved");
        client.end();
        return;
    }

    if (receivingImage) {
        imageBuffer.push(data);
    }
});

client.on('close', () => {
    console.log("Connection closed");
});