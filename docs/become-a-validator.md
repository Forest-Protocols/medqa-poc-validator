# Become a Validator in this Protocol

If you want to start validating services in this Protocol follow the steps below.

1. [Register in the Network](#1-register-in-the-network),
2. [Register in this Protocol](#2-register-in-this-protocol),
3. [Clone target Protocol's Validator Daemon](#3-clone-target-protocols-validator-daemon),
4. [Run the Validator Daemon](#4-run-the-validator-daemon).

### Step-by-step instructions

#### 0. Prerequisites

Install:
- Node.js (min version 22.12.0): [official](https://nodejs.org/en/download) or via (Optional) Node Version Manager: [link](https://github.com/nvm-sh/nvm)
- ForestAI CLI: [official](https://www.npmjs.com/package/@forest-protocols/cli)
- PostgreSQL (min version 16):
  * If you want to run Postgres natively: [official](https://www.postgresql.org/download/)
  * If you want to run Postgres dockerized: [PG Docker image](https://hub.docker.com/_/postgres)

#### 1. Register in the Network

> You can skip this part if you are already registered in the Network as a Validator.

1. Create a JSON detail file in the following schema and save it somewhere:

```json
{
  "name": "<Name, will be visible to users>",
  "description": "<[Optional] Description>",
  "homepage": "<[Optional] Homepage address>"
}
```

2. Create a set of pub / priv keys using an EVM-compatible wallet.
3. Take that account's private key and save it to a file.
4. Put the JSON file and that private key file into the same folder.
5. Open up a terminal in that folder.
   > If you are planning to use different accounts for billing and operating, you need to pass additional flags: `--billing <address>` and `--operator <address>`. This separation increases security of your configuration. Setting a billing address allows for having a separate address / identity for claiming your earnings and rewards while setting an operator allows you to delegate the operational work of running a daemon and servicing user requests to a third-party or a hotkey. If you don't need that, just skip those flags and the logic of the Protocol will use your main address as your billing and operator address.
6. Run the following command to register in the Protocol to be allowed to interact with Protocol's resources:
   ```sh
    forest register validator \
        --details <JSON file name> \
        --account <private key file>
   ```
   TESTNET NOTE: if you need testnet tokens reach out to the Forest Protocols team on [Discord](https://discord.gg/2MsTWq2tc7).
7. Save your detail file somewhere. Later you'll place this file into `data/details` folder.

#### 2. Register in this Protocol

You can take part in many Protocols. In order to join this one run the following command:

```shell
forest validator register-in \
  --account <private key file path OR private key itself of the Validator account> \
  --protocol <Protocol Smart Contract Address> \
  --collateral <Minimum Collateral>
```

#### 3. Clone target Protocol's Validator Daemon

Now clone the target Protocol's Validator daemon code. To find that, you can contact the Protocol Owner.

#### 4. Run the Validator Daemon

You can run the daemon process with or without a container. First of all, copy `.env.example` as `.env`:

```sh
cp .env.example .env
```

Then read the `.env` file carefully and configure it according to your needs.

##### 4.1 Without a Container

> Ensure you have a running PostgreSQL database before proceeding.

Run the following commands in the daemon directory:

```sh
npm i
npm run build
npm run db:migrate
npm run start
```

##### 4.2 With a Container

If you prefer to use containers, build the container image and run it with Docker Compose. First, update the `DATABASE_URL` host to point to the database container:

```dotenv
...
# Update the host to "db"
# Database credentials are defined in "docker-compose.yaml";
# update the compose file if you change them.
DATABASE_URL=postgresql://postgres:postgres@db:5432/postgres

# If using a local Foundry blockchain, update the RPC_HOST variable.
# RPC_HOST=172.17.0.1:8545
...
```

Now run the compose file:

```shell
docker compose up # Add "-d" to run in detached mode
```

If you have enabled the `GRACEFUL_SHUTDOWN` option, use `docker compose down -t -1` command to close containers. This command prevents Docker to force close the daemon before it gracefully closes opened Agreements.

That's all folks!
