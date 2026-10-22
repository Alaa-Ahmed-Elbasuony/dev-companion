// "Update available" notice for builds made from a git checkout.
import { useState } from 'react';
import { openExtensionsPage } from '../lib/updates';
import type { UpdateStatus } from '../lib/updates';
import { CodeBlock } from './common';

export const UPDATE_COMMANDS = ['git pull', 'npm install', 'npm run build'].join('\n');

/** The steps to update, with the commands and a shortcut to the reload button. */
export function UpdateSteps() {
  return (
    <ol className="update-steps">
      <li>
        Open Command Prompt in your <code>dev-companion</code> folder and run:
        <CodeBlock text={UPDATE_COMMANDS} label="Copy commands" raw />
      </li>
      <li>
        <button type="button" className="link" onClick={openExtensionsPage}>
          Open chrome://extensions
        </button>{' '}
        and click the reload icon ↻ on the Dev Companion card.
      </li>
      <li>Reload the pages you are debugging.</li>
    </ol>
  );
}

export function UpdateBanner({
  status,
  onDismiss,
  onDetails,
}: {
  status: UpdateStatus;
  onDismiss: () => void;
  /** Compact mode (popup): a link to the details instead of expanding in place. */
  onDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const n = status.commits.length;
  const summary = n ? `${n} new change${n === 1 ? '' : 's'}` : 'New changes';
  return (
    <div className="notice notice-info update-banner" role="status">
      <div className="update-head">
        <strong>Update available</strong>
        <span className="muted small">{summary} since your build</span>
        <span className="update-actions">
          {onDetails ? (
            <button type="button" className="btn btn-small btn-primary" onClick={onDetails}>
              How to update
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-small btn-primary"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Hide' : 'How to update'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={onDismiss}
            title="Hide until there are newer changes"
          >
            Dismiss
          </button>
        </span>
      </div>
      {open && !onDetails && (
        <div className="update-body">
          <UpdateCommits status={status} />
          <UpdateSteps />
        </div>
      )}
    </div>
  );
}

export function UpdateCommits({ status }: { status: UpdateStatus }) {
  if (!status.commits.length) return null;
  return (
    <>
      <h4>What's new</h4>
      <ul className="update-commits">
        {status.commits.slice(0, 10).map((c) => (
          <li key={c.sha}>
            <a href={c.url} target="_blank" rel="noreferrer">
              {c.message}
            </a>
            {c.date && <span className="muted small"> · {new Date(c.date).toLocaleDateString()}</span>}
          </li>
        ))}
        {status.commits.length > 10 && (
          <li>
            <a href={status.compareUrl} target="_blank" rel="noreferrer">
              …and {status.commits.length - 10} more
            </a>
          </li>
        )}
      </ul>
    </>
  );
}
