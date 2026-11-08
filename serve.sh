#!/bin/sh
# Serve the simulator on the LAN: http://<this Mac's LAN IP>:8090/
cd "$(dirname "$0")/web" && exec python3 -m http.server 8090 --bind 0.0.0.0
