#!/bin/bash
# Init script for Docker container

# Run migrations
npm run db:migrate

# Exit if the migration is failed
if [ $? -ne 0 ]; then
    exit 1
fi

# Run daemon
exec node dist/index.js
