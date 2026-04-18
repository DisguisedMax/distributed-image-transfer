'use strict';

const net = require('net');
const fs = require('fs');
const { PacketType, buildPacket } = require('../protocol/packet');

const PORT = 5000;
const HOST = '127.0.0.1';

let passed = 0;
let failed = 0;

function pass(name){
    console.log("PASS:", name);
    passed++;
}

function fail(name){
    console.log("FAIL:", name);
    failed++;
}

// ---------------- AUTH TESTS ----------------

function testValidLogin(done){
    const client = new net.Socket();

    client.connect(PORT, HOST, () => {
        client.write(buildPacket(PacketType.AUTH, "admin:password"));
    });

    client.on('data', (data) => {
        if(data.includes(Buffer.from("SUCCESS")))
            pass("Valid Login");
        else
            fail("Valid Login");

        client.destroy();
        done();
    });
}

function testInvalidPassword(done){
    const client = new net.Socket();

    client.connect(PORT, HOST, () => {
        client.write(buildPacket(PacketType.AUTH, "admin:wrong"));
    });

    client.on('data', (data) => {
        if(data.includes(Buffer.from("FAILED")))
            pass("Invalid Password");
        else
            fail("Invalid Password");

        client.destroy();
        done();
    });
}

function testInvalidUsername(done){
    const client = new net.Socket();

    client.connect(PORT, HOST, () => {
        client.write(buildPacket(PacketType.AUTH, "bad:password"));
    });

    client.on('data', (data) => {
        if(data.includes(Buffer.from("FAILED")))
            pass("Invalid Username");
        else
            fail("Invalid Username");

        client.destroy();
        done();
    });
}

// ---------------- IMAGE TESTS ----------------

function testImageTransfer(done){
    const client = new net.Socket();
    let loggedIn = false;

    client.connect(PORT, HOST, () => {
        client.write(buildPacket(PacketType.AUTH, "admin:password"));
    });

    client.on('data', (data) => {

        if(data.includes(Buffer.from("SUCCESS")) && !loggedIn){
            loggedIn = true;
            client.write(buildPacket(PacketType.REQUEST_IMAGE, ""));
            return;
        }

        if(loggedIn){
            pass("Image Transfer");
            client.destroy();
            done();
        }
    });
}

function testImageFileCreated(done){
    const exists = fs.existsSync("client/received.jpg") || fs.existsSync("received.jpg");

    if(exists)
        pass("Image File Created");
    else
        fail("Image File Created");

    done();
}

// ---------------- STATUS TESTS ----------------

function testStatus(done){
    const client = new net.Socket();
    let loggedIn = false;

    client.connect(PORT, HOST, () => {
        client.write(buildPacket(PacketType.AUTH, "admin:password"));
    });

    client.on('data', (data) => {

        if(data.includes(Buffer.from("SUCCESS")) && !loggedIn){
            loggedIn = true;
            client.write(buildPacket(PacketType.GET_STATUS, ""));
            return;
        }

        if(data.includes(Buffer.from("STATE")))
        {
            pass("Get Status");
            client.destroy();
            done();
        }
    });
}

// ---------------- DISCONNECT TEST ----------------

function testDisconnect(done){
    const client = new net.Socket();

    client.connect(PORT, HOST, () => {
        client.write(buildPacket(PacketType.DISCONNECT, ""));
        pass("Disconnect");
        client.destroy();
        done();
    });
}

// ---------------- RUN ALL ----------------

function run(){
    testValidLogin(()=>{
    testInvalidPassword(()=>{
    testInvalidUsername(()=>{
    testImageTransfer(()=>{
    testImageFileCreated(()=>{
    testStatus(()=>{
    testDisconnect(()=>{

        console.log("\nRESULTS");
        console.log("Passed:", passed);
        console.log("Failed:", failed);

    });
    });
    });
    });
    });
    });
    });
}

run();