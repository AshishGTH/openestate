import { useEffect, useRef, useState } from 'react';

interface RevealedResetLinkProps {
  url: string;
  expiresAt: string;
  onDismiss: () => void;
}

// Reset links live 30 minutes; portal invites live days (INVITE_EXPIRY_DAYS)
// — this component doesn't know which, so the recheck has to be frequent
// enough that a reset link's expiry is caught promptly without being
// wasteful for an invite left open for days. 30s is frequent relative to
// the shorter case and negligible overhead for the longer one.
const RECHECK_INTERVAL_MS = 30_000;

// 'copied' only once the clipboard write has actually resolved. 'manual' when
// it can't: browsers expose navigator.clipboard only on HTTPS or localhost,
// so a default plain-HTTP LAN install has none at all, and a write can also be
// refused outright. Showing "Copied" there would let an admin paste whatever
// was already on their clipboard — possibly another customer's live link.
type CopyState = 'idle' | 'copied' | 'manual';

/**
 * Reveal-once panel for a one-time link (password-reset, and — via B4 —
 * the existing portal-invite link). Matches LeadApiKeys.tsx's amber
 * reveal-once panel visually; this one also carries a human-readable
 * expiry and a copy-confirmation state, neither of which that panel needs.
 *
 * The wording is deliberately generic ("this link", not "reset link") so it
 * reads correctly for both an admin-generated reset and a portal invite —
 * only the URL and expiry differ per caller, both passed in as props.
 */
export default function RevealedResetLink({ url, expiresAt, onDismiss }: RevealedResetLinkProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const codeRef = useRef<HTMLElement>(null);

  // Clears the "Copied" state if the panel is dismissed/replaced mid-timer,
  // so a stale setState never fires after unmount. 'manual' deliberately has
  // no timer: it explains why the clipboard is empty, so it stays until the
  // next Copy click or the panel goes away.
  useEffect(() => {
    if (copyState !== 'copied') return;
    const t = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(t);
  }, [copyState]);

  async function copy() {
    try {
      // With no Clipboard API this throws a TypeError, handled below exactly
      // like a refused write.
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
      setCopyState('manual');
    }
  }

  // Recomputes "now" periodically so the remaining-time line and the expired
  // state stay truthful for as long as the panel is left open — an admin
  // mid-call with the customer must never read a reassuring "N minutes from
  // now" about a link that has already died. Cleared on unmount/re-render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), RECHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const expiry = new Date(expiresAt);
  const msLeft = expiry.getTime() - now;
  const isExpired = msLeft <= 0;
  const minutesLeft = Math.max(0, Math.round(msLeft / 60000));
  const expiryClock = expiry.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  if (isExpired) {
    return (
      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-medium text-amber-900">
          This link expired at {expiryClock} — generate a new one.
        </p>
        <button onClick={onDismiss} className="mt-2 text-xs text-amber-700 hover:underline">
          Dismiss
        </button>
      </div>
    );
  }

  const expiryRelative =
    minutesLeft <= 0 ? 'less than a minute from now' : `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} from now`;
  const copyShortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘C' : 'Ctrl+C';

  return (
    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-900">Copy this link now — it will never be shown again:</p>
      <div className="mt-2 flex items-center gap-2">
        <code
          ref={codeRef}
          className="flex-1 select-all break-all rounded bg-white border border-amber-300 px-3 py-2 text-sm font-mono"
        >
          {url}
        </code>
        <button
          onClick={copy}
          className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
        >
          {copyState === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copyState === 'manual' && (
        <p role="status" className="mt-2 text-xs font-medium text-slate-700">
          Couldn&apos;t copy — link selected, press {copyShortcut}.
        </p>
      )}
      <p className="mt-2 text-xs text-amber-800">
        Expires at {expiryClock} — {expiryRelative}.
      </p>
      <p className="mt-1 text-xs text-amber-800">
        This install doesn&apos;t send email — send this link to them directly (WhatsApp, SMS, phone).
      </p>
      <button onClick={onDismiss} className="mt-2 text-xs text-amber-700 hover:underline">
        Dismiss
      </button>
    </div>
  );
}

/**
 * One line shown next to every "generate a reset link" control, because the
 * backend supersedes any live reset link for that user. The trap it guards:
 * an admin dismisses the panel, can no longer see the link, generates again —
 * and kills the link the customer is already holding. Reset links only:
 * portal invites don't supersede each other, so this must not sit on invites.
 */
export function ResetLinkSupersedeNote() {
  return (
    <p className="mt-1 text-xs text-slate-500">
      Generating a new reset link cancels any earlier one — including one you&apos;ve already sent.
    </p>
  );
}
