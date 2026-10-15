import { LifeBuoy } from 'lucide-react';
import CaseTable from '@/components/CaseTable.js';
import { Card, Empty, Filters, PageHeader, Pagination, Problem, Tabs, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';

export const metadata = { title: 'Cases' };

const FILTERS = ['q', 'state', 'status', 'type', 'origin', 'page'];

export default async function CasesPage({ searchParams }) {
  const params = readParams(await searchParams, FILTERS);
  const { data, error } = await loadAdmin('cases', params);
  const stateHref = (state) => {
    const query = new URLSearchParams(Object.entries({ ...params, state, page: '' }).filter(([, v]) => v));
    return query.toString() ? `/cases?${query}` : '/cases';
  };

  return (
    <>
      <PageHeader
        eyebrow="Service"
        title="Cases"
        description="Installation, damage, replacement and general requests from the website, email and the voice agent. Delhi NCR goes to our team; other places go to service partners."
      />
      <Tabs
        current={params.state || 'all'}
        items={[
          { key: 'all', label: 'All cases', href: stateHref('') },
          { key: 'open', label: 'Open', href: stateHref('open') },
          { key: 'closed', label: 'Closed', href: stateHref('closed') },
        ]}
      />
      {error ? <Problem message={error} /> : (
        <>
          <Filters
            action="/cases"
            search="Case number, subject, customer or city"
            params={params}
            selects={[
              { name: 'type', label: 'Request type', options: data.filters.serviceTypes },
              { name: 'status', label: 'Status', options: data.filters.statuses },
              { name: 'origin', label: 'Channel', options: data.filters.origins },
              ...(params.state ? [{ name: 'state', label: 'Open or closed', options: [['open', 'Open'], ['closed', 'Closed']], all: 'Both' }] : []),
            ]}
          />
          <Card flush>
            {data.records.length ? <CaseTable cases={data.records} /> : <Empty icon={LifeBuoy} title="No cases match">Change the filters or search for another case.</Empty>}
            <Pagination basePath="/cases" params={params} page={data.page} hasMore={data.hasMore} shown={data.records.length} />
          </Card>
        </>
      )}
    </>
  );
}
