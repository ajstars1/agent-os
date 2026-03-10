import { describe, it, expect, beforeEach } from 'vitest';
import { StateRouter, type ConversationState } from '../memory/state-router.js';

describe('StateRouter.detectState', () => {
  let router: StateRouter;
  beforeEach(() => { router = new StateRouter(); });

  const cases: Array<[string, ConversationState]> = [
    ['what is AgentOS?', 'INTRO'],
    ['who are you?', 'INTRO'],
    ['tell me about your product', 'INTRO'],
    ['I have a problem with memory', 'PROBLEM'],
    ['we are struggling with latency', 'PROBLEM'],
    ['the API is broken', 'PROBLEM'],
    ['how do you handle multi-turn conversations?', 'SOLUTION'],
    ['what is your approach to routing?', 'SOLUTION'],
    ['what features does it have?', 'FEATURES'],
    ['can it integrate with Discord?', 'FEATURES'],
    ['tell me more about the retriever', 'DEEP_DIVE'],
    ['explain how it works under the hood', 'DEEP_DIVE'],
    ['what is the pricing?', 'CTA'],
    ['how much does it cost?', 'CTA'],
    ['next steps to get started?', 'CTA'],
    ['hello there', 'GENERAL'],
    ['great', 'GENERAL'],
    ['ok thanks', 'GENERAL'],
  ];

  for (const [msg, expectedState] of cases) {
    it(`detects "${msg}" → ${expectedState}`, () => {
      expect(router.detectState(msg)).toBe(expectedState);
    });
  }
});

describe('StateRouter.transition', () => {
  it('updates current and previous state', () => {
    const router = new StateRouter();
    expect(router.currentState).toBe('GENERAL');
    router.transition('what is this?');
    expect(router.currentState).toBe('INTRO');
    expect(router.previousState).toBe('GENERAL');
    router.transition('tell me more details');
    expect(router.currentState).toBe('DEEP_DIVE');
    expect(router.previousState).toBe('INTRO');
  });
});

describe('StateRouter.getRetrievalDepth', () => {
  const router = new StateRouter();

  it('INTRO → L1', () => expect(router.getRetrievalDepth('INTRO')).toBe('L1'));
  it('GENERAL → L1', () => expect(router.getRetrievalDepth('GENERAL')).toBe('L1'));
  it('PROBLEM → L2', () => expect(router.getRetrievalDepth('PROBLEM')).toBe('L2'));
  it('SOLUTION → L2', () => expect(router.getRetrievalDepth('SOLUTION')).toBe('L2'));
  it('FEATURES → L2', () => expect(router.getRetrievalDepth('FEATURES')).toBe('L2'));
  it('DEEP_DIVE → L3', () => expect(router.getRetrievalDepth('DEEP_DIVE')).toBe('L3'));
  it('CTA → L1', () => expect(router.getRetrievalDepth('CTA')).toBe('L1'));
});
