// Re-export hook types here so shared/types can reference them without a
// circular dependency on core.

export interface HookBinding {
  events: Array<'toolUsePre' | 'toolUsePost' | 'toolUseError' | 'messageReceived' | 'responseDone'>;
  match?: string;
  hook:
    | { type: 'command'; command: string; env?: Record<string, string>; timeoutMs?: number; once?: boolean }
    | { type: 'http'; url: string; headers?: Record<string, string>; timeoutMs?: number; once?: boolean }
    | { type: 'prompt'; content: string; once?: boolean };
}
