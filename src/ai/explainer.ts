// explainer.ts — the AI explainability module (CLAUDE.md §3).
// Why an interface: the server and tests never touch any model API directly.
// Two implementations sit behind it:
//   - RuleBasedExplainer — a pure, offline template engine. It is the default
//     (no API key needed), so the public demo generates real explanations at
//     zero API cost and with no external dependency.
//   - AnthropicExplainer — the LLM-backed one, selected when ANTHROPIC_API_KEY
//     is set, for richer prose.
// Both build from the SAME injected `ExplainData` facts (assembled in boot.ts
// from Postgres), so the module is DB-free and unit-testable with no network.
// Key tradeoff: keeping the facts and the rupee formatting shared means the
// two explainers can never describe the same fill differently in substance —
// only in phrasing.

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

// Model used when AI_MODEL is unset. Haiku 4.5 is the demo default: the
// explanation is a short, human-facing call where latency and cost matter more
// than the extra reasoning headroom of a frontier model. Set AI_MODEL (e.g.
// claude-opus-4-8) to trade cost for richer explanations — the deployer's call.
export const DEFAULT_AI_MODEL = 'claude-haiku-4-5';

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
  /**
   * Executions of this order, in execution order (best price first). Prices in
   * paise. `role` is this order's side of each trade: 'maker' means it was
   * resting in the book and an incoming order hit it; 'taker' means it was the
   * aggressor. A fully-maker fill is what distinguishes rested-then-filled from
   * an aggressive sweep — both can end at status 'filled'.
   */
  fills: { price: number; qty: number; role: 'maker' | 'taker' }[];
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
// explanation per order, and re-generating an evicted one is cheap either way.
const CACHE_LIMIT = 1000;
const MAX_TOKENS = 400;

