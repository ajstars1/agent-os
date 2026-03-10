import { describe, it, expect } from 'vitest';
import { LLMRouter } from '../llm/router.js';
import { MockGeminiClient } from './mocks/gemini.js';

describe('LLMRouter', () => {
  it('routes cc: prefix to claude regardless of gemini client', async () => {
    const router = new LLMRouter(null, 'auto');
    expect(await router.route('cc: explain this code', 'auto')).toBe('claude');
  });

  it('routes g: prefix to gemini', async () => {
    const gemini = new MockGeminiClient('gemini');
    const router = new LLMRouter(gemini, 'auto');
    expect(await router.route('g: what time is it', 'auto')).toBe('gemini');
  });

  it('defaults to claude when no gemini client and model is auto', async () => {
    const router = new LLMRouter(null, 'auto');
    expect(await router.route('what is the capital of France', 'auto')).toBe('claude');
  });

  it('respects forceModel=claude override', async () => {
    const gemini = new MockGeminiClient('gemini');
    const router = new LLMRouter(gemini, 'auto');
    expect(await router.route('anything', 'claude')).toBe('claude');
  });

  it('respects forceModel=gemini override', async () => {
    const gemini = new MockGeminiClient('claude');
    const router = new LLMRouter(gemini, 'auto');
    expect(await router.route('write a complex algorithm', 'gemini')).toBe('gemini');
  });

  it('uses defaultModel=claude when auto and no gemini', async () => {
    const router = new LLMRouter(null, 'claude');
    expect(await router.route('quick lookup', 'auto')).toBe('claude');
  });

  it('stripPrefix removes cc: prefix and trims', () => {
    const router = new LLMRouter(null, 'auto');
    expect(router.stripPrefix('cc:   hello world')).toBe('hello world');
  });

  it('stripPrefix removes g: prefix and trims', () => {
    const router = new LLMRouter(null, 'auto');
    expect(router.stripPrefix('g: what time')).toBe('what time');
  });

  it('stripPrefix returns original string with no prefix', () => {
    const router = new LLMRouter(null, 'auto');
    expect(router.stripPrefix('no prefix here')).toBe('no prefix here');
  });

  it('classifies via gemini when auto and gemini client available', async () => {
    const gemini = new MockGeminiClient('gemini');
    const router = new LLMRouter(gemini, 'auto');
    // MockGeminiClient returns 'gemini' by default for classify
    expect(await router.route('some message', 'auto')).toBe('gemini');
  });
});
