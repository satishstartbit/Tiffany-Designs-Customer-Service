import { notFound } from 'next/navigation';
import { PageHeader, Problem } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import CustomerEditForm from './CustomerEditForm.js';

export const metadata = { title: 'Edit customer' };

export default async function EditCustomerPage({ params }) {
  const { id } = await params;
  const { data, error } = await loadAdmin(`customers/${encodeURIComponent(id)}/edit`);
  if (error) return <Problem message={error} />;
  if (!data) notFound();

  return (
    <>
      <PageHeader
        back={{ href: `/customers/${id}`, label: 'Back to the customer' }}
        eyebrow="Edit customer"
        title={data.name}
        description={`${data.accountName && data.accountName !== data.name ? `${data.accountName}. ` : ''}Changes are saved straight to Salesforce and noted in the customer's history with your name.`}
      />
      <CustomerEditForm customer={data} />
    </>
  );
}
