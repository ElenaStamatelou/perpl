// One-time API key enrollment (integrations.md). Generates a fresh Ed25519
// keypair, signs the EIP-712 enrollment payload with the trading wallet, and
// writes the resulting PERPL_API_KEY / PERPL_API_KEY_SECRET into .env.
//
// NOTE: the docs recommend enrolling via a *connected* wallet (browser
// extension, WalletConnect, hardware wallet) rather than a raw private key in
// an env var - see https://app.perpl.xyz/apikeys (or testnet.perpl.xyz) for
// that simpler, safer path. This script exists for headless/automated
// enrollment only if you deliberately want that; it reads WALLET_PRIVATE_KEY
// from .env and never sends it anywhere over the network, but treat that
// value as fully sensitive for as long as it's on disk.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as ed from "@noble/ed25519";
import { ethers } from "ethers";
import { config } from "../src/config.js";
import type { ApiKeyEnrollResponse, ApiKeyPayloadResponse } from "../src/types.js";

const ENV_PATH = new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function setEnvVar(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(contents)) return contents.replace(re, line);
  return contents.trimEnd() + `\n${line}\n`;
}

async function main() {
  if (!config.walletPrivateKey) {
    throw new Error(
      "WALLET_PRIVATE_KEY is not set in .env. Either set it (headless enrollment) " +
        `or skip this script and create a key at ${config.apiUrl.replace("/api", "")}/apikeys instead.`
    );
  }

  const label = process.argv[2] || "perpl-volume-bot";
  const scopeMask = 3; // read | trade

  console.log(`Enrolling API key on ${config.network} (chain ${config.chainId}), label="${label}"`);

  // Step 1: generate the Ed25519 keypair for this bot.
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyHex = "0x" + Buffer.from(publicKey).toString("hex");

  const wallet = new ethers.Wallet(config.walletPrivateKey);
  console.log(`Signer wallet address: ${wallet.address}`);

  // Step 2: request the EIP-712 payload to sign.
  const payloadRes = await fetch(`${config.apiUrl}/v1/api-key/payload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.origin },
    body: JSON.stringify({
      chain_id: config.chainId,
      address: wallet.address,
      public_key: publicKeyHex,
      scope_mask: scopeMask,
      label,
    }),
  });
  if (!payloadRes.ok) {
    throw new Error(`api-key/payload failed: ${payloadRes.status} ${await payloadRes.text()}`);
  }
  const { typed_data, mac } = (await payloadRes.json()) as ApiKeyPayloadResponse;

  // Step 3: sign with the wallet (EIP-712) and with the Ed25519 key (proof-of-possession).
  const td = typed_data as {
    domain: ethers.TypedDataDomain;
    types: Record<string, Array<{ name: string; type: string }>>;
    message: Record<string, unknown>;
  };
  const { EIP712Domain: _domainType, ...types } = td.types;
  const signature = await wallet.signTypedData(td.domain, types, td.message);

  const digest = ethers.TypedDataEncoder.hash(td.domain, types, td.message);
  const popSig = await ed.signAsync(ethers.getBytes(digest), privateKey);
  const popSignature = "0x" + Buffer.from(popSig).toString("hex");

  // Step 4: submit the enrollment.
  const enrollRes = await fetch(`${config.apiUrl}/v1/api-key/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.origin },
    body: JSON.stringify({
      chain_id: config.chainId,
      address: wallet.address,
      typed_data,
      mac,
      signature,
      pop_signature: popSignature,
    }),
  });
  if (!enrollRes.ok) {
    throw new Error(`api-key/enroll failed: ${enrollRes.status} ${await enrollRes.text()}`);
  }
  const { api_key } = (await enrollRes.json()) as ApiKeyEnrollResponse;

  const secretHex = "0x" + Buffer.from(privateKey).toString("hex");
  console.log(`Enrolled. api_key=${api_key.api_key}`);

  const envContents = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const updated = setEnvVar(
    setEnvVar(envContents, "PERPL_API_KEY", api_key.api_key),
    "PERPL_API_KEY_SECRET",
    secretHex
  );
  writeFileSync(ENV_PATH, updated, "utf8");
  console.log(`Wrote PERPL_API_KEY and PERPL_API_KEY_SECRET to ${ENV_PATH}`);
  console.log(
    "Consider clearing WALLET_PRIVATE_KEY from .env now - it is not needed again unless you re-enroll."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
