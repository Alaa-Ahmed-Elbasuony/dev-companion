// Mock / latency / failure simulation: the master switch, what the current tab
// receives, the origin allowlist and the rules (in priority order).
import { useState } from 'react';
import type { SimulationChangeFailure, SimulationUpdateResponse } from '../../shared/messages';
import { normalizeOrigin, normalizeSettings } from '../../shared/settings';
import type { SimulationRule } from '../../shared/simulation';
import { Modal, Notice } from '../components/common';
import { Badge, ConfirmDialog } from '../components/ui';
import { loadSettings, saveSettings } from '../lib/extension';
import {
  RULE_KINDS,
  actionLabel,
  formFromRule,
  moveId,
  ruleFromForm,
  ruleWarnings,
  simulationBlockers,
  simulationDeliveryText,
  useSimulationState,
  whenLabel,
  workerErrorText,
} from '../lib/simulation';
import type { Problems, RuleForm } from '../lib/simulation';

type Msg = { kind: 'info' | 'error' | 'warning'; text: string } | null;

export function SimulationView({ tabId, version }: { tabId?: number; version: number }) {
  const sim = useSimulationState(tabId, version);
  const [message, setMessage] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ rule?: SimulationRule } | null>(null);
  const [deleting, setDeleting] = useState<SimulationRule | null>(null);
  const [originText, setOriginText] = useState('');
  const state = sim.state;

  if (!state) {
    return (
      <div className="settings">
        {sim.error ? (
          <>
            <Notice kind="error">{sim.error}</Notice>
            <button type="button" className="btn" onClick={() => void sim.refresh()}>
              Try again
            </button>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    );
  }

  /** Runs a worker call; the message is set only from the worker's answer. */
  const run = async (fn: () => Promise<Msg>) => {
    setBusy(true);
    try {
      setMessage(await fn());
    } catch (err) {
      setMessage({ kind: 'error', text: workerErrorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const failure = (res: SimulationUpdateResponse): Msg =>
    res.ok
      ? null
      : {
          kind: res.reason === 'conflict' || res.reason === 'not-found' ? 'warning' : 'error',
          text: res.message,
        };

  const setArmed = (armed: boolean) =>
    run(async () => {
      const latest = await sim.setArmed(armed);
      if (latest.armed !== armed) return { kind: 'error', text: 'The switch did not change. Try again.' };
      return {
        kind: 'info',
        text: armed
          ? 'Simulation is on. It runs only on allowlisted origins that are recording, and turns itself off when the browser restarts or the extension reloads.'
          : 'Simulation is off. Open pages stopped simulating; requests a rule was holding were sent normally. Your rules are kept.',
      };
    });

  const toggleRule = (rule: SimulationRule) =>
    run(async () => {
      const res = await sim.update({
        op: 'set-enabled',
        id: rule.id,
        enabled: !rule.enabled,
        expectedUpdatedAt: rule.updatedAt,
      });
      return (
        failure(res) ?? { kind: 'info', text: `${rule.enabled ? 'Disabled' : 'Enabled'} “${rule.name}”.` }
      );
    });

  const move = (rule: SimulationRule, delta: number) =>
    run(async () => {
      const ids = state.rules.map((r) => r.id);
      const res = await sim.update({ op: 'reorder', ids: moveId(ids, rule.id, delta), expectedIds: ids });
      return failure(res);
    });

  const remove = (rule: SimulationRule) => {
    setDeleting(null);
    void run(async () => {
      const res = await sim.update({ op: 'delete', id: rule.id, expectedUpdatedAt: rule.updatedAt });
      return failure(res) ?? { kind: 'info', text: `Deleted “${rule.name}”.` };
    });
  };

  // The allowlist lives in settings. It is read fresh before each change, so a
  // change made elsewhere is never overwritten.
  const changeOrigins = (change: (origins: string[]) => string[], done: (armed: boolean) => string) =>
    run(async () => {
      const settings = await loadSettings();
      await saveSettings(
        normalizeSettings({ ...settings, simulationOrigins: change(settings.simulationOrigins) }),
      );
      await sim.refresh();
      return { kind: 'info', text: done(state.armed) };
    });
  const addOrigin = (raw: string) => {
    const origin = normalizeOrigin(raw);
    if (!origin) {
      setMessage({ kind: 'error', text: `“${raw.trim()}” is not an http:// or https:// origin.` });
      return;
    }
    if (state.origins.includes(origin)) {
      setMessage({ kind: 'info', text: `${origin} is already allowlisted.` });
      return;
    }
    void changeOrigins(
      (list) => [...list.filter((o) => o !== origin), origin],
      (armed) => {
        setOriginText('');
        return `Allowlisted ${origin}. ${
          armed
            ? 'Simulation is on, so enabled rules apply while this origin is recording.'
            : 'Simulation is still off; nothing runs until you turn it on.'
        }`;
      },
    );
  };
  const removeOrigin = (origin: string) =>
    changeOrigins(
      (list) => list.filter((o) => o !== origin),
      () => `Removed ${origin}. Its open pages stopped simulating.`,
    );

  const page = state.page;
  const blockers = simulationBlockers(state);
  const active = !!page?.active;
  const delivery = simulationDeliveryText(page);
  const confirmed = active && page?.delivery === 'acknowledged';

  return (
    <div className="settings simulation">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {sim.error && <Notice kind="error">{sim.error}</Notice>}

      <section aria-labelledby="sim-status">
        <h2 id="sim-status">Simulation</h2>
        <p className="muted small">
          Mock responses, add latency or simulate failures for <strong>fetch and XHR</strong> requests of
          allowlisted development origins. Requests sent from Replay and the Request playground are never
          affected.
        </p>
        <div className="sim-switch">
          <Badge tone={confirmed ? 'warning' : active ? 'info' : 'muted'}>{delivery.badge}</Badge>
          {state.armed ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void setArmed(false)}
            >
              Turn simulation off
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void setArmed(true)}
            >
              Turn simulation on
            </button>
          )}
        </div>
        {delivery.detail && (
          <Notice
            kind={page?.delivery === 'timed-out' || page?.delivery === 'not-connected' ? 'warning' : 'info'}
          >
            {delivery.detail}
          </Notice>
        )}
        <table className="kv sim-status" aria-label="Simulation status">
          <tbody>
            <tr>
              <th>Master switch</th>
              <td>{state.armed ? 'On (until the browser restarts or the extension reloads)' : 'Off'}</td>
            </tr>
            <tr>
              <th>This tab</th>
              <td className="mono">
                {page?.origin ??
                  (page ? 'Not an http(s) page, or its address is not available' : 'No tab selected')}
              </td>
            </tr>
            <tr>
              <th>Recording</th>
              <td>
                {!page ? '—' : !page.recording ? 'Not recording' : page.paused ? 'Paused' : 'Recording'}
              </td>
            </tr>
            <tr>
              <th>Origin allowlisted</th>
              <td>{!page?.origin ? '—' : page.allowlisted ? 'Yes' : 'No'}</td>
            </tr>
            <tr>
              <th>Enabled rules</th>
              <td>
                {state.enabledRules} of {state.rules.length}
              </td>
            </tr>
          </tbody>
        </table>
        {active ? (
          <Notice kind="warning">
            Simulation is active: {state.enabledRules} enabled rule{state.enabledRules === 1 ? '' : 's'} can
            change fetch and XHR requests on <code>{page?.origin}</code>. If the page was open before
            simulation started, reload it so requests made during page load are covered too.
          </Notice>
        ) : (
          <div className="notice notice-info" role="status">
            Simulation is not running on this tab:
            <ul className="sim-blockers">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="sim-origins">
        <h2 id="sim-origins">Allowlisted origins</h2>
        <p className="muted small">
          Rules run only on these origins, and only while the tab is recording (not paused) and the switch is
          on. Adding an origin does not turn simulation on. List only development origins you control.
        </p>
        {state.origins.length ? (
          <ul className="plain sim-origins">
            {state.origins.map((o) => (
              <li key={o}>
                <code>{o}</code>{' '}
                <button
                  type="button"
                  className="btn btn-small btn-danger-ghost"
                  disabled={busy}
                  onClick={() => void removeOrigin(o)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small">No origins are allowlisted, so no page can be simulated.</p>
        )}
        <div className="sim-add-origin">
          <input
            aria-label="Origin to allowlist"
            placeholder="http://localhost:3000"
            value={originText}
            onChange={(e) => setOriginText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && originText.trim() && addOrigin(originText)}
          />
          <button
            type="button"
            className="btn"
            disabled={busy || !originText.trim()}
            onClick={() => addOrigin(originText)}
          >
            Add origin
          </button>
          {page?.origin && !page.allowlisted && (
            <button type="button" className="btn" disabled={busy} onClick={() => addOrigin(page.origin!)}>
              Add {page.origin}
            </button>
          )}
        </div>
      </section>

      <section aria-labelledby="sim-rules">
        <h2 id="sim-rules">Rules</h2>
        <p className="muted small">
          Rules are checked from top to bottom: the <strong>first enabled rule that matches</strong> a request
          decides what happens, and later rules are not checked. Use the arrows to change the order.
        </p>
        <div className="settings-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setEditing({})}>
            New rule
          </button>
        </div>
        {state.rules.length === 0 ? (
          <p className="small">No rules yet.</p>
        ) : (
          <table className="storage-table sim-rules">
            <thead>
              <tr>
                <th>#</th>
                <th>On</th>
                <th>Name</th>
                <th>Does</th>
                <th>Methods</th>
                <th>URL pattern</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.rules.map((rule, i) => (
                <tr key={rule.id} className={rule.enabled ? undefined : 'sim-rule-off'}>
                  <td>{i + 1}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={busy}
                      aria-label={`Enable ${rule.name}`}
                      onChange={() => void toggleRule(rule)}
                    />
                  </td>
                  <td className="sim-rule-name">
                    {rule.name}
                    {rule.allowSensitive && (
                      <>
                        {' '}
                        <Badge
                          tone="warning"
                          title="This rule may simulate authentication and payment endpoints"
                        >
                          auth/payment allowed
                        </Badge>
                      </>
                    )}
                  </td>
                  <td>
                    {actionLabel(rule)}
                    <div className="muted small">{whenLabel(rule.pattern)}</div>
                  </td>
                  <td>{rule.match.methods.length ? rule.match.methods.join(', ') : 'Any'}</td>
                  <td className="mono sim-rule-pattern">
                    {rule.match.urlPattern}
                    {rule.match.query === 'exact' && <div className="muted small">exact query</div>}
                  </td>
                  <td className="sim-rule-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={busy || i === 0}
                      aria-label={`Move ${rule.name} up`}
                      onClick={() => void move(rule, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={busy || i === state.rules.length - 1}
                      aria-label={`Move ${rule.name} down`}
                      onClick={() => void move(rule, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      aria-label={`Edit ${rule.name}`}
                      onClick={() => setEditing({ rule })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger-ghost"
                      disabled={busy}
                      aria-label={`Delete ${rule.name}`}
                      onClick={() => setDeleting(rule)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <RuleEditor
          rule={editing.rule}
          latest={(id) => sim.state?.rules.find((r) => r.id === id)}
          save={sim.update}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setMessage({ kind: 'info', text });
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this rule?"
          confirmLabel="Delete rule"
          danger
          onConfirm={() => remove(deleting)}
          onCancel={() => setDeleting(null)}
        >
          <p>
            “{deleting.name}” ({actionLabel(deleting)} for <code>{deleting.match.urlPattern}</code>) will be
            deleted. To stop it for now, disable it instead. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  latest,
  save,
  onClose,
  onSaved,
}: {
  rule?: SimulationRule;
  /** The newest stored copy of a rule. */
  latest: (id: string) => SimulationRule | undefined;
  save: (
    change: Parameters<ReturnType<typeof useSimulationState>['update']>[0],
  ) => Promise<SimulationUpdateResponse>;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [form, setForm] = useState<RuleForm>(() => formFromRule(rule));
  // The stored rule this edit is based on; replaced only when the user chooses to overwrite.
  const [base, setBase] = useState(rule);
  const [attempted, setAttempted] = useState(false);
  const [workerProblems, setWorkerProblems] = useState<Problems>({});
  const [failure, setFailure] = useState<SimulationChangeFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { rule: candidate, problems: formProblems } = ruleFromForm(form, base);
  const problems: Problems = attempted ? { ...workerProblems, ...formProblems } : {};
  const warnings = ruleWarnings(form);
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setWorkerProblems({});
  };

  const submit = async (asNew = false) => {
    setAttempted(true);
    setFailure(null);
    setError(null);
    if (Object.keys(formProblems).length) return;
    setBusy(true);
    try {
      const res =
        base && !asNew
          ? await save({ op: 'update', rule: candidate, expectedUpdatedAt: base.updatedAt })
          : await save({
              op: 'create',
              rule: { ...(candidate as object), id: undefined, updatedAt: undefined },
            });
      if (res.ok) {
        onSaved(base && !asNew ? `Saved “${form.name.trim() || form.urlPattern.trim()}”.` : 'Rule created.');
        return;
      }
      setFailure(res);
      setWorkerProblems(res.problems ?? {});
    } catch (err) {
      setError(workerErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  /** Bases the user's whole form on the newest stored copy, so the next save replaces it. */
  const overwrite = () => {
    const newest = base && latest(base.id);
    if (!newest) return;
    setBase(newest);
    setFailure(null);
  };

  const field = (key: keyof Problems) =>
    problems[key] ? { 'aria-invalid': true as const, 'aria-describedby': `sim-err-${key}` } : {};
  const errorFor = (key: keyof Problems) =>
    problems[key] ? (
      <span className="field-error" id={`sim-err-${key}`}>
        {problems[key]}
      </span>
    ) : null;

  return (
    <Modal title={rule ? 'Edit rule' : 'New rule'} onClose={onClose} className="modal-wide sim-editor">
      <div className="form-grid two">
        <label>
          Name
          <input
            value={form.name}
            placeholder="Orders API down"
            onChange={(e) => set('name', e.target.value)}
            {...field('name')}
          />
          {errorFor('name')}
        </label>
        <label>
          URL pattern
          <input
            className="mono"
            value={form.urlPattern}
            placeholder="localhost:3000/api/orders/:id"
            onChange={(e) => set('urlPattern', e.target.value)}
            {...field('urlPattern')}
          />
          {errorFor('urlPattern')}
          <span className="muted small">
            <code>host/path</code>, <code>http(s)://host/path</code> or <code>/path</code> (any host).{' '}
            <code>:name</code> matches one path segment, <code>*</code> matches anything. Add{' '}
            <code>?param=value</code> to require query parameters.
          </span>
        </label>
        <label>
          Methods (comma-separated; empty means any)
          <input
            value={form.methods}
            placeholder="GET, POST"
            onChange={(e) => set('methods', e.target.value)}
            {...field('methods')}
          />
          {errorFor('methods')}
        </label>
        <label>
          Query parameters
          <select value={form.query} onChange={(e) => set('query', e.target.value as RuleForm['query'])}>
            <option value="ignore">Parameters in the pattern must be present; others are allowed</option>
            <option value="exact">Exactly the parameters in the pattern</option>
          </select>
        </label>
        <label>
          What happens
          <select
            value={form.kind}
            onChange={(e) => set('kind', e.target.value as RuleForm['kind'])}
            {...field('action')}
          >
            {RULE_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          {errorFor('action')}
        </label>
        <label>
          {form.kind === 'delay' ? 'Delay (ms)' : 'Delay before the outcome (ms, 0 for none)'}
          <input
            type="number"
            min={0}
            value={form.delayMs}
            onChange={(e) => set('delayMs', e.target.value)}
            {...field('delayMs')}
          />
          {errorFor('delayMs')}
        </label>
        {form.kind === 'timeout' && (
          <label>
            Fail with a timeout after (ms)
            <input
              type="number"
              min={0}
              value={form.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value)}
              {...field('timeoutMs')}
            />
            {errorFor('timeoutMs')}
          </label>
        )}
      </div>

      {form.kind === 'mock' && (
        <fieldset className="sim-mock">
          <legend>Mocked response</legend>
          <div className="form-grid two">
            <label>
              Status
              <input
                type="number"
                min={200}
                max={599}
                value={form.status}
                onChange={(e) => set('status', e.target.value)}
                {...field('status')}
              />
              {errorFor('status')}
            </label>
            <label>
              Status text (optional)
              <input
                value={form.statusText}
                placeholder="Service Unavailable"
                onChange={(e) => set('statusText', e.target.value)}
                {...field('statusText')}
              />
              {errorFor('statusText')}
            </label>
            <label>
              Headers (one “Name: value” per line)
              <textarea
                rows={4}
                className="mono"
                value={form.headers}
                placeholder="x-request-id: mock-1"
                onChange={(e) => set('headers', e.target.value)}
                {...field('headers')}
              />
              {errorFor('headers')}
            </label>
            <label>
              Body type
              <select
                value={form.bodyKind}
                onChange={(e) => set('bodyKind', e.target.value as RuleForm['bodyKind'])}
              >
                <option value="json">JSON (Content-Type: application/json)</option>
                <option value="text">Text (Content-Type: text/plain)</option>
              </select>
              <span className="muted small">A Content-Type header above takes precedence.</span>
            </label>
          </div>
          <label>
            Body
            <textarea
              rows={6}
              className="mono"
              value={form.body}
              placeholder='{"error":"maintenance"}'
              onChange={(e) => set('body', e.target.value)}
              {...field('body')}
            />
            {errorFor('body')}
          </label>
        </fieldset>
      )}

      <div className="form-grid two">
        <label>
          When it applies
          <select
            value={form.when}
            onChange={(e) => set('when', e.target.value as RuleForm['when'])}
            {...field('pattern')}
          >
            <option value="always">Every matching request</option>
            <option value="random">A random share of matching requests</option>
            <option value="first-n">The first N matching requests, then pass through</option>
            <option value="every-nth">Every Nth matching request</option>
          </select>
          {errorFor('pattern')}
          <span className="muted small">
            Counts are kept per page load and restart when the rule is saved.
          </span>
        </label>
        {form.when === 'random' && (
          <label>
            Percent of requests
            <input
              type="number"
              min={0}
              max={100}
              value={form.percent}
              onChange={(e) => set('percent', e.target.value)}
            />
          </label>
        )}
        {form.when === 'first-n' && (
          <label>
            N (first requests)
            <input
              type="number"
              min={1}
              value={form.firstN}
              onChange={(e) => set('firstN', e.target.value)}
            />
          </label>
        )}
        {form.when === 'every-nth' && (
          <label>
            N (every Nth request)
            <input
              type="number"
              min={1}
              value={form.everyNth}
              onChange={(e) => set('everyNth', e.target.value)}
            />
          </label>
        )}
      </div>

      <label className="check">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />{' '}
        Enabled
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={form.allowSensitive}
          onChange={(e) => set('allowSensitive', e.target.checked)}
        />{' '}
        Allow this rule to simulate authentication and payment endpoints
      </label>
      <p className="muted small">
        Requests whose path has a segment such as <code>login</code>, <code>token</code>, <code>oauth</code>,{' '}
        <code>session</code>, <code>checkout</code> or <code>payment</code> are never simulated unless the
        matching rule allows it here.
      </p>

      {warnings.map((w) => (
        <Notice key={w} kind="warning">
          {w}
        </Notice>
      ))}
      {attempted && Object.keys(problems).length > 0 && !failure && (
        <Notice kind="error">Fix the highlighted fields to save this rule.</Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {failure && (
        <Notice kind={failure.reason === 'invalid' || failure.reason === 'limit' ? 'error' : 'warning'}>
          {failure.message}
          {failure.reason === 'conflict' && base && latest(base.id) && (
            <div className="settings-actions">
              <button type="button" className="btn btn-small" onClick={overwrite}>
                Overwrite with my version
              </button>
              <button type="button" className="btn btn-small" onClick={onClose}>
                Discard my changes
              </button>
            </div>
          )}
          {failure.reason === 'not-found' && (
            <div className="settings-actions">
              <button type="button" className="btn btn-small" onClick={() => void submit(true)}>
                Save as a new rule
              </button>
            </div>
          )}
        </Notice>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
        </button>
      </div>
    </Modal>
  );
}
