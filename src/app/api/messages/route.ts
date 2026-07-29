import { NextResponse } from "next/server";
import { getWebhookSample, listConversations, storageBackend } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the status panel polls (~1s). Everything it renders was put here by the
 * webhook receiver — there is no list endpoint on the Sent API to fall back to.
 *
 * `?debug=1` also returns the most recent raw webhook delivery, which is how
 * you discover Sent's payload field names against live traffic.
 */
export async function GET(request: Request) {
  const debug = new URL(request.url).searchParams.get("debug") === "1";
  const conversations = await listConversations();

  return NextResponse.json({
    conversations,
    storageBackend,
    ...(debug ? { lastWebhook: await getWebhookSample() } : {}),
  });
}
