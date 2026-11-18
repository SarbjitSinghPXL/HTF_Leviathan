#!/bin/sh
set -e

# Normal runtime entrypoint: start the API only.
# It never installs packages, drops tables, migrates or seeds the database.
# Database initialisation is an explicit, separate step (docs/deployment.md).
echo "Starting HTF Leviathan API..."
exec bun src/index.ts
