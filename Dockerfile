FROM node:22-bookworm

USER node

WORKDIR /daemon

COPY --chown=node:node package*.json .
RUN npm ci

COPY --chown=node:node . .
RUN npm run build

CMD ["bash", "/daemon/start.sh"]