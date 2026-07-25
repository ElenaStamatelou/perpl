import { config } from "./config.js";

const NTFY_SERVER = "https://ntfy.sh";

/**
 * Fire-and-forget push notification via ntfy.sh (no account/token needed - just a
 * shared topic name). No-op unless NTFY_TOPIC is set. Failures (bad topic, network
 * blip) are logged, never thrown - a missing notification should never take down
 * trading.
 */
export async function sendNtfyMessage(title: string, message: string): Promise<void> {
  const { ntfyTopic } = config;
  if (!ntfyTopic) return;
  try {
    const res = await fetch(`${NTFY_SERVER}/${ntfyTopic}`, {
      method: "POST",
      headers: { Title: title, Tags: "bar_chart" },
      body: message,
    });
    if (!res.ok) {
      console.warn(`[ntfy] send failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`[ntfy] send error: ${(err as Error).message}`);
  }
}
