# Distributed Image Transfer System

## Overview
A client-server system that allows authenticated users to request and download large JPEG images from a remote server using TCP/IP communication and structured data packets.

## Features
- TCP socket communication
- Authentication system
- Structured packet protocol
- Server state machine
- Image transfer (>1MB files)
- Packet logging

## Technologies
- JavaScript (Node.js)
- TCP Sockets
- File streaming

## System Architecture
(insert architecture diagram)

## How to Run

1. Install Node.js
2. Start the server

node server/server.js

3. Start the client

node client/client.js
