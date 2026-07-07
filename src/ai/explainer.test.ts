// explainer.test.ts — unit tests for the AI explainer. No Postgres, no real
// Anthropic API: the data source is a stub and the messages client is a fake,
// so these assert the prompt content, caching, and the INTERNAL error mapping
// without any network or DB. (The interface stubbing this exercises is exactly
// what CLAUDE.md §3 requires.)

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../server/errors.js';
import {
  AnthropicExplainer,
  buildPrompt,
  buildRuleExplanation,
  RuleBasedExplainer,
  type AiMessagesClient,
  type ExplainData,
} from './explainer.js';

const ACME = { symbol: 'ACME', name: 'Acme Industries', priceScale: 100 };

/** A completed buy that swept two ask levels below its limit (price improvement). */
const buyData: ExplainData = {
  order: {
    id: 'ord_1',
    side: 'buy',
    type: 'limit',
    price: 245030, // ₹2,450.30 limit
    qty: 4,
    filledQty: 4,
    filledNotional: 245000 * 2 + 245010 * 2, // ₹2,450.00 ×2 and ₹2,450.10 ×2
    status: 'filled',
  },
  fills: [
    { price: 245000, qty: 2, role: 'taker' },
    { price: 245010, qty: 2, role: 'taker' },
  ],
  instrument: ACME,
};

