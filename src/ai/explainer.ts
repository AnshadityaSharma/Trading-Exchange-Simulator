// explainer.ts — the AI explainability module (CLAUDE.md §3).
// Why an interface: the server and tests never touch the Anthropic API
// directly. `UnavailableExplainer` (no API key configured) declares itself
// unavailable, which the contract maps to an INTERNAL error while all order
// data stays served by the normal API. `AnthropicExplainer` is the real
// implementation — it turns one order's facts into a plain-language
// explanation of the fill.
// Key tradeoff: the module is kept free of SQL. It receives an injected
// `ExplainDataSource` (wired in boot.ts) rather than a database handle, so it
// stays pure enough to unit-test against a fake client with no Postgres.

import type Anthropic from '@anthropic-ai/sdk';
import { ApiError } from '../server/errors.js';

export interface ExplainResult {
  explanation: string;
  generatedAt: string;
}

export interface Explainer {
  /** Plain-language explanation of an order's outcome. Cached per order. */
  explainOrder(orderId: string): Promise<ExplainResult>;
}

export class UnavailableExplainer implements Explainer {
  async explainOrder(): Promise<ExplainResult> {
    throw new ApiError(500, 'INTERNAL', 'explanations are not available on this deployment');
  }
}

// --------------------------------------------------------------- real impl

/** Model used when AI_MODEL is unset. Overridable so cost/latency is the deployer's call. */
export const DEFAULT_AI_MODEL = 'claude-opus-4-8';

/** The facts of one order the explainer needs — assembled by the caller (boot.ts). */
export interface ExplainData {
  order: {
    id: string;
    side: 'buy' | 'sell';
    type: 'limit' | 'market';
    price: number | null; // paise; null for market orders
    qty: number;
    filledQty: number;
    filledNotional: number; // paise
    status: string;
  };
  /** Executions of this order, in execution order (best price first). Prices in paise. */
  fills: { price: number; qty: number }[];
  instrument: { symbol: string; name: string; priceScale: number };
}

/** Fetches the facts for an order id. Returns null if the order no longer exists. */
export type ExplainDataSource = (orderId: string) => Promise<ExplainData | null>;

/** The one method we call on the Anthropic client — narrowed so tests can fake it. */
export interface AiMessagesClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

// Bounded so a long-lived deploy that explains many distinct orders can't grow
// memory without limit. FIFO eviction (Map preserves insertion order); one
// explanation per order, and re-generating an evicted one just costs one more
// API call — acceptable for a demo.
const CACHE_LIMIT = 1000;
const MAX_TOKENS = 400;

export class AnthropicExplainer implements Explainer {
  private readonly client: AiMessagesClient;
  private readonly model: string;
  private readonly dataSource: ExplainDataSource;
  private readonly cache = new Map<string, ExplainResult>();

  constructor(opts: { client: AiMessagesClient; model: string; dataSource: ExplainDataSource }) {
    this.client = opts.client;
    this.model = opts.model;
    this.dataSource = opts.dataSource;
  }

  async explainOrder(orderId: string): Promise<ExplainResult> {
    const cached = this.cache.get(orderId);
    if (cached) return cached;

    const data = await this.dataSource(orderId);
    // The route already verified the order exists and belongs to the caller;
    // a miss here means it vanished under us — unexpected, so surface INTERNAL.
    if (!data) throw new ApiError(500, 'INTERNAL', 'order data unavailable for explanation');

    const prompt = buildPrompt(data);
    let msg: Anthropic.Message;
    try {
      msg = await this.client.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        // A fill explanation is a short, simple task: no extended thinking,
        // low effort keeps latency and cost down on this human-facing path.
        output_config: { effort: 'low' },
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      });
    } catch {
      throw new ApiError(500, 'INTERNAL', 'failed to generate explanation');
    }

    if (msg.stop_reason === 'refusal') {
      throw new ApiError(500, 'INTERNAL', 'explanation was declined');
    }
    const explanation = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!explanation) throw new ApiError(500, 'INTERNAL', 'empty explanation');

    const result: ExplainResult = { explanation, generatedAt: new Date().toISOString() };
    this.cachePut(orderId, result);
    return result;
  }

  private cachePut(orderId: string, result: ExplainResult): void {
    this.cache.set(orderId, result);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}

// ------------------------------------------------------------ prompt build

const SYSTEM_PROMPT =
  'You explain individual stock-trade fills to a retail investor using a paper-trading app. ' +
  'Given the facts of one order, write a short, plain-language explanation (2 to 4 sentences) of ' +
  'what happened and why it filled at the price or prices it did. Mention price improvement or ' +
  'slippage across price levels when relevant, and note any unfilled quantity and why it went ' +
  'unfilled. Use only the numbers provided — never invent prices, volumes, or market commentary, ' +
  'and give no trading advice. Plain prose only: no markdown, no bullet points, no preamble.';

/** Pure prompt assembly — exported for unit testing. */
export function buildPrompt(data: ExplainData): { system: string; user: string } {
  const { order, fills, instrument } = data;
  const money = (paise: number) => formatMoney(paise, instrument.priceScale);

  const lines: string[] = [];
  lines.push(`Instrument: ${instrument.name} (${instrument.symbol})`);
  lines.push(`Order: ${order.side} ${order.type}, ${order.qty} share(s)`);
  if (order.type === 'limit' && order.price !== null) {
    lines.push(`Limit price: ${money(order.price)}`);
  }
  lines.push(`Final status: ${order.status.replace(/_/g, ' ')}`);
  lines.push(`Filled: ${order.filledQty} of ${order.qty} share(s)`);

  if (order.filledQty > 0) {
    const avg = order.filledNotional / order.filledQty;
    lines.push(`Average fill price: ${formatMoney(avg, instrument.priceScale)}`);
    if (fills.length > 0) {
      const detail = fills.map((f) => `${f.qty} @ ${money(f.price)}`).join(', ');
      lines.push(`Executions (in order): ${detail}`);
    }
    if (order.type === 'limit' && order.price !== null) {
      const improvementPaise =
        order.side === 'buy'
          ? order.price * order.filledQty - order.filledNotional
          : order.filledNotional - order.price * order.filledQty;
      if (improvementPaise > 0) {
        lines.push(`Price improvement vs the limit: ${money(improvementPaise)} total in the trader's favour`);
      }
    }
  }
  const unfilled = order.qty - order.filledQty;
  if (unfilled > 0) {
    lines.push(
      order.status === 'canceled' || order.status.includes('cancel')
        ? `Unfilled: ${unfilled} share(s), canceled (no resting remainder for a market order, or the order was canceled)`
        : `Still resting: ${unfilled} share(s) not yet filled`,
    );
  }

  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}

/** paise → "₹X.YZ", with decimal places implied by the instrument's price scale. */
function formatMoney(paise: number, priceScale: number): string {
  const decimals = Math.max(0, Math.round(Math.log10(priceScale)));
  return `₹${(paise / priceScale).toFixed(decimals)}`;
}
