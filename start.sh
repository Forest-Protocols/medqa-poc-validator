#!/bin/bash
# Init script for Docker container

# Run migrations
npm run db:migrate

if [ $? -ne 0 ]; then
    exit 1
fi

# Run daemon
exec node dist/index.js
