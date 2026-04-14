const net = require('net');
const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const client = new net.Socket();
let authenticated = false;
let receivingImage = false;
let imageBuffer = [];

client.connect(5000, '127.0.0.1', () => {
    console.log("Connected to server");
    showMenu();
});

function showMenu() {
    console.log("\n--- Menu ---");
    console.log("1. Login");
    console.log("2. Request Image");
    console.log("3. Exit");
    rl.question("Choose: ", (choice) => {
        if (choice === '1') {
            client.write("LOGIN admin password\n");
        } else if (choice === '2') {
            if (!authenticated) {
                console.log("Please login first.");
                showMenu();
            } else {
                client.write("GET_IMAGE\n");
            }
        } else if (choice === '3') {
            client.end();
            rl.close();
        } else {
            console.log("Invalid option.");
            showMenu();
        }
    });
}

client.on('data', (data) => {
    const text = data.toString();

    if (text.includes("LOGIN_SUCCESS")) {
        console.log("Login successful");
        authenticated = true;
        showMenu();
        return;
    }

    if (text.includes("LOGIN_FAILED")) {
        console.log("Login failed");
        showMenu();
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
        showMenu();
        return;
    }

    if (receivingImage) {
        imageBuffer.push(data);
    }
});

client.on('close', () => {
    console.log("Connection closed");
    rl.close();
});