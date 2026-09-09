import { config } from "./config.js";

const NTFY_SERVER = "https://ntfy.sh";

export interface NtfyOptions {
  /** ntfy tag(s), comma-separated. A known emoji short-code (e.g. "white_check_mark")
   *  renders as an icon on the notification, which is what makes the feed scannable
   *  at a glance. Defaults to "bar_chart". */
  tags?: string;
  priority?: "min" | "low" | "default" | "high" | "urgent";
}

/**
 * Fire-and-forget push notification via ntfy.sh (no account/token needed - just a
 * shared topic name). No-op unless NTFY_TOPIC is set. Failures (bad topic, network
 * blip) are logged, never thrown - a missing notification should never take down
 * trading.
 *
 * Title goes in an HTTP header, so keep it plain ASCII (no bullets/em-dashes) or
 * the fetch call rejects it. The body is UTF-8 and unconstrained.
 */
export async function sendNtfyMessage(title: string, message: string, opts: NtfyOptions = {}): Promise<void> {
  const { ntfyTopic } = config;
  if (!ntfyTopic) return;
  const headers: Record<string, string> = {
    Title: title,
    Tags: opts.tags ?? "bar_chart",
  };
  if (opts.priority) headers.Priority = opts.priority;
  try {
    const res = await fetch(`${NTFY_SERVER}/${ntfyTopic}`, {
      method: "POST",
      headers,
      body: message,
    });
    if (!res.ok) {
      console.warn(`[ntfy] send failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`[ntfy] send error: ${(err as Error).message}`);
  }
}
