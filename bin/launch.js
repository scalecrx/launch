#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const DEFAULTS = {
  decimals: 6,
  supply: '1000000000',
  devbuy: '0',
  feeshares: '',
  shift: '1',
  curve: 'constant',
  pool: 'amm',
  network: 'mainnet',
};
const PACKAGE_JSON_PATH = path.resolve(__dirname, '..', 'package.json');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).version;

let BNClass = null;
let ScaleClass = null;
let bs58Encode = null;
let web3 = null;
let splToken = null;
const loggedCustomRpcHosts = new Set();
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOCAL_ENV_PATHS = [
  path.join(PROJECT_ROOT, '.env.local'),
  path.join(PROJECT_ROOT, '.env'),
];

function requireBs58Encode() {
  if (bs58Encode) return bs58Encode;

  const bs58Mod = require('bs58');
  bs58Encode = (bs58Mod && bs58Mod.encode)
    ? bs58Mod.encode.bind(bs58Mod)
    : bs58Mod.default.encode.bind(bs58Mod.default);
  return bs58Encode;
}

function requireWeb3() {
  if (!web3) {
    const {
      Keypair,
      PublicKey,
      Transaction,
      sendAndConfirmTransaction,
      LAMPORTS_PER_SOL,
    } = require('@solana/web3.js');

    web3 = {
      Keypair,
      PublicKey,
      Transaction,
      sendAndConfirmTransaction,
      LAMPORTS_PER_SOL,
      DEAD_ADDRESS: new PublicKey('1nc1nerator11111111111111111111111111111111'),
    };
  }

  return web3;
}

function requireSplToken() {
  if (!splToken) {
    splToken = require('@solana/spl-token');
  }
  return splToken;
}

class NodeWallet {
  constructor(keypair) {
    this.payer = keypair;
    this.publicKey = keypair.publicKey;
  }

  async signTransaction(tx) {
    tx.partialSign(this.payer);
    return tx;
  }

  async signAllTransactions(txs) {
    return txs.map((tx) => {
      tx.partialSign(this.payer);
      return tx;
    });
  }
}

function usage() {
  console.log(`
ScaleCRX Launch CLI v${PACKAGE_VERSION}

Usage
  npx @scalecrx/launch --name <tokenName> --symbol <tokenSymbol> [options]
  npx @scalecrx/launch --export-wallet
  npx @scalecrx/launch --get-wallet [--network <devnet|mainnet>]

Required for launch
  --name <string>             Token name (max 24 chars)
  --symbol <string>           Token symbol (max 6 chars)

Launch options
  --tokenA <mint>             Base token mint to pair against (required when platform base token is dead address)
  --supply <number|1B>        Total token supply (default: 1000000000)
  --decimals <number>         Token decimals (default: 6)
  --devbuy <amount>           Base-token buy amount (default: 0)
  --feeshares <csv>           wallet,bps pairs (max 5 pairs, total <= 10000)
  --shift <amount>            Shift in tokenA units (default: 1)
  --curve <constant|exponential>
  --pool <amm|vmm>
  --network <devnet|mainnet>
  --prompted                  Prompt for confirmation at debug checkpoints

Wallet utilities
  --export-wallet             Export managed wallet private key
  --get-wallet                Print managed wallet address and balance

General
  --version                   Show CLI version
  --help                      Show this message

Examples
  npx @scalecrx/launch --name "Scale Token" --symbol SCALE
  npx @scalecrx/launch --name "Scale Token" --symbol SCALE --supply 1B --pool amm
  npx @scalecrx/launch --get-wallet --network devnet
`);
}

function parseArgs(argv) {
  const out = {};
  const booleanFlags = new Set(['help', 'export-wallet', 'get-wallet', 'prompted', 'version']);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') {
      out.help = true;
      continue;
    }

    if (arg === '-v') {
      out.version = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const eq = arg.indexOf('=');
    if (eq !== -1) {
      const key = arg.slice(2, eq);
      const value = arg.slice(eq + 1);
      if (booleanFlags.has(key)) {
        out[key] = value !== 'false';
      } else {
        out[key] = value;
      }
      continue;
    }

    const key = arg.slice(2);
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function normalizeSupplyString(value) {
  const v = String(value).trim();
  if (/^\d+[bB]$/.test(v)) {
    return `${v.slice(0, -1)}000000000`;
  }
  return v;
}

function pow10(decimals) {
  let x = 1n;
  for (let i = 0; i < decimals; i += 1) x *= 10n;
  return x;
}

function parseUiAmountToRaw(input, decimals, label) {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`${label} must be a numeric value`);
  }

  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new Error(`${label} has too many decimal places (max ${decimals})`);
  }

  const factor = pow10(decimals);
  const wholeRaw = BigInt(whole) * factor;
  const fracRaw = BigInt((frac + '0'.repeat(decimals)).slice(0, decimals));
  return wholeRaw + fracRaw;
}

