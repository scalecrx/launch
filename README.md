# `@scalecrx/launch`

Official ScaleCRX CLI for launching Solana tokens and creating ScaleCRX AMM or VMM pools from the terminal.

## Quick start

Run the CLI directly with `npx`:

```bash
npx @scalecrx/launch --name "Scale Token" --symbol SCALE
```

Useful utility flows:

```bash
npx @scalecrx/launch --get-wallet
npx @scalecrx/launch --export-wallet
```

## What it does

The CLI:

- creates or reuses a managed wallet
- checks funding before sending transactions
- creates the token mint
- mints the initial supply
- revokes mint authority
- revokes freeze authority when present
- creates an AMM pool or VMM pair on ScaleCRX
- optionally performs a dev buy during pool creation

## Requirements

- Node.js `18+`
- access to a Solana RPC endpoint for your target network
- enough SOL in the managed wallet to cover rent, fees, and any native-SOL dev buy

## Usage

```bash
npx @scalecrx/launch --name <tokenName> --symbol <tokenSymbol> [options]
```

Wallet utilities:

```bash
npx @scalecrx/launch --get-wallet [--network <devnet|mainnet>]
npx @scalecrx/launch --export-wallet
```

## Options

### Required for a launch

- `--name <string>`: token name, max `24` chars
- `--symbol <string>`: token symbol, max `6` chars

### Launch options

- `--tokenA <mint>`: optional base token mint override
- `--supply <number|1B>`: total token supply, default `1000000000`
- `--decimals <number>`: token decimals, default `6`
- `--devbuy <amount>`: base-token buy amount, default `0`
- `--feeshares <csv>`: comma-separated `wallet,bps` pairs
- `--shift <amount>`: shift in tokenA units, default `1`
- `--curve <constant|exponential>`: default `constant`
- `--pool <amm|vmm>`: default `amm`
- `--network <devnet|mainnet>`: default `mainnet`
- `--prompted`: require manual confirmation at key launch checkpoints

### Wallet utilities

- `--get-wallet`: print the managed wallet address and balance
- `--export-wallet`: export the managed wallet private key after explicit confirmation

### General

- `--help`: print usage
- `--version`: print CLI version

## Examples

Launch with defaults:

```bash
npx @scalecrx/launch --name "Scale Token" --symbol SCALE
```

Launch a `1B` supply token on an AMM:

```bash
npx @scalecrx/launch \
  --name "Scale Token" \
  --symbol SCALE \
  --supply 1B \
  --pool amm
```

Launch on devnet with a dev buy:

```bash
npx @scalecrx/launch \
  --name "Scale Dev" \
  --symbol SDEV \
  --network devnet \
  --devbuy 0.25
```

Use a custom base token:

```bash
npx @scalecrx/launch \
  --name "Quoted Token" \
  --symbol QUOTED \
  --tokenA So11111111111111111111111111111111111111112
```

Split fees across wallets:

```bash
npx @scalecrx/launch \
  --name "Shared Fees" \
  --symbol FEES \
  --feeshares wallet1,2500,wallet2,1500
```

Inspect the managed wallet:

```bash
npx @scalecrx/launch --get-wallet --network mainnet
```

## Parameter details

### `--supply`

- accepts integer token amounts
- accepts the `B` suffix for billions, for example `1B`
- is converted to raw mint units using `10^decimals`

### `--devbuy`

- interpreted in tokenA units
- if tokenA is native SOL, the wallet must hold enough extra SOL for the buy

### `--feeshares`

- format: `wallet1,bps1,wallet2,bps2,...`
- maximum `5` wallet/bps pairs
- total basis points must be `<= 10000`

### `--shift`

- interpreted in tokenA units
- must be greater than `0`
- converted to raw base-token units before pool creation

### `--tokenA`

- optional in normal operation
- required when the platform base token is configured to the dead address sentinel:
  `1nc1nerator11111111111111111111111111111111`

## RPC configuration

The CLI resolves RPC endpoints in this order:

1. environment variables in the current shell
2. `launch/.env.local`
3. `launch/.env`
4. Scale SDK defaults

Supported variables:

- `SCALECRX_RPC_DEVNET`
- `SCALECRX_RPC_MAINNET`
- `SCALECRX_RPC_URL`

Example:

```bash
SCALECRX_RPC_MAINNET="https://mainnet.helius-rpc.com/?api-key=..." \
  npx @scalecrx/launch --name "Scale Token" --symbol SCALE
```

Or in `launch/.env.local`:

```bash
SCALECRX_RPC_DEVNET="https://devnet.helius-rpc.com/?api-key=..."
SCALECRX_RPC_MAINNET="https://mainnet.helius-rpc.com/?api-key=..."
```

## Managed wallet

The CLI uses a single managed wallet per machine:

- macOS/Linux: `~/.config/scalecrx/wallet.json`
- Windows: `%APPDATA%/scalecrx/wallet.json`

On first run it creates the wallet automatically and prints the public address.

When the wallet is underfunded, the CLI:

- prints the deposit address
- tries to render a terminal QR code
- waits for funding for up to 5 minutes

## Output and progress

During a successful launch you should see messages like:

- `Checking wallet funds... sufficient ✅`
- `Launching SPL20 token... done: <solscan tx url>`
- `Revoking mint authority... done ✅`
- `Creating pool... done: <solscan tx url>`
- `Launch successful.`

## Local development

```bash
cd launch
npm install
node bin/launch.js --help
node bin/launch.js --version
npm run pack:check
```

## Safety notes

- `--export-wallet` prints the raw private key in base58; only use it when necessary
- keep `.env.local` out of version control
- use `--prompted` if you want manual checkpoints before launch and pool creation
- double-check `--tokenA`, `--network`, `--pool`, and `--feeshares` before submitting transactions

## AI Skill

Use this prompt when wiring the CLI into an LLM tool or local agent skill:

```text
You have access to the ScaleCRX Launch CLI via `npx @scalecrx/launch`.

Use it to launch Solana tokens and create ScaleCRX AMM/VMM pools directly from the terminal.

Supported actions:
- launch a token with `--name`, `--symbol`, and optional launch flags
- inspect the managed wallet with `--get-wallet`
- export the managed wallet with `--export-wallet` only when the user explicitly requests it

Important rules:
- default to `--pool amm` and `--network mainnet` unless the user says otherwise
- preserve exact user-provided values for `--name`, `--symbol`, `--supply`, `--decimals`, `--devbuy`, `--feeshares`, `--shift`, `--tokenA`, `--curve`, `--pool`, and `--network`
- if required launch fields are missing, ask for them before running the command
- warn before any command that could reveal the private key
- relay the CLI output back to the user with the mint address, pool or pair address, wallet address, and transaction URLs

Example launch command:
`npx @scalecrx/launch --name "Scale Token" --symbol SCALE`
```
