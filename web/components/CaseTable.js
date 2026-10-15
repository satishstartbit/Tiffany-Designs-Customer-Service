import Link from 'next/link';
import { Badge, Status } from './ui.js';
import { dateTime } from '@/lib/format.js';

export default function CaseTable({ cases, showCustomer = true }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Case</th><th>Request</th>{showCustomer && <th>Customer</th>}<th>Location</th><th>Channel</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td>
                <Link className="row-link" href={`/cases/${c.id}`}>{c.caseNumber}</Link>
                <span className="cell-sub">{dateTime(c.createdDate)}</span>
              </td>
              <td>
                {c.serviceType || c.subject || '—'}
                <span className="cell-sub">{[c.subType, c.orderReference].filter(Boolean).join(' · ') || (c.serviceType && c.subject !== c.serviceType ? c.subject : '')}</span>
              </td>
              {showCustomer && (
                <td>
                  {c.contactId ? <Link href={`/customers/${c.contactId}`}>{c.contactName || 'Contact'}</Link> : c.accountName || '—'}
                </td>
              )}
              <td>
                {[c.city, c.postalCode].filter(Boolean).join(' ') || '—'}
                {c.route && <span className="cell-sub"><Badge tone={c.route === 'Internal' ? 'teal' : 'maroon'}>{c.route === 'Internal' ? 'Our team' : 'Partner'}</Badge></span>}
              </td>
              <td>{c.origin ? <span className="tag">{c.origin}</span> : '—'}</td>
              <td>
                <Status value={c.status} />
                {c.priority === 'High' && <span className="cell-sub"><Badge tone="red">High priority</Badge></span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
