import ActivityList from '@/components/ActivityList.js';
import { Card, PageHeader, Pagination, Problem, Tabs, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';

export const metadata = { title: 'Calls & emails' };

const KINDS = [
  { key: '', label: 'Everything' },
  { key: 'call', label: 'Calls' },
  { key: 'email', label: 'Emails' },
  { key: 'todo', label: 'Open to-dos' },
];

export default async function ActivityPage({ searchParams }) {
  const params = readParams(await searchParams, ['kind', 'page']);
  const { data, error } = await loadAdmin('activities', params);

  return (
    <>
      <PageHeader
        eyebrow="Service"
        title="Calls & emails"
        description="Voice agent calls (with their outcome and length), emails sent to customers, and the team's to-dos, as logged in Salesforce."
      />
      <Tabs current={params.kind} items={KINDS.map((k) => ({ ...k, href: k.key ? `/activity?kind=${k.key}` : '/activity' }))} />
      {error ? <Problem message={error} /> : (
        <Card flush>
          <ActivityList activities={data.records} empty="Nothing logged here yet" />
          <Pagination basePath="/activity" params={params} page={data.page} hasMore={data.hasMore} shown={data.records.length} />
        </Card>
      )}
    </>
  );
}