function fakeMessage(text: string, stopReason: Anthropic.Message['stop_reason'] = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    stop_reason: stopReason,
    stop_sequence: null,
    content: text ? [{ type: 'text', text, citations: null }] : [],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

function explainerWith(client: AiMessagesClient, data: ExplainData | null = buyData) {
  return new AnthropicExplainer({ client, model: 'claude-haiku-4-5', dataSource: async () => data });
}

describe('buildPrompt', () => {
  it('formats prices in rupees and states the fill breakdown and price improvement', () => {
    const { system, user } = buildPrompt(buyData);
    expect(system).toContain('plain-language');
    expect(user).toContain('Acme Industries (ACME)');
    expect(user).toContain('buy limit, 4 share(s)');
    expect(user).toContain('Limit price: ₹2450.30');
    expect(user).toContain('Average fill price: ₹2450.05');
    expect(user).toContain('2 @ ₹2450.00, 2 @ ₹2450.10');
    // Improvement: (245030 - 245005) × ... computed as limit×qty - notional = 245030*4 - 980020 = 100 paise
    expect(user).toContain('Price improvement vs the limit: ₹1.00');
  });

  it('describes an unfilled remainder for a partially canceled market order', () => {
    const { user } = buildPrompt({
      order: { id: 'o', side: 'buy', type: 'market', price: null, qty: 10, filledQty: 3, filledNotional: 735000, status: 'partial_canceled' },
      fills: [{ price: 245000, qty: 3, role: 'taker' }],
      instrument: ACME,
    });
    expect(user).not.toContain('Limit price');
    expect(user).toContain('Filled: 3 of 10');
    expect(user).toContain('Unfilled: 7 share(s), canceled');
  });

  it('notes when a limit order rested as maker before filling', () => {
    const { user } = buildPrompt({
      order: { id: 'o', side: 'sell', type: 'limit', price: 245000, qty: 5, filledQty: 5, filledNotional: 245000 * 5, status: 'filled' },
      fills: [{ price: 245000, qty: 5, role: 'maker' }],
      instrument: ACME,
    });
    expect(user).toContain('rested in the book (maker)');
  });
});

describe('buildRuleExplanation (offline templates)', () => {
  const rule = (data: ExplainData) => buildRuleExplanation(data);

  it('full fill: limit buy that swept two levels below its limit (price improvement)', () => {
    const text = rule(buyData);
    expect(text).toContain('buy limit for 4 shares of ACME bought all 4');
    expect(text).toContain('at an average of ₹2450.05');
    expect(text).toContain('₹1.00 better than your limit of ₹2450.30 (price improvement)');
    expect(text).toContain('swept 2 price levels (2 @ ₹2450.00, 2 @ ₹2450.10)');
    expect(text).toContain('ranging from ₹2450.00 to ₹2450.10');
  });

  it('resting-then-filled: a limit that rested as maker and filled at its price', () => {
    const text = rule({
      order: { id: 'o', side: 'sell', type: 'limit', price: 245000, qty: 5, filledQty: 5, filledNotional: 245000 * 5, status: 'filled' },
      fills: [{ price: 245000, qty: 5, role: 'maker' }],
      instrument: ACME,
    });
    expect(text).toContain('rested in the book and filled completely at ₹2450.00');
    expect(text).not.toContain('price improvement');
  });

  it('partial fill: a resting limit with an unfilled remainder', () => {
    const text = rule({
      order: { id: 'o', side: 'buy', type: 'limit', price: 245000, qty: 10, filledQty: 4, filledNotional: 245000 * 4, status: 'partially_filled' },
      fills: [{ price: 245000, qty: 4, role: 'taker' }],
      instrument: ACME,
    });
    expect(text).toContain('filled 4 at ₹2450.00');
    expect(text).toContain('remaining 6 shares are still resting in the book at ₹2450.00');
  });

  it('market order walking multiple levels: reports the sweep and slippage range', () => {
    const text = rule({
      order: { id: 'o', side: 'buy', type: 'market', price: null, qty: 6, filledQty: 6, filledNotional: 245000 * 2 + 245010 * 2 + 245050 * 2, status: 'filled' },
      fills: [
        { price: 245000, qty: 2, role: 'taker' },
        { price: 245010, qty: 2, role: 'taker' },
        { price: 245050, qty: 2, role: 'taker' },
      ],
      instrument: ACME,
    });
    expect(text).toContain('market buy for 6 shares of ACME bought all 6');
    expect(text).toContain('swept 3 price levels');
    expect(text).toContain('ranging from ₹2450.00 to ₹2450.50');
  });

  it('market remainder canceled: partial fill then canceled (never rests)', () => {
    const text = rule({
      order: { id: 'o', side: 'buy', type: 'market', price: null, qty: 10, filledQty: 3, filledNotional: 245000 * 3, status: 'canceled' },
      fills: [{ price: 245000, qty: 3, role: 'taker' }],
      instrument: ACME,
    });
    expect(text).toContain('bought 3 at ₹2450.00');
    expect(text).toContain('remaining 7 shares were canceled (market orders never rest)');
  });

  it('market order with no liquidity: nothing fills, canceled', () => {
    const text = rule({
      order: { id: 'o', side: 'buy', type: 'market', price: null, qty: 5, filledQty: 0, filledNotional: 0, status: 'canceled' },
      fills: [],
      instrument: ACME,
    });
    expect(text).toContain('could not fill — there were no asks in the book');
    expect(text).toContain('Market orders never rest');
  });

  it('self-trade / canceled resting limit: states the economics without asserting the cause', () => {
    // A resting limit that was partially filled then canceled — the shape a
    // self-trade-prevention cancel leaves behind (indistinguishable in the
    // persisted facts from a manual cancel, so no cause is claimed).
    const text = rule({
      order: { id: 'o', side: 'buy', type: 'limit', price: 245000, qty: 8, filledQty: 2, filledNotional: 245000 * 2, status: 'canceled' },
      fills: [{ price: 245000, qty: 2, role: 'maker' }],
      instrument: ACME,
    });
    expect(text).toContain('filled 2 at ₹2450.00');
    expect(text).toContain('remaining 6 shares were canceled');
    expect(text).not.toMatch(/self-trade/i);
  });

  it('canceled limit before any fill', () => {
    const text = rule({
      order: { id: 'o', side: 'sell', type: 'limit', price: 246000, qty: 3, filledQty: 0, filledNotional: 0, status: 'canceled' },
      fills: [],
      instrument: ACME,
    });
    expect(text).toContain('sell limit for 3 shares of ACME at ₹2460.00 was canceled before any of it filled');
  });
});

describe('RuleBasedExplainer', () => {
  const withData = (data: ExplainData | null) => new RuleBasedExplainer({ dataSource: async () => data });

  it('produces and caches an explanation with no network', async () => {
    const explainer = withData(buyData);
    const first = await explainer.explainOrder('ord_1');
    const second = await explainer.explainOrder('ord_1');
    expect(first.explanation).toContain('buy limit for 4 shares of ACME bought all 4');
    expect(first.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(second).toBe(first); // cached: same object
  });

  it('maps missing order data to INTERNAL — the only unproducible case', async () => {
    await expect(withData(null).explainOrder('gone')).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('AnthropicExplainer', () => {
  it('generates an explanation and passes the model, system, and user prompt', async () => {
    const create = vi.fn<AiMessagesClient['create']>(async () =>
      fakeMessage('You bought 4 shares of Acme just below your limit.'),
    );
    const explainer = explainerWith({ create });

    const result = await explainer.explainOrder('ord_1');

    expect(result.explanation).toBe('You bought 4 shares of Acme just below your limit.');
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0];
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.system).toContain('retail investor');
    expect(String((params.messages[0]!).content)).toContain('Acme Industries');
  });

  it('caches per order — a second call does not hit the API again', async () => {
    const create = vi.fn(async () => fakeMessage('cached explanation'));
    const explainer = explainerWith({ create });

    const first = await explainer.explainOrder('ord_1');
    const second = await explainer.explainOrder('ord_1');

    expect(second).toBe(first); // same cached object
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps an API failure to an INTERNAL ApiError', async () => {
    const explainer = explainerWith({
      create: async () => {
        throw new Error('rate limited');
      },
    });
    await expect(explainer.explainOrder('ord_1')).rejects.toMatchObject({
      constructor: ApiError,
      status: 500,
      code: 'INTERNAL',
    });
  });

  it('treats a refusal as INTERNAL', async () => {
    const explainer = explainerWith({ create: async () => fakeMessage('', 'refusal') });
    await expect(explainer.explainOrder('ord_1')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('treats empty content as INTERNAL', async () => {
    const explainer = explainerWith({ create: async () => fakeMessage('') });
    await expect(explainer.explainOrder('ord_1')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('returns INTERNAL when the order data has vanished', async () => {
    const explainer = explainerWith({ create: async () => fakeMessage('x') }, null);
    await expect(explainer.explainOrder('gone')).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
