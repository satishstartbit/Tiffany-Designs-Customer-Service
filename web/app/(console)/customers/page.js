import Link from 'next/link';
import { Users } from 'lucide-react';
import { Card, Empty, Filters, PageHeader, Pagination, Problem, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, initials } from '@/lib/format.js';

export const metadata = { title: 'Customers' };

export default async function CustomersPage({ searchParams }) {
  const params = readParams(await searchParams, ['q', 'page']);
  const { data, error } = await loadAdmin('customers', params);

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Customers"
        description="Salesforce contacts, newest first. Callers the voice agent did not know are added here with their name and mobile."
      />
      {error ? <Problem message={error} /> : (
        <>
          <Filters action="/customers" search="Name, mobile, email, city or account" params={params} />
          <Card flush>
            {data.records.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Customer</th><th>Mobile</th><th>Email</th><th>City</th><th>Added</th></tr></thead>
                  <tbody>
                    {data.records.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <div className="item-row" style={{ alignItems: 'center' }}>
                            <span className="avatar" aria-hidden="true" style={{ width: 30, height: 30, fontSize: 11 }}>{initials(c.name)}</span>
                            <span>
                              <Link className="row-link" href={`/customers/${c.id}`}>{c.name}</Link>
                              {c.accountName && c.accountName !== c.name && <span className="cell-sub">{c.accountName}</span>}
                            </span>
                          </div>
                        </td>
                        <td className="mono">{c.mobile || c.phone || '—'}</td>
                        <td>{c.email || '—'}</td>
                        <td>{[c.city, c.postalCode].filter(Boolean).join(' ') || '—'}</td>
                        <td>{date(c.createdDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon={Users} title="No customers match" />}
            <Pagination basePath="/customers" params={params} page={data.page} hasMore={data.hasMore} shown={data.records.length} />
          </Card>
        </>
      )}
    </>
  );
}
