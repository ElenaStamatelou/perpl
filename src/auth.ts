import { createHash, randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { config } from "./config.js";

function nonce(): string {
  return randomBytes(16).toString("base64url");
}

function privateKeyBytes(): Uint8Array {
  return Buffer.from(config.apiKeySecretHex, "hex");
}

/**
 * Signs and sends a REST request per authentication.md: canonical string is
 * chain_id\nMETHOD\ntarget\ntimestamp_ms\nnonce\nsha256(body)hex, Ed25519-signed,
 * sent as X-API-* headers. `target` must be the path+query exactly as sent.
 */
export async function signedFetch(
  method: string,
  target: string,
  body = ""
): Promise<Response> {
  const timestamp = Date.now().toString();
  const n = nonce();
  const bodyHash = createHash("sha256").update(body).digest("hex");

  const canonical = [config.chainId, method, target, timestamp, n, bodyHash].join("\n");
  const sig = await ed.signAsync(Buffer.from(canonical), privateKeyBytes());

  return fetch(`${config.apiUrl}${target}`, {
    method,
    headers: {
      "X-API-Key": config.apiKey,
      "X-API-Timestamp": timestamp,
      "X-API-Nonce": n,
      "X-API-Signature": Buffer.from(sig).toString("base64url"),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
}

/**
 * Builds a signed ApiKeySignIn frame (mt: 29) for the trading WebSocket.
 * Canonical string: chain_id\ntrading-ws-signin\ntimestamp_ms\nnonce.
 */
export async function buildApiKeySignInFrame(): Promise<{
  mt: 29;
  chain_id: number;
  api_key: string;
  timestamp: string;
  nonce: string;
  signature: string;
}> {
  const timestamp = Date.now().toString();
  const n = nonce();
  const canonical = [config.chainId, "trading-ws-signin", timestamp, n].join("\n");
  const sig = await ed.signAsync(Buffer.from(canonical), privateKeyBytes());

  return {
    mt: 29,
    chain_id: config.chainId,
    api_key: config.apiKey,
    timestamp,
    nonce: n,
    signature: Buffer.from(sig).toString("base64url"),
  };
}
