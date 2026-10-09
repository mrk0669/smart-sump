#!/bin/sh
# Build Mosquitto's (hashed) password file from the login in .env, then start
# the broker. Doing it at start-up means you never commit a password file and
# changing the password is just: edit .env, restart the container.
set -e
: "${MQTT_USERNAME:?set MQTT_USERNAME in .env}"
: "${MQTT_PASSWORD:?set MQTT_PASSWORD in .env}"

mosquitto_passwd -c -b /mosquitto/passwd "$MQTT_USERNAME" "$MQTT_PASSWORD"
chown mosquitto:mosquitto /mosquitto/passwd
chmod 0700 /mosquitto/passwd

exec mosquitto -c /mosquitto/config/mosquitto.conf
