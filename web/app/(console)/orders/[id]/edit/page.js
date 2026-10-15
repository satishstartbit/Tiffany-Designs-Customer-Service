import { notFound } from 'next/navigation';
import { PageHeader, Problem } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import OrderEditForm from './OrderEditForm.js';

export const metadata = { title: 'Edit order' };

export default async function EditOrderPage({ params }) {
  const { id } = await params;
  const { data, error } = await loadAdmin(`orders/${encodeURIComponent(id)}/edit`);
  if (error) return <Problem message={error} />;
  if (!data) notFound();

  return (
    <>
      <PageHeader
        back={{ href: `/orders/${id}`, label: 'Back to the order' }}
        eyebrow={`Edit order #${data.orderNumber}`}
        title={data.values.erpOrderId || `#${data.orderNumber}`}
        description={`${data.customerName ? `${data.customerName}. ` : ''}Changes are saved straight to Salesforce and noted in the order's history with your name.`}
      />
      <OrderEditForm order={data} />
    </>
  );
}