/** Insert into a per-order cache, evicting the oldest entry past the cap (FIFO). */
function putBounded(cache: Map<string, ExplainResult>, key: string, value: ExplainResult): void {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// ---------------------------------------------------------- rule-based impl

/**
 * The offline default: turns the order facts into a plain-language explanation
 * with no network and no model. Deterministic, instant, free — which is why
 * the demo uses it unless an API key is configured.
 */
export class RuleBasedExplainer implements Explainer {
  private readonly dataSource: ExplainDataSource;
  private readonly cache = new Map<string, ExplainResult>();

  constructor(opts: { dataSource: ExplainDataSource }) {
    this.dataSource = opts.dataSource;
  }

  async explainOrder(orderId: string): Promise<ExplainResult> {
    const cached = this.cache.get(orderId);
    if (cached) return cached;

    const data = await this.dataSource(orderId);
    // The route already verified the order exists and belongs to the caller;
    // a miss here is the only case where an explanation genuinely can't be
    // produced, so it maps to INTERNAL (per the contract).
    if (!data) throw new ApiError(500, 'INTERNAL', 'order data unavailable for explanation');

    const result: ExplainResult = { explanation: buildRuleExplanation(data), generatedAt: new Date().toISOString() };
    putBounded(this.cache, orderId, result);
    return result;
  }
}

/**
 * Pure template engine — exported for unit testing. Covers every terminal (and
 * resting) shape an order can take: full fill, partial fill still resting,
 * market order sweeping multiple levels, market remainder canceled, a limit
 * that rested then filled, and a canceled limit (whether the trader canceled it
 * or self-trade prevention did — the persisted facts don't distinguish those,
 * so this states the economics without asserting the cause; the UI surfaces the
 * self-trade badge from its own client-side context). Always returns a
 * non-empty sentence.
 */
export function buildRuleExplanation(data: ExplainData): string {
  const { order, fills, instrument } = data;
  const money = (paise: number) => formatMoney(paise, instrument.priceScale);
  const sym = instrument.symbol;
  const shares = (n: number) => `${n} ${n === 1 ? 'share' : 'shares'} of ${sym}`;

  const filled = order.filledQty;
  const unfilled = order.qty - filled;
  const hasFills = filled > 0 && fills.length > 0;
  const sideWord = order.side === 'buy' ? 'buy' : 'sell';
  const doneVerb = order.side === 'buy' ? 'bought' : 'sold';
  const avg = hasFills ? order.filledNotional / filled : 0;

  // Execution shape: single price vs a multi-level sweep (with the slippage range).
  const prices = fills.map((f) => f.price);
  const distinct = new Set(prices).size;
  const single = distinct <= 1;
  const priceClause = !hasFills ? '' : single ? `at ${money(prices[0]!)}` : `at an average of ${money(avg)}`;
  const detail = fills.map((f) => `${f.qty} @ ${money(f.price)}`).join(', ');
  const range = single ? '' : `, with prices ranging from ${money(Math.min(...prices))} to ${money(Math.max(...prices))} as it consumed available liquidity`;
  const sweep = hasFills && !single ? ` It swept ${distinct} price levels (${detail})${range}.` : '';

  // ---- market orders (never rest; any remainder is canceled) ----
  if (order.type === 'market') {
    if (!hasFills) {
      const opp = order.side === 'buy' ? 'asks' : 'bids';
      return `Your market ${sideWord} for ${shares(order.qty)} could not fill — there were no ${opp} in the book — so it was canceled. Market orders never rest.`;
    }
    if (unfilled > 0) {
      return `Your market ${sideWord} for ${shares(order.qty)} ${doneVerb} ${filled} ${priceClause}, then the book ran out of liquidity, so the remaining ${unfilled} ${unfilled === 1 ? 'share was' : 'shares were'} canceled (market orders never rest).${sweep}`;
    }
    return `Your market ${sideWord} for ${shares(order.qty)} ${doneVerb} all ${filled} ${priceClause}.${sweep}`;
  }

  // ---- limit orders ----
  const limit = order.price!;
  const improvement =
    hasFills && order.side === 'buy'
      ? limit * filled - order.filledNotional
      : hasFills
        ? order.filledNotional - limit * filled
        : 0;
  const imprNote = improvement > 0 ? `, ${money(improvement)} better than your limit of ${money(limit)} (price improvement)` : '';
  const restedMaker = hasFills && fills.every((f) => f.role === 'maker');

  if (order.status === 'filled') {
    if (restedMaker) {
      return `Your ${sideWord} limit for ${shares(order.qty)} at ${money(limit)} rested in the book and filled completely at ${money(avg)} when matching orders arrived.`;
    }
    return `Your ${sideWord} limit for ${shares(order.qty)} ${doneVerb} all ${filled} ${priceClause}${imprNote}.${sweep}`;
  }

  if (order.status === 'partially_filled') {
    return `Your ${sideWord} limit for ${shares(order.qty)} at ${money(limit)} filled ${filled} ${priceClause}${imprNote}; the remaining ${unfilled} ${unfilled === 1 ? 'share is' : 'shares are'} still resting in the book at ${money(limit)}.`;
  }

  if (order.status === 'canceled') {
    if (!hasFills) {
      return `Your ${sideWord} limit for ${shares(order.qty)} at ${money(limit)} was canceled before any of it filled, so nothing traded.`;
    }
    return `Your ${sideWord} limit for ${shares(order.qty)} at ${money(limit)} filled ${filled} ${priceClause}${imprNote}; the remaining ${unfilled} ${unfilled === 1 ? 'share was' : 'shares were'} canceled.`;
  }

  // Still open (e.g. just placed, resting): describe its working state.
  return `Your ${sideWord} limit for ${shares(order.qty)} at ${money(limit)} is working in the book${hasFills ? `, ${filled} filled so far ${priceClause}` : ''}.`;
}

// --------------------------------------------------------- anthropic impl

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
    putBounded(this.cache, orderId, result);
    return result;
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

/** Pure prompt assembly — exported for unit testing. Uses the same facts as buildRuleExplanation. */
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
      // Resting-then-filled reads very differently from an aggressive sweep;
      // the fill role is the fact that tells them apart.
      if (order.type === 'limit' && fills.every((f) => f.role === 'maker')) {
        lines.push('This order rested in the book (maker) and was filled when opposing orders arrived.');
      }
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
