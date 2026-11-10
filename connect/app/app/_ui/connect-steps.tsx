import { CopyLine } from './copy-line'

// How to add aos to the assistant the person already uses. No install, any computer or phone.
export const ConnectSteps = ({ url }: { url: string }) => (
  <div>
    <CopyLine text={url} label="Copy the aos connector link" />
    <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-dim">
      <li>Copy the link above.</li>
      <li>
        In <span className="text-ink">Claude</span>: Settings, then Connectors, then Add custom connector. In{' '}
        <span className="text-ink">ChatGPT</span>: Settings, then Connectors (or Apps), then add a custom one.
      </li>
      <li>Paste the link, give it the name aos, and press Connect.</li>
      <li>Sign in with Google here and press Allow.</li>
      <li>
        Ask your assistant: <span className="text-ink">&ldquo;What is on my aos agenda today?&rdquo;</span>
      </li>
    </ol>
  </div>
)
