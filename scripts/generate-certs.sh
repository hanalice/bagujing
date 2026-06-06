#!/bin/bash
# Generate a self-signed TLS certificate for local development
mkdir -p certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/server.pem -out certs/server.pem \
  -subj "/C=US/ST=State/L=City/O=Development/OU=Local/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo "Self-signed certificate generated at certs/server.pem"
