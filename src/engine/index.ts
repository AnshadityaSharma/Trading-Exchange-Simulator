// index.ts — public surface of the engine module. Everything outside
// src/engine/ imports from here, so internals (book-side) can change freely.
export { MatchingEngine } from './engine.js';
export type {
  Side,
  OrderType,
  OrderInput,
  Fill,
  SubmitStatus,
  SubmitResult,
  Depth,
  DepthLevel,
} from './types.js';
