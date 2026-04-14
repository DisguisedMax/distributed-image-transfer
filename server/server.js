const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = 5000;

const USERNAME = "admin";
const PASSWORD = "password";

const server = net.createServer((socket) => {
    console.log("Client connected");

    let authenticated = false;

    socket.on('data', (data) => {
        const message = data.toString().trim();
        console.log("Received:", message);

        const parts = message.split(" ");

        if (parts[0] === "LOGIN") {
            const user = parts[1];
            const pass = parts[2];

            if (user === USERNAME && pass === PASSWORD) {
                authenticated = true;
                socket.write("LOGIN_SUCCESS\n");
                console.log("User authenticated");
            } else {
                socket.write("LOGIN_FAILED\n");
            }
        }

        else if (parts[0] === "GET_IMAGE") {
            if (!authenticated) {
                socket.write("NOT_AUTHENTICATED\n");
                return;
            }

            const imagePath = path.join(__dirname, "..", "images", "sample.jpg");

            fs.readFile(imagePath, (err, data) => {
                if (err) {
                    socket.write("ERROR\n");
                    return;
                }

                socket.write("IMAGE_START\n");
                socket.write(data);
                socket.write("\nIMAGE_END\n");

                console.log("Image sent to client");
            });
        }
    });

    socket.on('end', () => {
        console.log("Client disconnected");
    });
});

server.listen(PORT, () => {
    console.log("Server listening on port", PORT);
});