function parseSupplyToRaw(input, decimals) {
  const normalized = normalizeSupplyString(input);
  if (!/^\d+$/.test(normalized)) {
    throw new Error('supply must be an integer token amount (or suffix B, e.g. 1B)');
  }
  const tokens = BigInt(normalized);
  return tokens * pow10(decimals);
}

function toBN(rawBigInt) {
  if (!BNClass) {
    BNClass = require('@coral-xyz/anchor').BN;
  }
  return new BNClass(rawBigInt.toString());
}

function getWalletFilePath() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'scalecrx', 'wallet.json');
  }
  return path.join(home, '.config', 'scalecrx', 'wallet.json');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function saveWallet(keypair, filePath) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
}

function loadWallet(filePath) {
  const { Keypair } = requireWeb3();
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error(`Invalid wallet file format at ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function getOrCreateManagedWallet() {
  const { Keypair } = requireWeb3();
  const walletPath = getWalletFilePath();
  let keypair = loadWallet(walletPath);
  if (!keypair) {
    keypair = Keypair.generate();
    saveWallet(keypair, walletPath);
    console.log(`scalecrx/* wallet not found, generating a new one.. done: ${keypair.publicKey.toBase58()}`);
  }
  return keypair;
}

function normalizeNetwork(networkArg) {
  const network = String(networkArg ?? DEFAULTS.network).toLowerCase();
  if (!['devnet', 'mainnet'].includes(network)) {
    throw new Error('network must be one of: devnet, mainnet');
  }
  return network;
}

function parseDotEnvValue(rawValue) {
  if (rawValue == null) return '';
  const trimmed = String(rawValue).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readDotEnvKey(filePath, envKey) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (key !== envKey) continue;
    return parseDotEnvValue(normalized.slice(eq + 1));
  }
  return null;
}

function readLocalEnvKey(envKey) {
  for (const filePath of LOCAL_ENV_PATHS) {
    const value = readDotEnvKey(filePath, envKey);
    if (value) return value;
  }
  return null;
}

function resolveRpcEndpoint(network) {
  const net = normalizeNetwork(network);
  const networkOverride = process.env[`SCALECRX_RPC_${net.toUpperCase()}`];
  if (networkOverride && networkOverride.trim()) {
    return networkOverride.trim();
  }

  const globalOverride = process.env.SCALECRX_RPC_URL;
  if (globalOverride && globalOverride.trim()) {
    return globalOverride.trim();
  }

  return (
    readLocalEnvKey(`SCALECRX_RPC_${net.toUpperCase()}`)
    || readLocalEnvKey('SCALECRX_RPC_URL')
  );
}

function formatRpcEndpointHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtSol(lamports) {
  const { LAMPORTS_PER_SOL } = requireWeb3();
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return String(answer || '').trim();
}

async function confirmEnterOrAbort(question) {
  const answer = await prompt(question);
  if (answer !== '') {
    throw new Error('Aborted by user.');
  }
}

function parseFeeShares(input) {
  const { PublicKey } = requireWeb3();
  if (!input || !String(input).trim()) return [];

  const parts = String(input)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  if (parts.length % 2 !== 0) {
    throw new Error('feeshares must be an even-length comma-separated list: wallet,bps,wallet,bps,...');
  }

  const pairCount = parts.length / 2;
  if (pairCount > 5) {
    throw new Error('feeshares supports up to 5 wallet,bps pairs');
  }

  const out = [];
  let total = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const walletStr = parts[i];
    const bpsStr = parts[i + 1];
    let wallet;
    try {
      wallet = new PublicKey(walletStr);
    } catch {
      throw new Error(`Invalid feeshares wallet: ${walletStr}`);
    }

    if (!/^\d+$/.test(bpsStr)) {
      throw new Error(`Invalid feeshares bps for wallet ${walletStr}: ${bpsStr}`);
    }

    const shareBps = Number(bpsStr);
    if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10000) {
      throw new Error(`Invalid feeshares bps for wallet ${walletStr}: must be 0..10000`);
    }

    total += shareBps;
    out.push({ wallet, shareBps });
  }

  if (total > 10000) {
    throw new Error(`feeshares total bps cannot exceed 10000 (got ${total})`);
  }

  return out;
}

function curveArgToSdk(curve) {
  if (curve === 'constant') return { constantProduct: {} };
  if (curve === 'exponential') return { exponential: {} };
  throw new Error('curve must be one of: constant, exponential');
}

async function getTokenMintDecimals(connection, mint) {
  const {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    getMint,
  } = requireSplToken();
  const mintInfo = await connection.getAccountInfo(mint, 'confirmed');
  if (!mintInfo) {
    throw new Error(`Base token mint not found: ${mint.toBase58()}`);
  }

  let tokenProgramId = TOKEN_PROGRAM_ID;
  if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    tokenProgramId = TOKEN_2022_PROGRAM_ID;
  } else if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`Unsupported token program for base token mint: ${mint.toBase58()}`);
  }

  return (await getMint(connection, mint, 'confirmed', tokenProgramId)).decimals;
}

async function maybePrintQr(walletAddress) {
  try {
    const qrcodePkg = require.resolve('qrcode/package.json');
    const qrcodeBin = path.join(path.dirname(qrcodePkg), 'bin', 'qrcode');
    execSync(`${qrcodeBin} ${walletAddress} --small`, {
      stdio: 'inherit',
      shell: '/bin/zsh',
    });
  } catch {
    console.log('Could not render QR code automatically.');
  }
}

async function waitForFunds(connection, pubkey, requiredLamports, networkLabel) {
  console.log(`Deposit required: at least ${fmtSol(requiredLamports)} SOL on ${networkLabel}.`);
  console.log(`Wallet: ${pubkey.toBase58()}`);
  await maybePrintQr(pubkey.toBase58());
  console.log(`Wallet: ${pubkey.toBase58()}`);
  console.log('Waiting for deposit... (up to 5 minutes, checking every 5s)');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const balance = await connection.getBalance(pubkey, 'confirmed');
    if (balance >= requiredLamports) {
      console.log(`Funds detected: ${fmtSol(balance)} SOL`);
      return;
    }
    await sleep(5000);
  }

  throw new Error('Timed out waiting for deposit after 5 minutes. Please fund the wallet and retry.');
}

function makeScale(network, keypair) {
  if (!ScaleClass) {
    ScaleClass = require('@scalecrx/sdk').Scale;
  }
  const wallet = new NodeWallet(keypair);
  const resolvedNetwork = normalizeNetwork(network);
  const rpcEndpoint = resolveRpcEndpoint(resolvedNetwork);
  if (!rpcEndpoint) {
    return new ScaleClass(resolvedNetwork, wallet);
  }

  const host = formatRpcEndpointHost(rpcEndpoint);
  const logKey = `${resolvedNetwork}:${host}`;
  if (!loggedCustomRpcHosts.has(logKey)) {
    loggedCustomRpcHosts.add(logKey);
    console.log(`Using custom ${resolvedNetwork} RPC endpoint (${host}).`);
  }

  return new ScaleClass(rpcEndpoint, wallet);
}

function solscanTxUrl(signature, network) {
  const base = `https://solscan.io/tx/${signature}`;
  return network === 'devnet' ? `${base}?cluster=devnet` : base;
}

async function estimateFeeLamports(connection, tx, feePayer) {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;

  const fee = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
  return fee.value || 0;
}

async function simulateOrThrow(connection, tx, signers) {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  const sim = await connection.simulateTransaction(tx, signers);
  if (sim.value.err) {
    console.error('Preflight simulation failed.');
    console.error(`Error: ${JSON.stringify(sim.value.err)}`);
    if (sim.value.logs && sim.value.logs.length) {
      console.error('Simulation logs:');
      sim.value.logs.forEach((line) => console.error(line));
    }
    if (typeof sim.value.unitsConsumed === 'number') {
      console.error(`Units consumed: ${sim.value.unitsConsumed}`);
    }
    if (tx.instructions && tx.instructions.length) {
      console.error('Instruction program IDs:');
      tx.instructions.forEach((ix, idx) => {
        console.error(`  [${idx}] ${ix.programId.toBase58()}`);
      });
    }
    throw new Error(`Preflight simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
}

async function runExportWalletFlow() {
  const encode = requireBs58Encode();
  const keypair = getOrCreateManagedWallet();
  const confirmation = await prompt(
    'Are you sure you want to export the wallet private key? This is dangerous. Type "EXPORT" to continue: '
  );

  if (confirmation !== 'EXPORT') {
    console.log('Export cancelled.');
    return;
  }

  const privateKeyBase58 = encode(Buffer.from(keypair.secretKey));
  console.log('\nManaged wallet private key (base58):');
  console.log(privateKeyBase58);
}

async function runGetWalletFlow(parsed) {
  const { Keypair } = requireWeb3();
  const network = normalizeNetwork(parsed.network);
  const keypair = getOrCreateManagedWallet();
  const tempScale = makeScale(network, Keypair.generate());
  const balanceLamports = await tempScale.connection.getBalance(keypair.publicKey, 'confirmed');

  console.log(`Network: ${network}`);
  console.log(`Managed wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Balance: ${fmtSol(balanceLamports)} SOL`);
}

async function runLaunchFlow(parsed) {
  const { Keypair, PublicKey } = requireWeb3();
  const {
    NATIVE_MINT,
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
    createMint,
    getMint,
    getOrCreateAssociatedTokenAccount,
    mintTo,
    setAuthority,
    AuthorityType,
  } = requireSplToken();
  const { DEAD_ADDRESS, Transaction, sendAndConfirmTransaction } = requireWeb3();
  const args = {
    name: parsed.name,
    symbol: parsed.symbol,
    decimals: parsed.decimals ?? DEFAULTS.decimals,
    supply: parsed.supply ?? DEFAULTS.supply,
    devbuy: parsed.devbuy ?? DEFAULTS.devbuy,
    feeshares: parsed.feeshares ?? DEFAULTS.feeshares,
    shift: parsed.shift ?? DEFAULTS.shift,
    tokenA: parsed.tokenA ? String(parsed.tokenA).trim() : '',
    curve: (parsed.curve ?? DEFAULTS.curve).toLowerCase(),
    pool: (parsed.pool ?? DEFAULTS.pool).toLowerCase(),
    network: normalizeNetwork(parsed.network),
    prompted: Boolean(parsed.prompted),
  };

  if (!args.name) throw new Error('name is required');
  if (!args.symbol) throw new Error('symbol is required');
  if (args.name.length > 24) throw new Error('name max length is 24 characters');
  if (args.symbol.length > 6) throw new Error('symbol max length is 6 characters');

  const decimals = Number(args.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('decimals must be an integer between 0 and 18');
  }

  if (!['amm', 'vmm'].includes(args.pool)) {
    throw new Error('pool must be one of: amm, vmm');
  }

  const feeBeneficiaries = parseFeeShares(args.feeshares);

  const keypair = getOrCreateManagedWallet();
  const tempScale = makeScale(args.network, Keypair.generate());
  const connection = tempScale.connection;

  const mintRentLamportsRough = 1500000;
  const ataRentLamportsRough = 2500000;
  const txFeesRough = 500000;
  const roughRequiredLamports = mintRentLamportsRough + ataRentLamportsRough + txFeesRough;

  console.log('Checking wallet funds...');
  const roughBalance = await connection.getBalance(keypair.publicKey, 'confirmed');
  if (roughBalance >= roughRequiredLamports) {
    console.log('Checking wallet funds... sufficient ✅');
  } else {
    console.log('Checking wallet funds... insufficient, entering deposit flow.');
    await waitForFunds(connection, keypair.publicKey, roughRequiredLamports, args.network);
  }

  const sdk = makeScale(args.network, keypair);

  console.log('Fetching platform base token...');
  const platformBaseToken = args.pool === 'amm'
    ? await sdk.amm.getPlatformBaseToken()
    : await sdk.vmm.getPlatformBaseToken();

  if (!platformBaseToken) {
    throw new Error(`Could not fetch base token from ${args.pool.toUpperCase()} platform config.`);
  }

  let baseToken = platformBaseToken;
  if (platformBaseToken.equals(DEAD_ADDRESS)) {
    if (!args.tokenA) {
      throw new Error(
        `tokenA is required when platform base token is ${DEAD_ADDRESS.toBase58()} (dead address)`
      );
    }
    try {
      baseToken = new PublicKey(args.tokenA);
    } catch {
      throw new Error(`Invalid tokenA mint: ${args.tokenA}`);
    }
  } else if (args.tokenA) {
    let requestedTokenA;
    try {
      requestedTokenA = new PublicKey(args.tokenA);
    } catch {
      throw new Error(`Invalid tokenA mint: ${args.tokenA}`);
    }
    if (!requestedTokenA.equals(platformBaseToken)) {
      throw new Error(
        `tokenA must match platform base token ${platformBaseToken.toBase58()} while restriction is active`
      );
    }
  }

  console.log(`Using base token (tokenA): ${baseToken.toBase58()}`);

  const baseTokenIsNative = baseToken.equals(NATIVE_MINT);
  const baseTokenDecimals = baseTokenIsNative
    ? 9
    : await getTokenMintDecimals(connection, baseToken);

  const devbuyRaw = parseUiAmountToRaw(args.devbuy, baseTokenDecimals, 'devbuy');
  const shiftRaw = parseUiAmountToRaw(args.shift, baseTokenDecimals, 'shift');
  if (shiftRaw <= 0n) {
    throw new Error('shift must be greater than 0');
  }

  const curve = curveArgToSdk(args.curve);
  const initialTokenBReserves = parseSupplyToRaw(args.supply, decimals);

  const mintRentLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE, 'confirmed');
  const feeBufferLamports = 300000;
  const launchBufferLamports = 1000000;
  const devbuyLamports = baseTokenIsNative ? devbuyRaw : 0n;
  const requiredLamportsBeforeLaunch = BigInt(mintRentLamports + feeBufferLamports + launchBufferLamports) + devbuyLamports;

  const currentBalance = await connection.getBalance(keypair.publicKey, 'confirmed');
  if (BigInt(currentBalance) < requiredLamportsBeforeLaunch) {
    await waitForFunds(connection, keypair.publicKey, Number(requiredLamportsBeforeLaunch), args.network);
  }

  console.log('Preparing token mint...');
  const mintB = await createMint(
    connection,
    keypair,
    keypair.publicKey,
    null,
    decimals,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  const tokenWalletB = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    mintB,
    keypair.publicKey,
    undefined,
    'confirmed',
    undefined,
    TOKEN_PROGRAM_ID
  );

  if (args.prompted) {
    await confirmEnterOrAbort(
      `Ready to launch Token ${mintB.toBase58()} with ${normalizeSupplyString(args.supply)} and revoke authorities, press ENTER to continue, any other key to abort: `
    );
  }

  let launchTokenSig = null;
  if (initialTokenBReserves > 0n) {
    launchTokenSig = await mintTo(
      connection,
      keypair,
      mintB,
      tokenWalletB.address,
      keypair,
      initialTokenBReserves,
      [],
      'confirmed',
      TOKEN_PROGRAM_ID
    );
    console.log(`Launching SPL20 token... done: ${solscanTxUrl(launchTokenSig, args.network)}`);
  } else {
    console.log('Launching SPL20 token... done: no initial supply minted');
  }

  console.log('Revoking mint authority...');
  await setAuthority(
    connection,
    keypair,
    mintB,
    keypair.publicKey,
    AuthorityType.MintTokens,
    null,
    [],
    'confirmed',
    TOKEN_PROGRAM_ID
  );
  console.log('Revoking mint authority... done ✅');

  const mintInfoPost = await getMint(connection, mintB, 'confirmed', TOKEN_PROGRAM_ID);
  if (mintInfoPost.freezeAuthority) {
    console.log('Revoking freeze authority...');
    await setAuthority(
      connection,
      keypair,
      mintB,
      keypair.publicKey,
      AuthorityType.FreezeAccount,
      null,
      [],
      'confirmed',
      TOKEN_PROGRAM_ID
    );
    console.log('Revoking freeze authority... done ✅');
  } else {
    console.log('Freeze authority already disabled ✅');
  }

  const createParams = {
    shift: toBN(shiftRaw),
    initialTokenBReserves: toBN(initialTokenBReserves),
    curve,
    feeBeneficiaries,
  };

  if (args.prompted) {
    await confirmEnterOrAbort(
      `Ready to start pool against ${baseToken.toBase58()} with shift ${args.shift} and ${args.devbuy} of base token dev buy, press ENTER to continue, any other key to abort: `
    );
  }

  let bundle;
  let launchedAddress;

  if (args.pool === 'amm') {
    if (devbuyRaw > 0n) {
      bundle = await sdk.amm.createWithDevBuyInstructions(
        createParams,
        baseToken,
        mintB,
        { amount: toBN(devbuyRaw), limit: 1 },
        {
          payer: keypair.publicKey,
          owner: keypair.publicKey,
          tokenWalletB: tokenWalletB.address,
          tokenWalletAuthority: keypair.publicKey,
        }
      );
    } else {
      bundle = await sdk.amm.createPoolInstructions(
        createParams,
        baseToken,
        mintB,
        {
          payer: keypair.publicKey,
          owner: keypair.publicKey,
          tokenWalletB: tokenWalletB.address,
          tokenWalletAuthority: keypair.publicKey,
        }
      );
    }
    launchedAddress = bundle.pool;
  } else {
    if (devbuyRaw > 0n) {
      bundle = await sdk.vmm.createWithDevBuyInstructions(
        createParams,
        baseToken,
        mintB,
        { amount: toBN(devbuyRaw), limit: 1 },
        {
          payer: keypair.publicKey,
          tokenWalletB: tokenWalletB.address,
          tokenWalletAuthority: keypair.publicKey,
        }
      );
    } else {
      bundle = await sdk.vmm.createPairInstructions(
        createParams,
        baseToken,
        mintB,
        {
          payer: keypair.publicKey,
          tokenWalletB: tokenWalletB.address,
          tokenWalletAuthority: keypair.publicKey,
        }
      );
    }
    launchedAddress = bundle.pair;
  }

  const tx = new Transaction();
  for (const ix of bundle.instructions) tx.add(ix);

  console.log('Running preflight checks...');
  const feeLamports = await estimateFeeLamports(connection, tx, keypair.publicKey);
  await simulateOrThrow(connection, tx, [keypair, ...(bundle.signers || [])]);
  console.log('Preflight checks... passed ✅');

  const balanceBeforeSend = await connection.getBalance(keypair.publicKey, 'confirmed');
  const requiredForSend = BigInt(feeLamports + feeBufferLamports) + devbuyLamports;
  if (BigInt(balanceBeforeSend) < requiredForSend) {
    await waitForFunds(connection, keypair.publicKey, Number(requiredForSend), args.network);
  }

  console.log(`Creating ${args.pool === 'amm' ? 'pool' : 'pair'}...`);
  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [keypair, ...(bundle.signers || [])],
    { commitment: 'confirmed', skipPreflight: false }
  );
  console.log(`Creating ${args.pool === 'amm' ? 'pool' : 'pair'}... done: ${solscanTxUrl(signature, args.network)}`);

  console.log('\nLaunch successful.');
  console.log(`Network: ${args.network}`);
  console.log(`Pool type: ${args.pool}`);
  console.log(`Mint: ${mintB.toBase58()}`);
  console.log(`${args.pool === 'amm' ? 'Pool' : 'Pair'}: ${launchedAddress.toBase58()}`);
  console.log(`Managed wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Shift (raw base units): ${shiftRaw.toString()}`);
  console.log(`Dev buy raw amount: ${devbuyRaw.toString()}`);
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  if (process.argv.slice(2).length === 0) {
    usage();
    return;
  }

  if (parsed.help) {
    usage();
    return;
  }

  if (parsed.version) {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'mcap')) {
    throw new Error('mcap has been removed. Use --shift instead.');
  }

  if (parsed['export-wallet'] && parsed['get-wallet']) {
    throw new Error('export-wallet and get-wallet cannot be used together');
  }

  if (parsed['export-wallet']) {
    await runExportWalletFlow();
    return;
  }

  if (parsed['get-wallet']) {
    await runGetWalletFlow(parsed);
    return;
  }

  await runLaunchFlow(parsed);
}

run().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
