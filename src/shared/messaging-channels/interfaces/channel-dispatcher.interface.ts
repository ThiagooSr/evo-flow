/**
 * Channel-agnostic dispatch seam (story 2.2 / EVO-1202). Today every campaign
 * channel (WhatsApp / email / SMS) is delivered through the CRM inbox, so there
 * is a single concrete dispatcher; the interface lets the future campaign-sender
 * (Epic 4) inject dispatchers by contract without branching on channel.
 */
export interface ChannelDispatchInput {
  contactId: string;
  /**
   * The recipient's channel identifier (WhatsApp phone number / `@lid` /
   * `@g.us` group id — see CRM's Contact#identifier). Required by
   * POST /api/v1/conversations' `source_id`, which the CRM validates against
   * a channel-specific regex; omitting it (or sending a synthetic id) fails
   * every dispatch with 422 "invalid source id for whatsapp inbox".
   */
  sourceId: string;
  inboxId: string;
  content: string;
  campaignId: string;
  templateParams?: {
    name: string;
    category?: string;
    language?: string;
    processed_params?: Record<string, unknown>;
  };
  /**
   * Transport-level attempts for a single dispatch (default 3, the legacy
   * behavior: quick network/429 retries inside the HTTP call). The
   * campaign-sender passes 1 so its own exponential-backoff policy (story
   * 4.5 / EVO-1219) is the single owner of retries on the new path.
   */
  transportRetries?: number;
}

export interface DispatchResult {
  success: boolean;
  messageId?: string;
  conversationId?: string;
  error?: { code: string; message: string };
  /** Round-trip time of the dispatch call, for future metrics (Epic 5). */
  latencyMs: number;
  statusCode?: number;
}

export interface IChannelDispatcher {
  dispatch(input: ChannelDispatchInput): Promise<DispatchResult>;
}
