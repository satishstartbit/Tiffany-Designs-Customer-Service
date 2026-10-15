import Link from 'next/link';
import { ListTodo, Mail, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { Empty, Status } from './ui.js';
import { dateTime, duration } from '@/lib/format.js';

const RECORD_PATHS = { Order: '/orders', Case: '/cases', Product2: '/products' };

function iconFor(a) {
  if (a.kind === 'call') return a.direction === 'Inbound' ? PhoneIncoming : PhoneOutgoing;
  return a.kind === 'email' ? Mail : ListTodo;
}

// Calls, emails and to-dos (Salesforce tasks), newest first.
export default function ActivityList({ activities, empty = 'Nothing logged yet' }) {
  if (!activities.length) return <Empty icon={ListTodo} title={empty} />;
  return (
    <div className="list">
      {activities.map((a) => {
        const Icon = iconFor(a);
        const relatedPath = RECORD_PATHS[a.whatType];
        return (
          <div className="list-item" key={a.id}>
            <div className="item-row">
              <span className="list-icon"><Icon aria-hidden="true" /></span>
              <div className="list-item-main">
                <strong style={{ fontWeight: 500 }}>
                  {a.kind === 'call' ? `${a.direction || ''} call`.trim() : a.subject || 'Task'}
                </strong>
                <span className="cell-sub">
                  {a.whoId ? <Link href={`/customers/${a.whoId}`}>{a.whoName || 'Contact'}</Link> : null}
                  {a.whoId && a.whatId ? ' · ' : ''}
                  {a.whatId && relatedPath ? <Link href={`${relatedPath}/${a.whatId}`}>{a.whatName || a.whatType}</Link> : a.whatName}
                  {a.kind === 'call' && a.durationSeconds !== null ? ` · ${duration(a.durationSeconds)}` : ''}
                </span>
                {a.outcome && <span className="cell-sub">Outcome: {a.outcome}</span>}
                {a.description && (
                  <details className="small" style={{ marginTop: 6 }}>
                    <summary className="muted" style={{ cursor: 'pointer' }}>Details</summary>
                    <p className="description" style={{ marginTop: 6 }}>{a.description}</p>
                  </details>
                )}
              </div>
            </div>
            <div style={{ textAlign: 'right', flex: 'none' }}>
              {a.kind === 'todo' ? <Status value={a.status} /> : <span className="tag">{a.kind === 'call' ? 'Call' : 'Email'}</span>}
              <span className="cell-sub">{dateTime(a.createdDate)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
